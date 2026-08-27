import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { sendAgentMessage } from '../../src/core/agent-messaging.js';
import { AgentRouter, createAgentRouterNotifier } from '../../src/core/agent-router.js';
import {
  connectRouterHost,
  type RouterDelivery,
  type RouterHostConnection,
} from '../../src/host-runtime/router-client.js';

let router: AgentRouter | undefined;
let connection: RouterHostConnection | undefined;
let tempDir: string | undefined;
let fixtureChild: ChildProcess | undefined;

afterEach(async () => {
  fixtureChild?.kill('SIGKILL');
  fixtureChild = undefined;
  await connection?.close();
  await router?.stop();
  connection = undefined;
  router = undefined;
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function leaveOrphanedSocket(socketPath: string): Promise<void> {
  const fixture = fileURLToPath(new URL('../fixtures/router-stale-uds.mjs', import.meta.url));
  fixtureChild = spawn(process.execPath, [fixture, socketPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = fixtureChild;
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
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  fixtureChild = undefined;
}

describe('production router host client', () => {
  it('uses the unified correlated protocol and invokes a delivery only once for duplicate notify hints', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-client-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    router = new AgentRouter({
      db,
      socket_path: socketPath,
      adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
    });
    await router.start();

    const delivered = vi.fn(async (_delivery: RouterDelivery) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { host: 'fixture', status: 'queued' };
    });
    connection = await connectRouterHost({
      socket_path: socketPath,
      auth_token: 'token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
      },
      deliver: delivered,
    });
    const sent = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'one', payload: { text: 'untrusted' }, content_type: 'application/json',
    });
    const hint = {
      project: sent.project,
      delivery_id: sent.delivery_id,
      event_id: sent.event_id,
      target_kind: sent.target_kind,
      target_id: sent.recipient,
    };
    const notifier = createAgentRouterNotifier(socketPath);
    await Promise.all([notifier.notify(hint), notifier.notify(hint)]);

    expect(delivered).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id = ?',
    ).get(sent.delivery_id)).toEqual({ count: 1 }));
    expect(delivered.mock.calls[0][0]).toMatchObject({
      delivery_id: sent.delivery_id,
      connection_id: connection?.connection_id,
      generation: connection?.generation,
    });
  });

  it('starts an absent router through the injected packaged-entrypoint seam', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-client-start-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    const startRouter = vi.fn(async () => {
      if (router) return;
      const candidate = new AgentRouter({
        db,
        socket_path: socketPath,
        adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
      });
      await candidate.start();
      router = candidate;
    });

    connection = await connectRouterHost({
      socket_path: socketPath,
      auth_token: 'token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
      },
      deliver: async () => ({ host: 'fixture', status: 'queued' }),
      resilience: {
        initial_retry_ms: 10,
        max_retry_ms: 20,
        retry_jitter: 0,
        initial_attempts: 10,
        start_router: startRouter,
      },
    });

    expect(startRouter).toHaveBeenCalledTimes(1);
    expect(connection.generation).toBe(1);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
  });

  it('starts a router on ECONNREFUSED and lets it recover the orphaned UDS', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-client-stale-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    await leaveOrphanedSocket(socketPath);
    const staleIdentity = fs.lstatSync(socketPath);
    const startRouter = vi.fn(async () => {
      if (router) return;
      const candidate = new AgentRouter({
        db,
        socket_path: socketPath,
        adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
      });
      await candidate.start();
      router = candidate;
    });

    connection = await connectRouterHost({
      socket_path: socketPath,
      auth_token: 'token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
      },
      deliver: async () => ({ host: 'fixture', status: 'queued' }),
      resilience: {
        initial_retry_ms: 10,
        max_retry_ms: 20,
        retry_jitter: 0,
        initial_attempts: 10,
        start_router: startRouter,
      },
    });

    expect(startRouter).toHaveBeenCalledTimes(1);
    expect(fs.lstatSync(socketPath).ino).not.toBe(staleIdentity.ino);
    expect(connection.generation).toBe(1);
  });

  it('reconnects with a new generation, resumes heartbeats, and drains durable deliveries without duplicate host work', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-client-reconnect-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    const makeRouter = () => new AgentRouter({
      db,
      socket_path: socketPath,
      limits: { lease_ms: 120, delivery_timeout_ms: 500 },
      adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
    });
    router = makeRouter();
    await router.start();

    let releaseFirst!: () => void;
    const firstDeliveryHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const delivered = vi.fn(async (delivery: RouterDelivery) => {
      if (delivered.mock.calls.length === 1) await firstDeliveryHeld;
      return { host: 'fixture', status: 'queued', delivery_id: delivery.delivery_id };
    });
    const startRouter = vi.fn(async () => {
      if (router) return;
      const candidate = makeRouter();
      await candidate.start();
      router = candidate;
    });
    connection = await connectRouterHost({
      socket_path: socketPath,
      auth_token: 'token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
      },
      deliver: delivered,
      resilience: {
        initial_retry_ms: 20,
        max_retry_ms: 40,
        retry_jitter: 0,
        start_router: startRouter,
      },
    });
    const firstGeneration = connection.generation;
    const first = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'held-across-restart', payload: { text: 'first' }, content_type: 'application/json',
    });
    const notifyFirst = Promise.resolve(createAgentRouterNotifier(socketPath).notify({
      project: first.project,
      delivery_id: first.delivery_id,
      event_id: first.event_id,
      target_kind: first.target_kind,
      target_id: first.recipient,
    })).catch(() => undefined);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));

    await router.stop();
    router = undefined;
    const pending = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'principal-a',
      idempotency_key: 'pending-during-restart', payload: { text: 'second' }, content_type: 'application/json',
    });
    const fenced = sendAgentMessage(db, {
      project: 'project-a', sender: 'sender-a', recipient: 'another-session', target_kind: 'session',
      idempotency_key: 'exact-other-session', payload: { text: 'fenced' }, content_type: 'application/json',
    });
    releaseFirst();
    await notifyFirst;

    await vi.waitFor(() => expect(connection?.generation).toBe(firstGeneration + 1));
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
    expect(delivered.mock.calls.map(call => call[0].delivery_id)).toEqual([first.delivery_id, pending.delivery_id]);
    expect(delivered.mock.calls.flatMap(call => call[0].delivery_id)).not.toContain(fenced.delivery_id);
    await vi.waitFor(() => expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_host_accepts WHERE delivery_id IN (?, ?)',
    ).get(first.delivery_id, pending.delivery_id)).toEqual({ count: 2 }));
    const initialLease = (db.prepare(`
      SELECT lease_expires_at_ms FROM agent_session_connections
      WHERE session_instance_id = ? AND generation = ?
    `).get('session-a', connection!.generation) as { lease_expires_at_ms: number }).lease_expires_at_ms;
    await vi.waitFor(() => {
      const current = db.prepare(`
        SELECT lease_expires_at_ms FROM agent_session_connections
        WHERE session_instance_id = ? AND generation = ?
      `).get('session-a', connection!.generation) as { lease_expires_at_ms: number };
      expect(current.lease_expires_at_ms).toBeGreaterThan(initialLease);
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_presence_facts
      WHERE session_instance_id = ? AND generation = ? AND presence_kind = 'heartbeat'
    `).get('session-a', connection!.generation)).toEqual({ count: 0 });
    expect(startRouter).toHaveBeenCalled();
  });

  it('uses delayed capped retries and close cancels the pending reconnect loop', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-client-close-'));
    fs.chmodSync(tempDir, 0o700);
    const socketPath = path.join(tempDir, 'router.sock');
    const db = openDatabase(path.join(tempDir, 'messages.db'));
    router = new AgentRouter({
      db,
      socket_path: socketPath,
      adapters: [{ kind: 'codex-app-server', authenticate: value => value.auth_token === 'token' }],
    });
    await router.start();
    const attemptTimes: number[] = [];
    const startRouter = vi.fn(() => { attemptTimes.push(Date.now()); });
    connection = await connectRouterHost({
      socket_path: socketPath,
      auth_token: 'token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: 'session-a', adapter_kind: 'codex-app-server',
      },
      deliver: async () => ({ host: 'fixture', status: 'queued' }),
      resilience: {
        initial_retry_ms: 20,
        max_retry_ms: 40,
        retry_jitter: 0,
        start_router: startRouter,
      },
    });

    await router.stop();
    router = undefined;
    await vi.waitFor(() => expect(startRouter.mock.calls.length).toBeGreaterThanOrEqual(2), {
      interval: 5,
      timeout: 500,
    });
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(30);
    await connection.close();
    const attemptsAtClose = startRouter.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(startRouter).toHaveBeenCalledTimes(attemptsAtClose);
  });
});
