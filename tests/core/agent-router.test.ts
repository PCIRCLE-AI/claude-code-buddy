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
  type AgentHostAdapter,
  type AgentHostDispatchInput,
  type AgentHostDispatchResult,
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
  adapters?: AgentHostAdapter[],
) {
  const router = new AgentRouter({
    db,
    socket_path: socketPath,
    limits: { delivery_timeout_ms: 200, ...limits },
    adapters: adapters ?? [{
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
    adapterKind?: string;
    model?: string | null;
    workSummary?: string | null;
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
      adapter_kind: input.adapterKind ?? 'test-host',
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.workSummary === undefined ? {} : { work_summary: input.workSummary }),
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

describe.runIf(process.platform !== 'win32').sequential('AgentRouter real SQLite + UDS integration', () => {
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

  it('rejects a nominally successful response with a partial result object', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-partial-response-'));
    fs.chmodSync(dir, 0o700);
    tempDirs.push(dir);
    const socketPath = path.join(dir, 'router.sock');
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim()) as Frame;
        socket.write(`${JSON.stringify({
          version: 1,
          request_id: request.request_id,
          ok: true,
          result: {},
        })}\n`);
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

  it('rejects a discovery response that escapes the requested project scope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-discovery-scope-'));
    fs.chmodSync(dir, 0o700);
    tempDirs.push(dir);
    const socketPath = path.join(dir, 'router.sock');
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim()) as Frame;
        socket.write(`${JSON.stringify({
          version: 1,
          request_id: request.request_id,
          ok: true,
          result: {
            cards: [{
              session_id: 'foreign-session', principal_id: 'foreign-principal',
              host_kind: 'claude', project: 'project-b', model: null,
              work_summary: null, active: true, generation: 1,
              lease_expires_at_ms: Date.now() + 60_000,
            }],
          },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(sendAgentRouterRequest(socketPath, {
        version: 1, type: 'discover', request_id: randomUUID(),
        project: 'project-a', limit: 10, hops: 0,
      })).rejects.toMatchObject({ code: 'invalid_response' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('recovers one orphaned stale UDS under concurrent startup without stealing the winner', async () => {
    const { db, socketPath, token } = setup();
    await leaveOrphanedSocket(socketPath);
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

    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    const host = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    expect(host.generation).toBe(1);
  });

  it('recovers a startup lock left by a process that no longer exists', async () => {
    const { db, socketPath, token } = setup();
    fs.writeFileSync(`${socketPath}.startup.lock`, '2147483647\n', { mode: 0o600 });

    const router = await startRouter(db, socketPath, token);

    expect(fs.existsSync(`${socketPath}.startup.lock`)).toBe(false);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    expect(router).toBeDefined();
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

  it('sends the full untrusted envelope to one native adapter with a live companion socket', async () => {
    const { db, socketPath, token } = setup();
    const nativeDispatch = vi.fn<(
      input: AgentHostDispatchInput,
    ) => Promise<AgentHostDispatchResult>>(async () => ({
      accepted: true,
      receipt: { host: 'codex-cli', status: 'queued' },
    }));
    await startRouter(db, socketPath, token, {}, [{
      kind: 'codex-cli-queue',
      authenticate: registration => registration.auth_token === token,
      dispatch: nativeDispatch,
    }]);
    const companion = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a',
      session: '01a041b4-5c67-75b3-9505-4e33d7942b8e', adapterKind: 'codex-cli-queue',
    });
    const message = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'full-message-native',
      payload: { sentinel: 'payload-must-cross-adapter-api' },
      content_type: 'application/json',
    }, { notifier: createAgentRouterNotifier(socketPath) });

    await vi.waitFor(() => expect(nativeDispatch).toHaveBeenCalledTimes(1));
    expect(nativeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      session_instance_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
      untrusted_payload: true,
      envelope: expect.objectContaining({
        project: 'project-a', recipient: 'principal-a', target_kind: 'principal',
        message_id: message.message_id,
        payload: { sentinel: 'payload-must-cross-adapter-api' },
      }),
    }));
    const adapterInput = nativeDispatch.mock.calls[0][0];
    expect(JSON.stringify(adapterInput)).toContain('payload-must-cross-adapter-api');
    expect(companion.deliveries).toHaveLength(0);
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ count: 1 }));
  });

  it('does not record native acceptance when the live companion disappears during queue admission', async () => {
    const { db, socketPath, token } = setup();
    const companionRef: { current?: RouterHostClient } = {};
    const nativeDispatch = vi.fn(async (): Promise<AgentHostDispatchResult> => {
      companionRef.current?.close();
      await new Promise(resolve => setTimeout(resolve, 10));
      return { accepted: true, receipt: { host: 'codex-cli', status: 'queued' } };
    });
    await startRouter(db, socketPath, token, {}, [{
      kind: 'codex-cli-queue',
      authenticate: registration => registration.auth_token === token,
      dispatch: nativeDispatch,
    }]);
    companionRef.current = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a',
      session: '01a041b4-5c67-75b3-9505-4e33d7942b8e', adapterKind: 'codex-cli-queue',
    });
    const message = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'metadata-companion-race', payload: 'durable payload',
      content_type: 'text/plain',
    }, { notifier: createAgentRouterNotifier(socketPath) });

    await vi.waitFor(() => expect(nativeDispatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(db.prepare(
      'SELECT result FROM agent_dispatch_attempts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ result: 'stale_generation' }));
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ count: 0 });
  });

  it('persists a bounded native rejection reason without creating host acceptance', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, {}, [{
      kind: 'codex-cli-queue',
      authenticate: registration => registration.auth_token === token,
      dispatch: async () => ({
        accepted: false,
        receipt: { failure_code: 'thread_unavailable' },
      }),
    }]);
    await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a',
      session: '01a041b4-5c67-75b3-9505-4e33d7942b8e', adapterKind: 'codex-cli-queue',
    });
    const message = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'metadata-native-rejection', payload: 'durable payload',
      content_type: 'text/plain',
    }, { notifier: createAgentRouterNotifier(socketPath) });

    await vi.waitFor(() => expect(db.prepare(
      'SELECT result, failure_code FROM agent_dispatch_attempts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ result: 'adapter_rejected', failure_code: 'thread_unavailable' }));
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(message.delivery_id)).toEqual({ count: 0 });
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

  it('never reroutes or later replays an exact-session delivery and drains principal pending after router restart', async () => {
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
    const resumedExactSession = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-old',
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(resumedExactSession.deliveries).toHaveLength(0);
  });

  it('drains every bounded backlog batch once even when one delivery is rejected', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, { drain_limit: 2 });
    const first = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-first',
    });
    first.close();
    await vi.waitFor(() => expect(db.prepare(
      `SELECT disconnected_at FROM agent_session_connections WHERE connection_id = ?`,
    ).get(first.connectionId)).toMatchObject({ disconnected_at: expect.any(String) }));

    const pending = Array.from({ length: 5 }, (_, index) => send(
      db, 'principal-a', `bounded-backlog-${index}`,
    ));
    const rejectedId = pending[0].delivery_id;
    const replacement = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-replacement',
      onDelivery: (frame, client) => {
        if (frame.delivery_id === rejectedId) client.reject(frame);
        else client.accept(frame);
      },
    });

    await vi.waitFor(() => expect(replacement.deliveries).toHaveLength(5));
    expect(replacement.deliveries.map(frame => frame.delivery_id)).toEqual(
      pending.map(message => message.delivery_id),
    );
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_dispatch_attempts WHERE delivery_id = ?',
    ).get(rejectedId)).toEqual({ count: 1 }));
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id != ?',
    ).get(rejectedId)).toEqual({ count: 4 }));
  });

  it('keeps the current in-flight owner when a same-delivery dispatch re-enters', async () => {
    const { db, socketPath } = setup();
    const router = new AgentRouter({ db, socket_path: socketPath, adapters: [] });
    routers.push(router);
    const internal = router as unknown as {
      dispatchDelivery(deliveryId: string, project: string, hops: number): Promise<boolean>;
      dispatchDeliveryOnce(deliveryId: string, project: string, hops: number): Promise<boolean>;
      inFlightDeliveries: Map<string, { operation: Promise<boolean> }>;
    };
    let calls = 0;
    let resolveOuter!: (value: boolean) => void;
    let resolveNested!: (value: boolean) => void;
    const outerOperation = new Promise<boolean>(resolve => { resolveOuter = resolve; });
    const nestedOperation = new Promise<boolean>(resolve => { resolveNested = resolve; });
    let nestedCaller!: Promise<boolean>;

    internal.dispatchDeliveryOnce = () => {
      calls += 1;
      if (calls === 1) {
        nestedCaller = internal.dispatchDelivery('delivery-1', 'project-1', 0);
        return outerOperation;
      }
      if (calls === 2) return nestedOperation;
      return Promise.resolve(true);
    };

    const outerCaller = internal.dispatchDelivery('delivery-1', 'project-1', 0);
    expect(internal.inFlightDeliveries.get('delivery-1')?.operation).toBe(outerOperation);

    resolveNested(true);
    await nestedCaller;
    expect(internal.inFlightDeliveries.get('delivery-1')?.operation).toBe(outerOperation);

    const thirdCaller = internal.dispatchDelivery('delivery-1', 'project-1', 0);
    expect(calls).toBe(2);
    resolveOuter(true);
    await expect(Promise.all([outerCaller, thirdCaller])).resolves.toEqual([true, true]);
    expect(internal.inFlightDeliveries.has('delivery-1')).toBe(false);
  });

  it('discovers only live registrations in the requested project with declared metadata', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, { lease_ms: 250 });
    await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-codex', session: 'session-codex',
      model: 'gpt-5.6-luna', workSummary: 'review router contract',
    });
    await RouterHostClient.connect({
      socketPath, token, project: 'project-b', principal: 'principal-other', session: 'session-other',
      model: 'other-model', workSummary: 'other work',
    });
    const before = {
      messages: db.prepare('SELECT COUNT(*) AS count FROM agent_messages').get(),
      receipts: db.prepare('SELECT COUNT(*) AS count FROM agent_message_receipts').get(),
      attempts: db.prepare('SELECT COUNT(*) AS count FROM agent_dispatch_attempts').get(),
      accepts: db.prepare('SELECT COUNT(*) AS count FROM agent_host_accepts').get(),
    };

    const result = await sendAgentRouterRequest(socketPath, {
      version: 1, type: 'discover', request_id: randomUUID(), project: 'project-a', limit: 10, hops: 0,
    });
    expect(result.cards).toEqual([expect.objectContaining({
      session_id: 'session-codex',
      principal_id: 'principal-codex', host_kind: 'other', project: 'project-a',
      model: 'gpt-5.6-luna', work_summary: 'review router contract', active: true,
      generation: 1, lease_expires_at_ms: expect.any(Number),
    })]);
    expect((result.cards as unknown[]).some(card => (card as Frame).session_id === 'session-other')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual(before.messages);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_message_receipts').get()).toEqual(before.receipts);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_dispatch_attempts').get()).toEqual(before.attempts);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_host_accepts').get()).toEqual(before.accepts);
  });

  it('maps supported adapter identities to stable host kinds', async () => {
    const { db, socketPath, token } = setup();
    const adapterKinds = ['codex-cli-queue', 'codex-app-server', 'claude-channel', 'acp'];
    await startRouter(db, socketPath, token, {}, adapterKinds.map(kind => ({
      kind,
      authenticate: (registration: AgentHostRegistration) => registration.auth_token === token,
    })));
    for (const adapterKind of adapterKinds) {
      await RouterHostClient.connect({
        socketPath, token, project: 'project-a', principal: `principal-${adapterKind}`,
        session: `session-${adapterKind}`, adapterKind,
      });
    }

    const result = await sendAgentRouterRequest(socketPath, {
      version: 1, type: 'discover', request_id: randomUUID(), project: 'project-a', limit: 10, hops: 0,
    });
    expect((result.cards as Frame[]).map(card => [card.session_id, card.host_kind])).toEqual([
      ['session-codex-cli-queue', 'codex'],
      ['session-codex-app-server', 'codex'],
      ['session-claude-channel', 'claude'],
      ['session-acp', 'gemini'],
    ]);
  });

  it('does not infer missing metadata and heartbeat refreshes the authoritative lease', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, { lease_ms: 120 });
    const host = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-a', session: 'session-a',
    });
    const discover = () => sendAgentRouterRequest(socketPath, {
      version: 1, type: 'discover', request_id: randomUUID(), project: 'project-a', limit: 10, hops: 0,
    });
    const initial = await discover();
    expect(initial.cards).toEqual([expect.objectContaining({
      session_id: 'session-a', principal_id: 'principal-a', host_kind: 'other', project: 'project-a',
      model: null, work_summary: null, active: true, generation: host.generation,
    })]);
    const initialLease = (initial.cards as Frame[])[0].lease_expires_at_ms as number;
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(sendAgentRouterRequest(socketPath, {
      version: 1, type: 'heartbeat', request_id: randomUUID(), project: 'project-a',
      session_instance_id: 'session-a', connection_id: host.connectionId, generation: host.generation, hops: 0,
    })).resolves.toMatchObject({ generation: host.generation, lease_ms: 120 });
    const refreshed = await discover();
    expect((refreshed.cards as Frame[])[0].lease_expires_at_ms).toBeGreaterThan(initialLease);
  });

  it('excludes disconnected, superseded, and expired registrations from discovery', async () => {
    const { db, socketPath, token } = setup();
    await startRouter(db, socketPath, token, { lease_ms: 10_000 });
    const disconnected = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-disconnected', session: 'session-disconnected',
    });
    disconnected.close();
    await vi.waitFor(() => expect(db.prepare(
      'SELECT disconnected_at FROM agent_session_connections WHERE connection_id = ?',
    ).get(disconnected.connectionId)).toMatchObject({ disconnected_at: expect.any(String) }));
    const superseded = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-superseded', session: 'session-superseded',
    });
    const replacement = await RouterHostClient.connect({
      socketPath, token, project: 'project-a', principal: 'principal-superseded', session: 'session-superseded',
    });
    const current = await sendAgentRouterRequest(socketPath, {
      version: 1, type: 'discover', request_id: randomUUID(), project: 'project-a', limit: 10, hops: 0,
    });
    expect(current.cards).toEqual([expect.objectContaining({
      session_id: 'session-superseded', generation: replacement.generation,
    })]);
    expect(replacement.generation).toBeGreaterThan(superseded.generation);
    db.prepare(
      'UPDATE agent_session_connections SET lease_expires_at_ms = ? WHERE connection_id = ?',
    ).run(Date.now() - 1, replacement.connectionId);
    const result = await sendAgentRouterRequest(socketPath, {
      version: 1, type: 'discover', request_id: randomUUID(), project: 'project-a', limit: 10, hops: 0,
    });
    const sessions = (result.cards as Frame[]).map(card => card.session_id);
    expect(sessions).not.toContain('session-superseded');
    expect(sessions).not.toContain('session-disconnected');
    expect(result.cards).toEqual([]);
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

it.runIf(process.platform === 'win32')('rejects secure router startup before creating socket state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-windows-'));
  tempDirs.push(directory);
  const db = openDatabase(path.join(directory, 'messages.db'));
  const socketPath = path.join(directory, 'nested', 'router.sock');
  const candidate = new AgentRouter({ db, socket_path: socketPath, adapters: [] });

  await expect(candidate.start()).rejects.toThrow(/secure local host runtime is not supported on Windows/i);
  expect(fs.existsSync(path.dirname(socketPath))).toBe(false);
  expect(fs.existsSync(socketPath)).toBe(false);
});
