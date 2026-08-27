import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CHANNEL_CAPABILITIES,
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  createClaudeChannelAdapter,
  createClaudeChannelServer,
  sanitizeClaudeChannelMeta,
  type ClaudeChannelDelivery,
  type ClaudeChannelRouterSocket,
} from '../../src/host-adapters/claude-channel.js';

const identity = {
  principal: 'agent_memesh',
  sessionInstance: 'claude_spawn_42',
  generation: 'gen_7',
  workspace: 'workspace_alpha',
};

class FakeSocket extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function delivery(overrides: Partial<ClaudeChannelDelivery> = {}): ClaudeChannelDelivery {
  return {
    type: 'deliver',
    sender: 'router_memesh',
    target: identity,
    content: 'untrusted text only',
    meta: { sender_id: 'sender_1', message_id: 'message_1' },
    ...overrides,
  };
}

function setup() {
  const socket = new FakeSocket();
  const notification = vi.fn(async (_event: {
    method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
    params: { content: string; meta: Record<string, string> };
  }) => undefined);
  const adapter = createClaudeChannelAdapter({
    routerSocketPath: '/private/tmp/memesh-router.sock',
    trustedRouterPrincipal: 'router_memesh',
    identity,
    notifier: { notification },
    connector: { connect: vi.fn(async () => socket as unknown as ClaudeChannelRouterSocket) },
  });
  return { adapter, notification, socket };
}

describe('Claude Code Channels adapter', () => {
  it('declares only the official one-way channel capability during MCP initialization', async () => {
    expect(CLAUDE_CHANNEL_CAPABILITIES).toEqual({ experimental: { 'claude/channel': {} } });
    expect(CLAUDE_CHANNEL_CAPABILITIES.experimental).not.toHaveProperty('claude/channel/permission');

    const server = createClaudeChannelServer({ name: 'memesh-claude-channel', version: '0.0.0-test' }, 'One-way messages only.');
    const client = new Client({ name: 'claude-channel-contract-test', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()).toEqual(CLAUDE_CHANNEL_CAPABILITIES);
    await Promise.all([client.close(), server.close()]);
  });

  it('registers a stable principal plus session instance, generation, and workspace before accepting delivery', async () => {
    const { adapter, notification, socket } = setup();
    expect(await adapter.acceptRouterFrame(delivery())).toBe(false);

    await adapter.connect();
    expect(adapter.active).toBe(true);
    expect(JSON.parse(socket.writes[0]!)).toEqual({
      type: 'register',
      protocol: 'memesh.local-router/v1',
      adapter: 'claude-channel',
      identity,
    });

    await expect(adapter.acceptRouterFrame(delivery())).resolves.toBe(true);
    expect(notification).toHaveBeenCalledWith({
      method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
      params: {
        content: 'untrusted text only',
        meta: { sender_id: 'sender_1', message_id: 'message_1' },
      },
    });
  });

  it('removes invalid channel meta instead of coercing it', async () => {
    expect(sanitizeClaudeChannelMeta({
      valid_key: 'kept',
      'not-valid': 'dropped',
      number: 7,
      nested: { value: 'no' },
    })).toEqual({ valid_key: 'kept' });

    const { adapter, notification } = setup();
    await adapter.connect();
    await adapter.acceptRouterFrame(delivery({ meta: { valid_key: 'kept', 'bad-key': 'dropped', n: 1 } }));
    expect(notification).toHaveBeenLastCalledWith(expect.objectContaining({
      params: expect.objectContaining({ meta: { valid_key: 'kept' } }),
    }));
  });

  it('does not declare or relay permission notifications', async () => {
    const { adapter, notification } = setup();
    await adapter.connect();
    expect(await adapter.acceptRouterFrame({
      type: 'permission_request',
      sender: 'router_memesh',
      target: identity,
      content: 'approve shell command',
    })).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it('rejects disconnected and stale-generation delivery without rerouting it', async () => {
    const { adapter, notification, socket } = setup();
    await adapter.connect();
    socket.emit('close');
    expect(adapter.active).toBe(false);
    expect(await adapter.acceptRouterFrame(delivery())).toBe(false);

    const next = setup();
    await next.adapter.connect();
    expect(await next.adapter.acceptRouterFrame(delivery({
      target: { ...identity, generation: 'gen_6' },
    }))).toBe(false);
    expect(notification).not.toHaveBeenCalled();
    expect(next.notification).not.toHaveBeenCalled();
  });

  it('fails closed for an untrusted sender or wrong workspace', async () => {
    const { adapter, notification } = setup();
    await adapter.connect();
    expect(await adapter.acceptRouterFrame(delivery({ sender: 'other_sender' }))).toBe(false);
    expect(await adapter.acceptRouterFrame(delivery({
      target: { ...identity, workspace: 'workspace_other' },
    }))).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it('queues bounded validated messages while Claude is busy and flushes FIFO once it is idle', async () => {
    const { adapter, notification } = setup();
    await adapter.connect();
    await adapter.setBusy(true);
    await adapter.acceptRouterFrame(delivery({ content: 'first' }));
    await adapter.acceptRouterFrame(delivery({ content: 'second' }));
    expect(notification).not.toHaveBeenCalled();

    await adapter.setBusy(false);
    expect(notification.mock.calls.map(([event]) => event.params.content)).toEqual(['first', 'second']);
  });

  it('bounds router frames and content before any notification is emitted', async () => {
    const { adapter, notification, socket } = setup();
    await adapter.connect();
    expect(await adapter.acceptRouterFrame(delivery({ content: 'x'.repeat(16 * 1024 + 1) }))).toBe(false);
    socket.emit('data', Buffer.alloc(64 * 1024 + 1, 0x61));
    expect(socket.destroyed).toBe(true);
    expect(adapter.active).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });

  it('never puts notification content in logs or process argv', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/host-adapters/claude-channel.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\bconsole\.|process\.(?:argv|stdout|stderr)/);
  });
});
