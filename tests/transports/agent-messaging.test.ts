import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-agent-message-transport-');

const originalRouterSocket = process.env.MEMESH_ROUTER_SOCKET;
const originalStorageQuota = process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;

afterEach(() => {
  if (originalRouterSocket === undefined) delete process.env.MEMESH_ROUTER_SOCKET;
  else process.env.MEMESH_ROUTER_SOCKET = originalRouterSocket;
  if (originalStorageQuota === undefined) delete process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES;
  else process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = originalStorageQuota;
});

describe('agent message transport', () => {
  it('commits a durable send when the optional router hint path is unusable', async () => {
    process.env.MEMESH_ROUTER_SOCKET = `/${'nested/'.repeat(20)}agent-router.sock`;

    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-smoke',
      sender: 'sender',
      recipient: 'recipient',
      idempotency_key: 'overlong-router-path',
      payload: { text: 'still durable' },
      content_type: 'application/json',
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    }) as { message_id: string; target_kind: string };

    expect(sent.message_id).toEqual(expect.any(String));
    expect(sent.target_kind).toBe('principal');
    expect(
      getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_messages').get(),
    ).toEqual({ count: 1 });
  });

  it('passes an exact-session target through the public send schema to durable core state', async () => {
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-session',
      sender: 'sender',
      recipient: 'session-instance-7',
      target_kind: 'session',
      idempotency_key: 'exact-session-ingress',
      payload: 'review this model feedback',
    }, {
      transport: 'http',
      sourceHost: 'test-host',
    }) as { message_id: string; target_kind: string };

    expect(sent.target_kind).toBe('session');
    expect(getDatabase().prepare(`
      SELECT recipient, target_kind
      FROM agent_message_deliveries
      WHERE message_id = ?
    `).get(sent.message_id)).toEqual({
      recipient: 'session-instance-7',
      target_kind: 'session',
    });
  });

  it('rejects target kinds outside the public principal-or-session contract', async () => {
    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-session',
      sender: 'sender',
      recipient: 'session-instance-7',
      target_kind: 'replacement-session',
      idempotency_key: 'invalid-target-kind',
      payload: 'must not persist',
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    })).rejects.toThrow(/target_kind/);

    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_messages').get())
      .toEqual({ count: 0 });
  });

  it('applies the configured hard quota inside the canonical send transaction', async () => {
    process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = '0';

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-quota',
      sender: 'sender',
      recipient: 'recipient',
      idempotency_key: 'quota-rejected',
      payload: 'one byte too many',
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    })).rejects.toMatchObject({ code: 'storage_quota_exceeded' });

    for (const table of [
      'agent_messages', 'agent_message_deliveries', 'agent_message_events',
      'agent_message_idempotency', 'agent_dispatch_attempts', 'agent_message_receipts',
    ]) {
      expect(getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it('fails closed on an invalid configured quota before writing message effects', async () => {
    process.env.MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES = 'unbounded';

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-quota',
      sender: 'sender',
      recipient: 'recipient',
      idempotency_key: 'quota-invalid',
      payload: 'must not persist',
    }, {
      transport: 'cli',
      sourceHost: 'test-host',
    })).rejects.toThrow('MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES must be a non-negative integer byte count.');

    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual({ count: 0 });
  });
});
