import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-agent-message-transport-');

const originalRouterSocket = process.env.MEMESH_ROUTER_SOCKET;

afterEach(() => {
  if (originalRouterSocket === undefined) delete process.env.MEMESH_ROUTER_SOCKET;
  else process.env.MEMESH_ROUTER_SOCKET = originalRouterSocket;
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
});
