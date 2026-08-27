import { randomUUID } from 'node:crypto';
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

type PublicSentMessage = {
  message_id: string;
  delivery_id: string;
  project: string;
  recipient: string;
};

function seedHostAccept(message: PublicSentMessage): string {
  const suffix = randomUUID();
  const sessionId = `session-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const hostAcceptId = `host-accept-${suffix}`;
  getDatabase().transaction(() => {
    getDatabase().prepare(`
      INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
      VALUES (?, ?, 0)
    `).run(message.project, message.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
      VALUES (?, ?, ?, 'test-adapter')
    `).run(message.project, sessionId, message.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_connections (
        connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
    `).run(connectionId, message.project, message.recipient, sessionId, Date.now() + 60_000);
    getDatabase().prepare(`
      INSERT INTO agent_dispatch_attempts (
        attempt_id, delivery_id, project, principal_id, session_instance_id,
        connection_id, generation, router_instance_id, attempt_number, result, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
    `).run(
      attemptId,
      message.delivery_id,
      message.project,
      message.recipient,
      sessionId,
      connectionId,
    );
    getDatabase().prepare(`
      INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json)
      VALUES (?, ?, ?, 'test-adapter', '{"channel":"test"}')
    `).run(hostAcceptId, attemptId, message.delivery_id);
  }).immediate();
  return hostAcceptId;
}

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

    const fetched = await executeAgentMessageAction(getDatabase(), {
      action: 'fetch',
      project: 'transport-session',
      recipient: 'session-instance-7',
      target_kind: 'session',
      message_id: sent.message_id,
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    }) as { message_id: string; target_kind: string; payload: string };
    expect(fetched).toMatchObject({
      message_id: sent.message_id,
      target_kind: 'session',
      payload: 'review this model feedback',
    });

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'fetch',
      project: 'transport-session',
      recipient: 'session-instance-7',
      target_kind: 'principal',
      message_id: sent.message_id,
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    })).rejects.toThrow(/not available/);
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

  it('writes public ACK and disposition as explicit receipts and projects unified last-mile readback', async () => {
    const context = { transport: 'mcp' as const, sourceHost: 'recipient-host' };
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-canonical',
      sender: 'sender',
      recipient: 'recipient',
      idempotency_key: 'canonical-send',
      payload: { text: 'audit me' },
      content_type: 'application/json',
    }, context) as PublicSentMessage;
    const hostAcceptId = seedHostAccept(sent);

    const ack = await executeAgentMessageAction(getDatabase(), {
      action: 'ack',
      project: sent.project,
      recipient: sent.recipient,
      message_id: sent.message_id,
      idempotency_key: 'canonical-ack',
    }, context) as Record<string, unknown>;
    const disposition = await executeAgentMessageAction(getDatabase(), {
      action: 'disposition',
      project: sent.project,
      recipient: sent.recipient,
      message_id: sent.message_id,
      idempotency_key: 'canonical-disposition',
      disposition: 'completed',
      detail: 'finished by recipient',
    }, context) as Record<string, unknown>;

    expect(ack).toMatchObject({
      receipt_kind: 'ack',
    });
    expect(disposition).toMatchObject({
      receipt_kind: 'disposition',
      detail: expect.objectContaining({ disposition: 'completed' }),
    });
    expect(getDatabase().prepare(`
      SELECT receipt_kind, COUNT(*) AS count
      FROM agent_message_receipts
      WHERE message_id = ? AND receipt_kind IN ('ack', 'disposition')
      GROUP BY receipt_kind
    `).all(sent.message_id)).toEqual([
      { receipt_kind: 'ack', count: 1 },
      { receipt_kind: 'disposition', count: 1 },
    ]);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_ack_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_workflow_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });

    const readback = await executeAgentMessageAction(getDatabase(), {
      action: 'receipts',
      project: sent.project,
      recipient: sent.recipient,
      message_id: sent.message_id,
    }, context) as Array<Record<string, unknown>>;
    expect(readback.map((fact) => fact.receipt_kind)).toEqual(['host_accept', 'ack', 'disposition']);
    expect(readback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        receipt_kind: 'host_accept',
        fact_source: 'agent_host_accept',
        delivery_id: sent.delivery_id,
        host_accept_id: hostAcceptId,
      }),
      expect.objectContaining({
        receipt_kind: 'ack',
        fact_source: 'agent_message_receipt',
      }),
      expect.objectContaining({
        receipt_kind: 'disposition',
        fact_source: 'agent_message_receipt',
        detail: expect.objectContaining({ disposition: 'completed' }),
      }),
    ]));
  });

  it('preserves canonical idempotency and rejects conflicting public workflow retries', async () => {
    const context = { transport: 'http' as const, sourceHost: 'recipient-host' };
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: 'transport-idempotency', sender: 'sender', recipient: 'recipient',
      idempotency_key: 'send-idempotency', payload: 'idempotent lifecycle',
    }, context) as PublicSentMessage;
    seedHostAccept(sent);

    const first = await executeAgentMessageAction(getDatabase(), {
      action: 'disposition', project: sent.project, recipient: sent.recipient,
      message_id: sent.message_id, idempotency_key: 'workflow-idempotency', disposition: 'completed',
    }, context);
    const retry = await executeAgentMessageAction(getDatabase(), {
      action: 'disposition', project: sent.project, recipient: sent.recipient,
      message_id: sent.message_id, idempotency_key: 'workflow-idempotency', disposition: 'completed',
    }, context);
    expect(retry).toEqual(first);

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'disposition', project: sent.project, recipient: sent.recipient,
      message_id: sent.message_id, idempotency_key: 'workflow-idempotency', disposition: 'cancelled',
    }, context)).rejects.toThrow(/idempotency conflict/);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_workflow_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_message_receipts WHERE message_id = ?')
      .get(sent.message_id)).toEqual({ count: 1 });
  });

  it('allows an explicit inbox ACK without host acceptance and keeps it separate from host-native facts', async () => {
    const context = { transport: 'cli' as const, sourceHost: 'recipient-host' };
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: 'transport-no-host-accept', sender: 'sender', recipient: 'recipient',
      idempotency_key: 'send-no-host-accept', payload: 'not delivered',
    }, context) as PublicSentMessage;

    const ack = await executeAgentMessageAction(getDatabase(), {
      action: 'ack', project: sent.project, recipient: sent.recipient,
      message_id: sent.message_id, idempotency_key: 'ack-without-host-accept',
    }, context) as Record<string, unknown>;
    expect(ack).toMatchObject({ receipt_kind: 'ack', message_id: sent.message_id });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_ack_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_message_receipts WHERE message_id = ?')
      .get(sent.message_id)).toEqual({ count: 1 });
  });

  it('denies wrong-recipient public lifecycle writes and readback without leaking canonical facts', async () => {
    const context = { transport: 'mcp' as const, sourceHost: 'recipient-host' };
    const sent = await executeAgentMessageAction(getDatabase(), {
      action: 'send', project: 'transport-access', sender: 'sender', recipient: 'recipient',
      idempotency_key: 'send-access', payload: 'private lifecycle',
    }, context) as PublicSentMessage;
    seedHostAccept(sent);

    for (const action of [
      { action: 'ack', idempotency_key: 'wrong-ack' },
      { action: 'disposition', idempotency_key: 'wrong-workflow', disposition: 'completed' },
      { action: 'receipts' },
    ]) {
      await expect(executeAgentMessageAction(getDatabase(), {
        ...action,
        project: sent.project,
        recipient: 'wrong-recipient',
        message_id: sent.message_id,
      }, context)).rejects.toThrow(/not available/);
    }
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_ack_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_workflow_facts WHERE delivery_id = ?')
      .get(sent.delivery_id)).toEqual({ count: 0 });
  });
});
