import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CHANNEL_CAPABILITIES,
  createClaudeChannelServer,
} from '../../src/host-adapters/claude-channel.js';

describe('Claude Code channel server', () => {
  it('declares only the official one-way channel capability during MCP initialization', async () => {
    expect(CLAUDE_CHANNEL_CAPABILITIES).toEqual({ experimental: { 'claude/channel': {} } });
    expect(CLAUDE_CHANNEL_CAPABILITIES.experimental).not.toHaveProperty('claude/channel/permission');

    const server = createClaudeChannelServer(
      { name: 'memesh-claude-channel', version: '0.0.0-test' },
      'One-way messages only.',
    );
    const client = new Client({ name: 'claude-channel-contract-test', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerCapabilities()).toEqual(CLAUDE_CHANNEL_CAPABILITIES);
    await Promise.all([client.close(), server.close()]);
  });
});
