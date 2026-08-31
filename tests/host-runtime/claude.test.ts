import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessagePayload } from '../../src/core/agent-messaging.js';
import {
  CLAUDE_CHANNEL_CAPABILITIES,
  type ClaudeChannelNotification,
} from '../../src/host-adapters/claude-channel.js';
import {
  startClaudeManagedSession,
  type ClaudeManagedSessionDependencies,
} from '../../src/host-runtime/claude.js';
import type {
  ConnectRouterHostInput,
  RouterDelivery,
  RouterHostConnection,
} from '../../src/host-runtime/router-client.js';

type LifecycleEvent = 'SIGINT' | 'SIGTERM' | 'end' | 'close';

class FakeLifecycle {
  private readonly listeners = new Map<LifecycleEvent, Set<() => void>>();

  addSignal(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.add(signal, listener);
  }

  removeSignal(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  addInputClose(event: 'end' | 'close', listener: () => void): void {
    this.add(event, listener);
  }

  removeInputClose(event: 'end' | 'close', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: LifecycleEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  private add(event: LifecycleEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
}

function config(sessionInstanceId?: string) {
  return {
    server_name: 'memesh-channel-test',
    router_socket: '/private/tmp/memesh-router-test.sock',
    auth_token: 'test-token',
    project: 'project-a',
    principal_id: 'claude-a',
    session_instance_id: sessionInstanceId,
  };
}

function envelope(messageId: string): AgentMessagePayload {
  return {
    message_id: messageId,
    project: 'project-a',
    sender: 'sender-a',
    sender_host: 'codex',
    recipient: 'claude-a',
    target_kind: 'principal',
    content_type: 'application/json',
    correlation_id: 'correlation-a',
    reply_to: 'parent-a',
    privacy: 'private',
    created_at: '2026-08-27T00:00:00.000Z',
    payload: { kind: 'untrusted', nested: { keep: true }, ordered: [1, 2, 3] },
    provenance: { source: 'runtime-test', preserve: 'all' },
  };
}

function delivery(messageId: string): RouterDelivery {
  return {
    attempt_id: `attempt-${messageId}`,
    delivery_id: `delivery-${messageId}`,
    connection_id: 'connection-a',
    generation: 1,
    hops: 0,
    envelope: envelope(messageId),
  };
}

function fakeConnection() {
  return {
    connection_id: 'connection-a',
    generation: 1,
    close: vi.fn(async () => undefined),
  } satisfies RouterHostConnection;
}

function fakeServer() {
  const server = {
    oninitialized: undefined as (() => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    notification: vi.fn(async (_notification: ClaudeChannelNotification): Promise<void> => undefined),
  };
  return server;
}

async function setup(overrides: ClaudeManagedSessionDependencies = {}) {
  const server = overrides.server ?? fakeServer();
  const lifecycle = overrides.lifecycle ?? new FakeLifecycle();
  const connection = fakeConnection();
  let routerInput: ConnectRouterHostInput | undefined;
  const connectRouter = overrides.connect_router ?? vi.fn(async (input: ConnectRouterHostInput) => {
    routerInput = input;
    return connection;
  });
  const session = await startClaudeManagedSession(config(), {
    server,
    transport: {} as never,
    lifecycle,
    generate_session_id: () => 'generated-session-a',
    connect_router: connectRouter,
    ...overrides,
  });
  return {
    server: server as ReturnType<typeof fakeServer>,
    lifecycle: lifecycle as FakeLifecycle,
    connection,
    connectRouter,
    session,
    routerInput: () => routerInput,
  };
}

describe.skipIf(process.platform === 'win32')('Claude managed host runtime', () => {
  it('waits for the completed MCP initialization before registering one stable generated identity', async () => {
    const generated = vi.fn(() => 'generated-session-stable');
    const server = fakeServer();
    const connection = fakeConnection();
    const connectRouter = vi.fn(async (_input: ConnectRouterHostInput) => connection);
    const session = await startClaudeManagedSession(config(), {
      server,
      transport: {} as never,
      lifecycle: new FakeLifecycle(),
      generate_session_id: generated,
      connect_router: connectRouter,
    });

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(connectRouter).not.toHaveBeenCalled();
    server.oninitialized?.();
    await expect(session.registered).resolves.toBe(connection);
    server.oninitialized?.();

    expect(generated).toHaveBeenCalledTimes(1);
    expect(session.session_instance_id).toBe('generated-session-stable');
    expect(connectRouter).toHaveBeenCalledTimes(1);
    expect(connectRouter.mock.calls[0]![0].identity).toEqual({
      project: 'project-a',
      principal_id: 'claude-a',
      session_instance_id: 'generated-session-stable',
      adapter_kind: 'claude-channel',
    });
    await session.close();
  });

  it('uses an injected session identity without generating a replacement', async () => {
    const generated = vi.fn(() => 'should-not-be-used');
    const server = fakeServer();
    let routerInput: ConnectRouterHostInput | undefined;
    const session = await startClaudeManagedSession(config('injected-session-a'), {
      server,
      transport: {} as never,
      lifecycle: new FakeLifecycle(),
      generate_session_id: generated,
      connect_router: async input => {
        routerInput = input;
        return fakeConnection();
      },
    });
    server.oninitialized?.();
    await session.registered;

    expect(generated).not.toHaveBeenCalled();
    expect(session.session_instance_id).toBe('injected-session-a');
    expect(routerInput?.identity.session_instance_id).toBe('injected-session-a');
    await session.close();
  });

  it('advertises only the one-way Channel after real MCP readiness and keeps enablement one-time', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-runtime-test', version: '1' });
    const connection = fakeConnection();
    const connectRouter = vi.fn(async (_input: ConnectRouterHostInput) => connection);
    const session = await startClaudeManagedSession(config('mcp-session-a'), {
      transport: serverTransport,
      lifecycle: new FakeLifecycle(),
      connect_router: connectRouter,
    });
    expect(connectRouter).not.toHaveBeenCalled();

    await client.connect(clientTransport);
    await session.registered;

    expect(client.getServerCapabilities()).toEqual(CLAUDE_CHANNEL_CAPABILITIES);
    expect(client.getServerCapabilities()?.experimental).not.toHaveProperty('claude/channel/permission');
    expect(client.getInstructions()).toContain('enabled once for this session');
    expect(client.getInstructions()).toContain('No tools, polling, per-message setup, permission relay');
    expect(connectRouter).toHaveBeenCalledTimes(1);
    await client.close();
    await vi.waitFor(() => expect(session.phase).toBe('closed'));
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('emits metadata-only markers and serializes concurrent delivery in FIFO order', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const server = fakeServer();
    server.notification.mockImplementationOnce(async () => { await firstHeld; });
    let routerInput: ConnectRouterHostInput | undefined;
    const connection = fakeConnection();
    const session = await startClaudeManagedSession(config('fifo-session-a'), {
      server,
      transport: {} as never,
      lifecycle: new FakeLifecycle(),
      connect_router: async input => {
        routerInput = input;
        return connection;
      },
    });
    server.oninitialized?.();
    await session.registered;

    const first = delivery('one');
    const second = delivery('two');
    const firstResult = routerInput!.deliver(first);
    const secondResult = routerInput!.deliver(second);
    await vi.waitFor(() => expect(server.notification).toHaveBeenCalledTimes(1));
    releaseFirst();
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      { host: 'claude-channel', status: 'queued' },
      { host: 'claude-channel', status: 'queued' },
    ]);

    expect(server.notification).toHaveBeenCalledTimes(2);
    const notifications = server.notification.mock.calls.map(([notification]) => notification);
    expect(notifications.map(value => value.params.meta.message_id)).toEqual(['one', 'two']);
    const marker = JSON.parse(notifications[0].params.content);
    expect(marker).toEqual({
      message_type: 'memesh_message_available',
      handling: 'Metadata only; fetch this exact scoped message before any ACK or disposition.',
      project: first.envelope.project,
      recipient: first.envelope.recipient,
      target_kind: first.envelope.target_kind,
      message_id: first.envelope.message_id,
      delivery_id: first.delivery_id,
    });
    expect(notifications[0].params.content).not.toContain(JSON.stringify(first.envelope.payload));
    expect(notifications[0].params.content).not.toContain('correlation-a');
    expect(notifications[0].params.content).not.toContain('parent-a');
    expect(notifications[0].params.content).not.toContain('sender-a');
    expect(notifications[0].method).toBe('notifications/claude/channel');
    await session.close();
  });

  it.each(['SIGINT', 'SIGTERM', 'end', 'close'] as const)(
    'unregisters and closes the Channel on %s',
    async event => {
      const context = await setup();
      context.server.oninitialized?.();
      await context.session.registered;

      context.lifecycle.emit(event);
      await vi.waitFor(() => expect(context.session.phase).toBe('closed'));

      expect(context.connection.close).toHaveBeenCalledTimes(1);
      expect(context.server.close).toHaveBeenCalledTimes(1);
    },
  );

  it('unregisters on MCP transport close without closing the already-closed server again', async () => {
    const context = await setup();
    context.server.oninitialized?.();
    await context.session.registered;

    context.server.onclose?.();
    await vi.waitFor(() => expect(context.session.phase).toBe('closed'));

    expect(context.connection.close).toHaveBeenCalledTimes(1);
    expect(context.server.close).not.toHaveBeenCalled();
  });

  it('coalesces competing close events into one unregister', async () => {
    const context = await setup();
    context.server.oninitialized?.();
    await context.session.registered;

    context.lifecycle.emit('SIGTERM');
    context.server.onclose?.();
    context.lifecycle.emit('end');
    await vi.waitFor(() => expect(context.session.phase).toBe('closed'));

    expect(context.connection.close).toHaveBeenCalledTimes(1);
    expect(context.server.close).toHaveBeenCalledTimes(1);
  });

  it('rejects delivery when the Channel closes in flight and rejects later delivery without notifying', async () => {
    let releaseNotification!: () => void;
    const notificationHeld = new Promise<void>(resolve => { releaseNotification = resolve; });
    const server = fakeServer();
    server.notification.mockImplementationOnce(async () => { await notificationHeld; });
    const context = await setup({ server });
    context.server.oninitialized?.();
    await context.session.registered;

    const inFlight = context.routerInput()!.deliver(delivery('in-flight'));
    await vi.waitFor(() => expect(server.notification).toHaveBeenCalledTimes(1));
    server.onclose?.();
    await vi.waitFor(() => expect(context.session.phase).toBe('closed'));
    releaseNotification();

    await expect(inFlight).rejects.toThrow('closed before delivery completed');
    await expect(context.routerInput()!.deliver(delivery('after-close'))).rejects
      .toThrow('session is not available');
    expect(server.notification).toHaveBeenCalledTimes(1);
  });

  it('closes a router connection that completes after EOF fenced the session', async () => {
    let resolveConnection!: (connection: RouterHostConnection) => void;
    const connecting = new Promise<RouterHostConnection>(resolve => { resolveConnection = resolve; });
    const context = await setup({ connect_router: async () => connecting });
    context.server.oninitialized?.();
    expect(context.session.phase).toBe('registering');

    context.lifecycle.emit('end');
    await expect(context.session.registered).rejects.toThrow('closed before router registration');
    const lateConnection = fakeConnection();
    resolveConnection(lateConnection);
    await vi.waitFor(() => expect(lateConnection.close).toHaveBeenCalledTimes(1));

    expect(context.session.phase).toBe('closed');
  });

  it('fails closed when router registration fails', async () => {
    const server = fakeServer();
    const fatal = vi.fn();
    const session = await startClaudeManagedSession(config(), {
      server,
      transport: {} as never,
      lifecycle: new FakeLifecycle(),
      connect_router: async () => { throw new Error('router unavailable'); },
      on_fatal_error: fatal,
    });
    server.oninitialized?.();

    await expect(session.registered).rejects.toThrow('router unavailable');
    await vi.waitFor(() => expect(session.phase).toBe('closed'));
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});

it.runIf(process.platform === 'win32')('fails closed before connecting or starting the Claude server', async () => {
  const server = fakeServer();
  const connectRouter = vi.fn();

  await expect(startClaudeManagedSession(config(), {
    server,
    transport: {} as never,
    lifecycle: new FakeLifecycle(),
    connect_router: connectRouter as never,
  })).rejects.toThrow(/secure local host runtime is not supported on Windows/i);

  expect(server.connect).not.toHaveBeenCalled();
  expect(server.close).not.toHaveBeenCalled();
  expect(connectRouter).not.toHaveBeenCalled();
});
