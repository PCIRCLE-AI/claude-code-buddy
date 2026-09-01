import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAgentMessageAction } from '../../src/transports/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { MessageSchema } from '../../src/transports/schemas.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES } from '../../src/core/agent-messaging.js';
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
  it('accepts exactly the durable JSON payload limit and rejects one byte over it', () => {
    const base = {
      action: 'send' as const,
      project: 'limits',
      sender: 'sender',
      recipient: 'recipient',
      idempotency_key: 'limit-check',
    };
    expect(MessageSchema.safeParse({
      ...base,
      payload: 'x'.repeat(AGENT_MESSAGE_JSON_MAX_BYTES - 2),
    }).success).toBe(true);
    const over = MessageSchema.safeParse({
      ...base,
      payload: 'x'.repeat(AGENT_MESSAGE_JSON_MAX_BYTES - 1),
    });
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.issues[0]?.message).toContain(`${AGENT_MESSAGE_JSON_MAX_BYTES}`);
  });

  it('validates discover scope and bounded defaults', () => {
    expect(MessageSchema.parse({ action: 'discover', project: 'directory' })).toEqual({
      action: 'discover', project: 'directory', limit: 50,
    });
    expect(MessageSchema.safeParse({ action: 'discover' }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'discover', project: 'directory', extra: true }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'discover', project: 'directory', limit: 0 }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'discover', project: 'directory', limit: 101 }).success).toBe(false);
  });

  it('returns the router discovery result unchanged without message or receipt effects', async () => {
    const beforeMessages = getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_messages').get();
    const beforeReceipts = getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_message_receipts').get();
    const calls: unknown[] = [];
    const routerResult = {
      cards: [{
        session_id: 'session-1', principal_id: 'principal-1', host_kind: 'codex',
        project: 'directory', model: null, work_summary: null, active: true,
        generation: 1, lease_expires_at_ms: 123,
      }],
    };
    const result = await executeAgentMessageAction(getDatabase(), {
      action: 'discover', project: 'directory',
    }, { transport: 'cli', sourceHost: 'cli' }, {
      sendRouterRequest: async (socketPath, request) => {
        calls.push({ socketPath, request });
        return routerResult;
      },
    });
    expect(result).toBe(routerResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ request: {
      version: 1, type: 'discover', project: 'directory', limit: 50, hops: 0,
    } });
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_messages').get()).toEqual(beforeMessages);
    expect(getDatabase().prepare('SELECT COUNT(*) AS count FROM agent_message_receipts').get()).toEqual(beforeReceipts);
  });

  it('propagates router discovery errors instead of returning an empty directory', async () => {
    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'discover', project: 'directory', limit: 1,
    }, { transport: 'mcp', sourceHost: 'mcp' }, {
      sendRouterRequest: async () => { throw new Error('router unavailable'); },
    })).rejects.toThrow('router unavailable');
  });

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

  it('keeps the exact-session payload durable but reports recipient_unavailable without native acceptance', async () => {
    await expect(executeAgentMessageAction(getDatabase(), {
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
    }, {
      sendRouterRequest: async () => ({ delivered: false }),
    })).rejects.toMatchObject({ code: 'recipient_unavailable' });

    const stored = getDatabase().prepare(`
      SELECT d.message_id, d.recipient, d.target_kind
      FROM agent_message_deliveries d
    `).get() as { message_id: string; recipient: string; target_kind: string };
    expect(stored).toEqual({
      message_id: expect.any(String),
      recipient: 'session-instance-7',
      target_kind: 'session',
    });

    const fetched = await executeAgentMessageAction(getDatabase(), {
      action: 'fetch',
      project: 'transport-session',
      recipient: 'session-instance-7',
      target_kind: 'session',
      message_id: stored.message_id,
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    }) as { message_id: string; target_kind: string; payload: string };
    expect(fetched).toMatchObject({
      message_id: stored.message_id,
      target_kind: 'session',
      payload: 'review this model feedback',
    });

    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'fetch',
      project: 'transport-session',
      recipient: 'session-instance-7',
      target_kind: 'principal',
      message_id: stored.message_id,
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    })).rejects.toThrow(/not available/);
  });

  it('reports native_message_too_large when the exact-session adapter rejects the full envelope', async () => {
    await expect(executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-session-size',
      sender: 'sender',
      recipient: 'session-instance-large',
      target_kind: 'session',
      idempotency_key: 'exact-session-too-large',
      payload: 'fits durable storage but not the native envelope',
    }, {
      transport: 'cli',
      sourceHost: 'test-host',
    }, {
      sendRouterRequest: async (_socketPath, request) => {
        if (request.type !== 'notify') throw new Error('expected notify request');
        const connectionId = randomUUID();
        getDatabase().prepare(`
          INSERT INTO agent_principals (project, principal_id, activation_event_sequence)
          VALUES (?, ?, 0)
        `).run('transport-session-size', 'session-instance-large');
        getDatabase().prepare(`
          INSERT INTO agent_session_instances (
            project, session_instance_id, principal_id, adapter_kind
          ) VALUES (?, ?, ?, 'codex-cli-queue')
        `).run('transport-session-size', 'session-instance-large', 'session-instance-large');
        getDatabase().prepare(`
          INSERT INTO agent_session_connections (
            connection_id, project, principal_id, session_instance_id, generation,
            adapter_kind, router_instance_id, lease_expires_at_ms
          ) VALUES (?, ?, ?, ?, 1, 'codex-cli-queue', 'test-router', ?)
        `).run(
          connectionId,
          'transport-session-size',
          'session-instance-large',
          'session-instance-large',
          Date.now() + 60_000,
        );
        getDatabase().prepare(`
          INSERT INTO agent_dispatch_attempts (
            attempt_id, delivery_id, project, principal_id, session_instance_id,
            connection_id, generation, router_instance_id, attempt_number,
            result, failure_code, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1,
            'adapter_rejected', 'native_message_too_large', CURRENT_TIMESTAMP)
        `).run(
          randomUUID(),
          request.delivery_id,
          'transport-session-size',
          'session-instance-large',
          'session-instance-large',
          connectionId,
        );
        return { delivered: false };
      },
    })).rejects.toMatchObject({ code: 'native_message_too_large' });
  });

  it('returns native_accepted only after exact-session host acceptance is read back', async () => {
    const result = await executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-session',
      sender: 'sender',
      recipient: 'session-instance-8',
      target_kind: 'session',
      idempotency_key: 'exact-session-accepted',
      payload: { text: 'native content' },
      content_type: 'application/json',
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    }, {
      sendRouterRequest: async (_socketPath, request) => {
        if (request.type !== 'notify') throw new Error('expected one notify request');
        const message = getDatabase().prepare(`
          SELECT d.delivery_id, d.message_id, d.project, d.recipient
          FROM agent_message_deliveries d
          WHERE d.delivery_id = ?
        `).get(request.delivery_id) as PublicSentMessage;
        seedHostAccept(message);
        return { delivered: true };
      },
    }) as PublicSentMessage & {
      native_delivery: { status: string; adapter_kind: string; receipt: Record<string, unknown> };
    };

    expect(result.native_delivery).toMatchObject({
      status: 'native_accepted',
      adapter_kind: 'test-adapter',
      receipt: { channel: 'test' },
    });

    const replay = await executeAgentMessageAction(getDatabase(), {
      action: 'send',
      project: 'transport-session',
      sender: 'sender',
      recipient: 'session-instance-8',
      target_kind: 'session',
      idempotency_key: 'exact-session-accepted',
      payload: { text: 'native content' },
      content_type: 'application/json',
    }, {
      transport: 'mcp',
      sourceHost: 'test-host',
    }, {
      sendRouterRequest: async () => {
        throw new Error('accepted replay must not dispatch twice');
      },
    }) as { message_id: string; native_delivery: { status: string } };
    expect(replay).toMatchObject({
      message_id: result.message_id,
      native_delivery: { status: 'native_accepted' },
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
