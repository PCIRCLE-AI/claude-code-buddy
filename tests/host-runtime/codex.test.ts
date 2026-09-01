import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  startManagedCodexHost,
  type ManagedCodexHostConfig,
} from '../../src/host-runtime/codex.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  });
}

async function privateSocket(): Promise<{
  directory: string;
  socketPath: string;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'memesh-managed-codex-'));
  await fs.promises.chmod(directory, 0o700);
  const socketPath = `${directory}/control.sock`;
  const server = net.createServer();
  return {
    directory,
    socketPath,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await fs.promises.chmod(socketPath, 0o600);
    },
    async close() {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}

async function configFor(socketPath: string, directory: string): Promise<ManagedCodexHostConfig> {
  const tokenPath = `${directory}/router.token`;
  await fs.promises.writeFile(tokenPath, 'router-token\n', { mode: 0o600 });
  await fs.promises.chmod(tokenPath, 0o600);
  return {
    router_socket: '/private/tmp/memesh-router.sock',
    token_file: tokenPath,
    project: 'project-1',
    principal_id: 'principal-1',
    session_instance_id: 'session-exact-1',
    control_socket: socketPath,
    workspace: process.cwd(),
    codex_command: 'codex',
    model: 'gpt-5.6-sol',
    work_summary: 'implement MeMesh runtime',
  };
}

describe.skipIf(process.platform === 'win32')('managed Codex host runtime', () => {
  it('registers only after an owned app-server has created a real thread', async () => {
    const socket = await privateSocket();
    const config = await configFor(socket.socketPath, socket.directory);
    const child = new FakeChild();
    const queue = vi.fn().mockResolvedValue({
      host: 'codex-app-server', status: 'queued', thread_id: 'thread-owned-1',
      client_user_message_id: 'message-1', queued_submission_id: 'queued-1',
    });
    const createAdapter = vi.fn(() => ({ queue }));
    const routerConnection = { connection_id: 'connection-1', generation: 7, close: vi.fn(async () => {}) };
    let resolveThread: ((value: { thread_id: string }) => void) | undefined;
    const startThread = vi.fn(async () => {
      await socket.listen();
      return new Promise<{ thread_id: string }>(resolve => { resolveThread = resolve; });
    });
    let connectInput: { deliver: (delivery: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined;
    const connectRouter = vi.fn(async (input) => {
      connectInput = input;
      return routerConnection;
    });

    const spawnManagedCodex = vi.fn(() => child);
    const starting = startManagedCodexHost(config, {
      spawn: spawnManagedCodex as never,
      start_thread: startThread,
      create_adapter: createAdapter,
      connect_router_host: connectRouter as never,
    });
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(resolveThread).toBeTypeOf('function'));
    expect(connectRouter).not.toHaveBeenCalled();

    resolveThread?.({ thread_id: 'thread-owned-1' });
    const host = await starting;
    try {
      expect(host).toMatchObject({ thread_id: 'thread-owned-1', session_instance_id: 'session-exact-1' });
      expect(startThread).toHaveBeenCalledWith({
        control_socket_path: socket.socketPath,
        workspace: process.cwd(),
        timeout_ms: 1_000,
      });
      expect(connectRouter).toHaveBeenCalledWith(expect.objectContaining({
        identity: {
          project: 'project-1', principal_id: 'principal-1',
          session_instance_id: 'session-exact-1', adapter_kind: 'codex-app-server',
          model: 'gpt-5.6-sol', work_summary: 'implement MeMesh runtime',
        },
      }));

      const payload = '$(touch /private/tmp/memesh-should-not-run)';
      expect(connectInput).toBeDefined();
      const receipt = await connectInput!.deliver({
        delivery_id: 'delivery-1',
        envelope: {
          project: 'project-1', sender: 'sender-1', recipient: 'recipient-1',
          message_id: 'message-1', correlation_id: null, payload,
        },
      });
      expect(receipt).toMatchObject({ status: 'queued', thread_id: 'thread-owned-1' });
      expect(queue).toHaveBeenCalledWith(expect.objectContaining({
        control_socket_path: socket.socketPath,
        thread_id: 'thread-owned-1',
        envelope: expect.objectContaining({ payload }),
      }));
      expect(JSON.stringify(spawnManagedCodex.mock.calls)).not.toContain(payload);
      expect(spawnManagedCodex).toHaveBeenCalledWith('codex', [
        'app-server', '--listen', `unix://${socket.socketPath}`,
      ], expect.objectContaining({ shell: false }));
    } finally {
      await host.close();
      await socket.close();
    }
  });

  it('does not register and terminates the owned process when thread creation rejects', async () => {
    const socket = await privateSocket();
    const config = await configFor(socket.socketPath, socket.directory);
    const child = new FakeChild();
    const connectRouter = vi.fn();

    try {
      await expect(startManagedCodexHost(config, {
        spawn: vi.fn(() => child) as never,
        start_thread: vi.fn().mockRejectedValue(new Error('thread creation rejected')),
        connect_router_host: connectRouter as never,
      })).rejects.toThrow('thread creation rejected');
      expect(connectRouter).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      await socket.close();
    }
  });

  it('closes the exact router registration when the owned Codex process exits', async () => {
    const socket = await privateSocket();
    const config = await configFor(socket.socketPath, socket.directory);
    const child = new FakeChild();
    const routerConnection = { connection_id: 'connection-1', generation: 7, close: vi.fn(async () => {}) };
    const host = await startManagedCodexHost(config, {
      spawn: vi.fn(() => child) as never,
      start_thread: vi.fn(async () => {
        await socket.listen();
        return { thread_id: 'thread-owned-1' };
      }),
      create_adapter: vi.fn(() => ({ queue: vi.fn() })),
      connect_router_host: vi.fn().mockResolvedValue(routerConnection) as never,
    });
    try {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      await vi.waitFor(() => expect(routerConnection.close).toHaveBeenCalledTimes(1));
      await host.close();
      expect(routerConnection.close).toHaveBeenCalledTimes(1);
    } finally {
      await socket.close();
    }
  });
});

it.runIf(process.platform === 'win32')('fails closed before spawning Codex or connecting to the router', async () => {
  const config: ManagedCodexHostConfig = {
    router_socket: 'router.sock',
    token_file: 'router.token',
    project: 'project-1',
    principal_id: 'principal-1',
    control_socket: 'control.sock',
    workspace: process.cwd(),
  };
  const spawn = vi.fn();
  const startThread = vi.fn();
  const connectRouterHost = vi.fn();

  await expect(startManagedCodexHost(config, {
    spawn: spawn as never,
    start_thread: startThread as never,
    connect_router_host: connectRouterHost as never,
  })).rejects.toThrow(/secure local host runtime is not supported on Windows/i);

  expect(spawn).not.toHaveBeenCalled();
  expect(startThread).not.toHaveBeenCalled();
  expect(connectRouterHost).not.toHaveBeenCalled();
});
