import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import {
  AgentRouter,
  AgentRouterProtocolError,
  createAgentRouterNotifier,
  sendAgentRouterRequest,
  type AgentHostRegistration,
} from '../../src/core/agent-router.js';

type Frame = Record<string, unknown>;

const routers: AgentRouter[] = [];
const clients: RouterHostClient[] = [];
const tempDirs: string[] = [];
const fixtureChildren = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of fixtureChildren) child.kill('SIGKILL');
  fixtureChildren.clear();
  for (const client of clients.splice(0)) client.close();
  for (const router of routers.splice(0)) await router.stop();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-'));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  const db = openDatabase(path.join(dir, 'messages.db'));
  const socketPath = path.join(dir, 'router.sock');
  const token = 'test-router-token';
  return { db, socketPath, token };
}

async function leaveOrphanedSocket(socketPath: string): Promise<void> {
  const fixture = fileURLToPath(new URL('../fixtures/router-stale-uds.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixture, socketPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixtureChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!ready && chunk.toString('utf8').includes('ready')) {
        ready = true;
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!ready) reject(new Error(`Stale UDS fixture exited before ready (${String(code)}).`));
    });
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  fixtureChildren.delete(child);
  expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
}

async function startRouter(
  db: ReturnType<typeof openDatabase>,
  socketPath: string,
  token: string,
  limits: ConstructorParameters<typeof AgentRouter>[0]['limits'] = {},
) {
  const router = new AgentRouter({
    db,
    socket_path: socketPath,
    limits: { delivery_timeout_ms: 200, ...limits },
    adapters: [{
      kind: 'test-host',
      authenticate(registration: AgentHostRegistration) {
        return registration.auth_token === token;
      },
    }],
  });
  await router.start();
  routers.push(router);
  return router;
}

class RouterHostClient {
  readonly deliveries: Frame[] = [];
  readonly responses: Frame[] = [];
  connectionId = '';
  generation = 0;
  private buffer = Buffer.alloc(0);

  constructor(
    readonly socket: net.Socket,
    private readonly onDelivery: (frame: Frame, client: RouterHostClient) => void,
  ) {
    socket.on('data', chunk => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  static async connect(input: {
    socketPath: string;
    token: string;
    project: string;
    principal: string;
    session: string;
    onDelivery?: (frame: Frame, client: RouterHostClient) => void;
  }): Promise<RouterHostClient> {
    const socket = net.createConnection(input.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const client = new RouterHostClient(socket, input.onDelivery ?? ((frame, active) => active.accept(frame)));
    clients.push(client);
    const requestId = randomUUID();
    client.write({
      version: 1,
      type: 'register',
      request_id: requestId,
      project: input.project,
      principal_id: input.principal,
      session_instance_id: input.session,
      adapter_kind: 'test-host',
      auth_token: input.token,
      hops: 0,
    });
    await vi.waitFor(() => {
      const response = client.responses.find(frame => frame.request_id === requestId);
      expect(response).toMatchObject({ ok: true });
      const result = response?.result as Frame;
      client.connectionId = String(result.connection_id);
      client.generation = Number(result.generation);
    });
    return client;
  }

  accept(frame: Frame): void {
    this.write({
      version: 1,
      type: 'host_accept',
      request_id: randomUUID(),
      attempt_id: frame.attempt_id,
      delivery_id: frame.delivery_id,
      connection_id: frame.connection_id,
      generation: frame.generation,
      receipt: { host: 'test-host', status: 'queued' },
      hops: frame.hops,
    });
  }

  reject(frame: Frame, failureCode = 'busy'): void {
    this.write({
      version: 1,
      type: 'host_reject',
      request_id: randomUUID(),
      attempt_id: frame.attempt_id,
      delivery_id: frame.delivery_id,
      connection_id: frame.connection_id,
      generation: frame.generation,
      failure_code: failureCode,
      hops: frame.hops,
    });
  }

  write(frame: Frame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  close(): void {
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (raw.length === 0) continue;
      const frame = JSON.parse(raw.toString('utf8')) as Frame;
      if (frame.type === 'deliver') {
        this.deliveries.push(frame);
        this.onDelivery(frame, this);
      } else {
        this.responses.push(frame);
      }
    }
  }
}

function send(db: ReturnType<typeof openDatabase>, recipient: string, key: string, target_kind: 'principal' | 'session' = 'principal') {
  return sendAgentMessage(db, {
    project: 'project-a',
    sender: 'sender-a',
    recipient,
    target_kind,
    idempotency_key: key,
    payload: { text: key },
    content_type: 'application/json',
  });
}

describe.sequential('AgentRouter real SQLite + UDS integration', () => {
  it('rejects a nominally successful response that omits its result object', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-response-'));
    fs.chmodSync(dir, 0o700);
    tempDirs.push(dir);
    const socketPath = path.join(dir, 'router.sock');
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim()) as Frame;
        socket.write(`${JSON.stringify({ version: 1, request_id: request.request_id, ok: true })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(sendAgentRouterRequest(socketPath, {
        version: 1,
        type: 'notify',
        request_id: randomUUID(),
        project: 'project-a',
        delivery_id: randomUUID(),
        hops: 0,
      })).rejects.toMatchObject({ code: 'invalid_response' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('recovers one orphaned stale UDS under concurrent startup without stealing the winner', async () => {
    const { db, socketPath, token } = setup();
    await leaveOrphanedSocket(socketPath);
    const staleIdentity = fs.lstatSync(socketPath);
    const contenders = [0, 1].map(() => new AgentRouter({
      db,
      socket_path: socketPath,
      adapters: [{ kind: 'test-host', authenticate: value => value.auth_token === token }],
    }));

    const results = await Promise.allSettled(contenders.map(candidate => candidate.start()));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
    const winner = contenders[winnerIndex];
    routers.push(winner);

    const activeIdentity = fs.lstatSync(socketPath);
    expect(activeIdentity.ino).not.toBe(staleIdentity.ino);
    const host = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    expect(host.generation).toBe(1);
  });

  it('refuses to remove or replace a socket owned by a live router', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token);
    const liveIdentity = fs.lstatSync(socketPath);
    const contender = new AgentRouter({
      db,
      socket_path: socketPath,
      adapters: [{ kind: 'test-host', authenticate: value => value.auth_token === token }],
    });

    await expect(contender.start()).rejects.toMatchObject({ code: 'router_already_running' });
    expect(fs.lstatSync(socketPath)).toMatchObject({ dev: liveIdentity.dev, ino: liveIdentity.ino });
    const host = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-live',
    });
    expect(host.generation).toBe(1);
  });

  it('authenticates and binds delivery to the exact socket/generation without replaying first-ever history', async () => {
    const { db, socketPath, token } = setup();
    const historical = send(db, 'principal-a', 'before-activation');
    await startRouter(db, socketPath, token);
    const host = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(host.deliveries).toHaveLength(0);

    const current = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'after-activation', payload: { text: 'deliver me' }, content_type: 'application/json',
    }, { notifier: createAgentRouterNotifier(socketPath) });

    await vi.waitFor(() => expect(host.deliveries).toHaveLength(1));
    expect(host.deliveries[0]).toMatchObject({
      delivery_id: current.delivery_id,
      connection_id: host.connectionId,
      generation: host.generation,
      principal_id: 'principal-a',
      session_instance_id: 'session-a',
    });
    expect(host.deliveries[0].delivery_id).not.toBe(historical.delivery_id);
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(current.delivery_id)).toEqual({ count: 1 }));
  });

  it('rejects wrong scope and stale generation while a replacement receives eligible principal pending', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token);
    const first = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    const second = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    expect(second.generation).toBe(first.generation + 1);
    const message = send(db, 'principal-a', 'replacement');
    await expect(sendAgentRouterRequest(socketPath, {
      version: 1, type: 'notify', request_id: randomUUID(), project: 'project-b',
      delivery_id: message.delivery_id, hops: 0,
    })).rejects.toBeInstanceOf(AgentRouterProtocolError);
    await createAgentRouterNotifier(socketPath).notify({
      project: 'project-a', delivery_id: message.delivery_id, event_id: message.event_id,
      target_kind: 'principal', target_id: 'principal-a',
    });
    await vi.waitFor(() => expect(second.deliveries).toHaveLength(1));
    expect(first.deliveries).toHaveLength(0);
  });

  it('never reroutes an exact-session delivery and drains principal pending after router restart', async () => {
    const { db, socketPath, token } = setup();
    const firstRouter = await startRouter(db, socketPath, token);
    const old = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-old',
    });
    old.close();
    await vi.waitFor(() => expect(db.prepare(
      `SELECT disconnected_at FROM agent_session_connections WHERE connection_id = ?`,
    ).get(old.connectionId)).toMatchObject({ disconnected_at: expect.any(String) }));
    const exact = send(db, 'session-old', 'exact-old', 'session');
    const pending = send(db, 'principal-a', 'principal-pending');
    await firstRouter.stop();
    routers.splice(routers.indexOf(firstRouter), 1);

    await startRouter(db, socketPath, token);
    const replacement = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-new',
    });
    await vi.waitFor(() => expect(replacement.deliveries).toHaveLength(1));
    expect(replacement.deliveries[0].delivery_id).toBe(pending.delivery_id);
    expect(replacement.deliveries[0].delivery_id).not.toBe(exact.delivery_id);
  });

  it('retries after an adapter crash, dedupes host acceptance, and enforces hop/frame bounds', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, {
      max_hops: 2,
      max_frame_bytes: 1024,
      max_frames_per_window: 2,
    });
    await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-crash',
      onDelivery: (_frame, client) => client.close(),
    });
    const message = send(db, 'principal-a', 'crash-retry');
    await createAgentRouterNotifier(socketPath).notify({
      project: 'project-a', delivery_id: message.delivery_id, event_id: message.event_id,
      target_kind: 'principal', target_id: 'principal-a',
    });
    const replacement = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-replacement',
    });
    await vi.waitFor(() => expect(replacement.deliveries).toHaveLength(1));
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ count: 1 }));
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_dispatch_attempts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ count: 2 });

    await expect(sendAgentRouterRequest(socketPath, {
      version: 1, type: 'notify', request_id: randomUUID(), project: 'project-a',
      delivery_id: message.delivery_id, hops: 2,
    })).rejects.toMatchObject({ code: 'hop_limit' });

    const oversized = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      oversized.once('connect', resolve);
      oversized.once('error', reject);
    });
    oversized.write(`${JSON.stringify({ payload: 'x'.repeat(2048) })}\n`);
    const response = await new Promise<string>(resolve => oversized.once('data', chunk => resolve(String(chunk))));
    expect(response).toContain('frame_too_large');
    oversized.destroy();

    const rateLimited = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      rateLimited.once('connect', resolve);
      rateLimited.once('error', reject);
    });
    rateLimited.write('{}\n{}\n{}\n');
    let rateResponse = '';
    rateLimited.on('data', chunk => { rateResponse += String(chunk); });
    await vi.waitFor(() => expect(rateResponse).toContain('rate_limited'));
    rateLimited.destroy();
  });
});
