import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentMessageStorageQuotaExceededError,
  enforceAgentMessageStorageQuota,
  getAgentMessageStorageReport,
  pruneTerminalAgentMessagePayloads,
} from '../../src/core/agent-message-storage.js';
import {
  recordAgentAckFact,
  recordAgentReceipt,
  recordAgentWorkflowFact,
  sendAgentMessage,
  type SentAgentMessage,
} from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-message-storage-');
const CUTOFF = '2025-01-01T00:00:00.000Z';
const OLD = '2020-01-01 00:00:00';
const RECENT = '2026-01-01 00:00:00';

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function send(payload: unknown = { body: 'payload' }): SentAgentMessage {
  return sendAgentMessage(getDatabase(), {
    project: 'storage-project',
    sender: 'sender',
    recipient: 'recipient',
    idempotency_key: `send-${Math.random().toString(36).slice(2)}`,
    content_type: 'application/json',
    payload: payload as { [key: string]: string },
  });
}

type DeliveryRef = Pick<SentAgentMessage, 'delivery_id' | 'message_id' | 'project' | 'recipient'>;

function additionalDelivery(message: SentAgentMessage, recipient: string): DeliveryRef {
  const deliveryId = randomUUID();
  getDatabase().transaction(() => {
    getDatabase().prepare(`
      INSERT INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind)
      VALUES (?, ?, ?, ?, 'principal')
    `).run(deliveryId, message.message_id, message.project, recipient);
    getDatabase().prepare(`
      INSERT INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind)
      VALUES (?, ?, ?, ?, ?, 'available')
    `).run(randomUUID(), message.message_id, deliveryId, message.project, recipient);
  }).immediate();
  return { delivery_id: deliveryId, message_id: message.message_id, project: message.project, recipient };
}

function hostAccept(delivery: DeliveryRef): string {
  const suffix = randomUUID();
  const sessionId = `session-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const hostAcceptId = `host-accept-${suffix}`;
  getDatabase().transaction(() => {
    getDatabase().prepare(`
      INSERT OR IGNORE INTO agent_principals (project, principal_id, activation_event_sequence)
      VALUES (?, ?, 0)
    `).run(delivery.project, delivery.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_instances (project, session_instance_id, principal_id, adapter_kind)
      VALUES (?, ?, ?, 'test-adapter')
    `).run(delivery.project, sessionId, delivery.recipient);
    getDatabase().prepare(`
      INSERT INTO agent_session_connections (
        connection_id, project, principal_id, session_instance_id, generation,
        adapter_kind, router_instance_id, lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, 1, 'test-adapter', 'test-router', ?)
    `).run(connectionId, delivery.project, delivery.recipient, sessionId, Date.now() + 60_000);
    getDatabase().prepare(`
      INSERT INTO agent_dispatch_attempts (
        attempt_id, delivery_id, project, principal_id, session_instance_id,
        connection_id, generation, router_instance_id, attempt_number, result, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'test-router', 1, 'adapter_returned', CURRENT_TIMESTAMP)
    `).run(
      attemptId,
      delivery.delivery_id,
      delivery.project,
      delivery.recipient,
      sessionId,
      connectionId,
    );
    getDatabase().prepare(`
      INSERT INTO agent_host_accepts (host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json)
      VALUES (?, ?, ?, 'test-adapter', '{"accepted":true}')
    `).run(hostAcceptId, attemptId, delivery.delivery_id);
  }).immediate();
  return hostAcceptId;
}

function ack(delivery: DeliveryRef, idempotencyKey = `ack-${delivery.delivery_id}`): void {
  recordAgentAckFact(getDatabase(), {
    delivery_id: delivery.delivery_id,
    host_accept_id: hostAccept(delivery),
    actor: delivery.recipient,
    idempotency_key: idempotencyKey,
  });
}

function workflow(message: DeliveryRef, workflowState: string, createdAt = OLD): void {
  recordAgentWorkflowFact(getDatabase(), {
    delivery_id: message.delivery_id,
    actor: message.recipient,
    workflow_state: workflowState,
    idempotency_key: `workflow-${message.message_id}-${workflowState}`,
  });
  getDatabase().prepare(`
    UPDATE agent_workflow_facts SET created_at = ? WHERE delivery_id = ?
  `).run(createdAt, message.delivery_id);
}

function storedPayload(messageId: string): string {
  return (getDatabase().prepare(`
    SELECT payload_json FROM agent_messages WHERE message_id = ?
  `).get(messageId) as { payload_json: string }).payload_json;
}

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('bounded agent message storage', () => {
  it('reconciles mixed lifecycle states without changing stored messages, receipts, or acknowledgements', () => {
    const prunable = send({ body: 'terminal-old' });
    const terminalRetained = send({ body: 'terminal-recent' });
    const deferred = send({ body: 'offline-pending' });
    const ackOnly = send({ body: 'ack-only' });
    ack(prunable);
    workflow(prunable, 'completed');
    ack(terminalRetained);
    workflow(terminalRetained, 'completed', RECENT);
    workflow(deferred, 'deferred');
    ack(ackOnly, 'ack-only');

    const before = getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages ORDER BY message_id
    `).all();
    const receiptsBefore = count('agent_message_receipts');
    const report = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF, databasePath: dbHandle.dbPath });

    expect(report).toMatchObject({
      message_count: 4,
      protected_unresolved_message_count: 2,
      terminal_retained_message_count: 1,
      terminal_prunable_message_count: 1,
      reconciled_message_count: 4,
      receipt_count: 0,
      ack_fact_count: 3,
      cursor_count: 0,
      principal_count: 1,
      session_instance_count: 3,
      session_connection_count: 3,
      presence_fact_count: 0,
      dispatch_attempt_count: 3,
      host_accept_count: 3,
    });
    expect(report.payload_bytes).toBeGreaterThan(0);
    expect(report.page_count).toBeGreaterThan(0);
    expect(report.page_size).toBeGreaterThan(0);
    expect(report.database_file_bytes).not.toBeNull();
    expect(getDatabase().prepare(`
      SELECT message_id, payload_json, payload_tombstoned_at FROM agent_messages ORDER BY message_id
    `).all()).toEqual(before);
    expect(count('agent_message_receipts')).toBe(receiptsBefore);

    const dryRun = pruneTerminalAgentMessagePayloads(getDatabase(), { cutoff: CUTOFF, dryRun: true });
    expect(dryRun).toMatchObject({ dry_run: true, candidate_count: 1, tombstoned_count: 0 });
    expect(dryRun.candidates[0].message_id).toBe(prunable.message_id);
    expect(storedPayload(prunable.message_id)).toContain('terminal-old');
    expect(storedPayload(deferred.message_id)).toContain('offline-pending');
    expect(storedPayload(ackOnly.message_id)).toContain('ack-only');

    expect(pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF, dryRun: false, batchSize: 4,
    })).toMatchObject({ candidate_count: 1, tombstoned_count: 1 });
    expect(storedPayload(prunable.message_id)).toContain('_agent_message_tombstone_v1');
    expect(storedPayload(terminalRetained.message_id)).toContain('terminal-recent');
    expect(storedPayload(deferred.message_id)).toContain('offline-pending');
    expect(storedPayload(ackOnly.message_id)).toContain('ack-only');
  });

  it('retains completed-without-ACK and ACK-without-terminal while pruning only all-delivery ACK plus old-terminal messages', () => {
    const completedWithoutAck = send({ body: 'completed-without-ack' });
    workflow(completedWithoutAck, 'completed');

    const ackWithoutTerminal = send({ body: 'ack-without-terminal' });
    ack(ackWithoutTerminal);

    const allDeliveriesReady = send({ body: 'all-deliveries-ready' });
    const secondDelivery = additionalDelivery(allDeliveriesReady, 'recipient-two');
    ack(allDeliveriesReady);
    workflow(allDeliveriesReady, 'completed');
    ack(secondDelivery);
    workflow(secondDelivery, 'completed');

    const report = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF });
    expect(report).toMatchObject({
      message_count: 3,
      protected_unresolved_message_count: 2,
      terminal_prunable_message_count: 1,
    });

    const result = pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF,
      dryRun: false,
      batchSize: 3,
    });
    expect(result.candidates.map((candidate) => candidate.message_id)).toEqual([allDeliveriesReady.message_id]);
    expect(storedPayload(completedWithoutAck.message_id)).toContain('completed-without-ack');
    expect(storedPayload(ackWithoutTerminal.message_id)).toContain('ack-without-terminal');
    expect(storedPayload(allDeliveriesReady.message_id)).toContain('_agent_message_tombstone_v1');
  });

  it('treats explicit inbox ACK and disposition receipts as one eligible audited delivery without requiring host push', () => {
    const inboxOnly = send({ body: 'fetched through MCP without host adapter' });
    recordAgentReceipt(getDatabase(), {
      project: inboxOnly.project,
      recipient: inboxOnly.recipient,
      message_id: inboxOnly.message_id,
      receipt_kind: 'ack',
      actor: inboxOnly.recipient,
      idempotency_key: 'inbox-only-ack',
    });
    recordAgentReceipt(getDatabase(), {
      project: inboxOnly.project,
      recipient: inboxOnly.recipient,
      message_id: inboxOnly.message_id,
      receipt_kind: 'disposition',
      disposition: 'completed',
      actor: inboxOnly.recipient,
      idempotency_key: 'inbox-only-disposition',
    });
    getDatabase().prepare(`
      UPDATE agent_message_receipts SET created_at = ? WHERE message_id = ?
    `).run(OLD, inboxOnly.message_id);

    expect(getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF })).toMatchObject({
      protected_unresolved_message_count: 0,
      terminal_prunable_message_count: 1,
      receipt_count: 2,
      ack_fact_count: 0,
      workflow_fact_count: 0,
    });
    expect(pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF,
      dryRun: false,
    })).toMatchObject({ candidate_count: 1, tombstoned_count: 1 });
    expect(storedPayload(inboxOnly.message_id)).toContain('_agent_message_tombstone_v1');
  });

  it('tombstones only terminal old payloads in bounded batches, preserves audit, and continues idempotently', () => {
    const messages = [send({ body: 'one' }), send({ body: 'two' }), send({ body: 'three' })];
    messages.forEach((message) => {
      ack(message);
      workflow(message, 'completed');
    });
    const originals = new Map(messages.map((message) => [message.message_id, storedPayload(message.message_id)]));

    for (let index = 0; index < messages.length; index++) {
      const result = pruneTerminalAgentMessagePayloads(getDatabase(), { cutoff: CUTOFF, dryRun: false, batchSize: 1 });
      expect(result).toMatchObject({ dry_run: false, candidate_count: 1, tombstoned_count: 1 });
    }
    expect(pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF, dryRun: false, batchSize: 1,
    })).toMatchObject({ candidate_count: 0, tombstoned_count: 0 });

    for (const message of messages) {
      const original = originals.get(message.message_id)!;
      const row = getDatabase().prepare(`
        SELECT payload_json, payload_sha256, payload_original_bytes, payload_tombstoned_at
        FROM agent_messages WHERE message_id = ?
      `).get(message.message_id) as {
        payload_json: string; payload_sha256: string; payload_original_bytes: number; payload_tombstoned_at: string;
      };
      expect(row.payload_json).not.toBe(original);
      expect(row.payload_json).toContain('_agent_message_tombstone_v1');
      expect(row.payload_sha256).toBe(createHash('sha256').update(original, 'utf8').digest('hex'));
      expect(row.payload_original_bytes).toBe(Buffer.byteLength(original, 'utf8'));
      expect(row.payload_tombstoned_at).toBeTruthy();
    }
    expect(count('agent_retention_facts')).toBe(3);
    expect(getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF })).toMatchObject({
      tombstoned_message_count: 3,
      terminal_prunable_message_count: 0,
      reconciled_message_count: 3,
    });
  });

  it('reports nonnegative net logical payload bytes reclaimed with dry-run/apply parity and report readback', () => {
    const small = send({ body: 'x' });
    const large = send({ body: 'x'.repeat(4 * 1024) });
    const originals = new Map([
      [small.message_id, storedPayload(small.message_id)],
      [large.message_id, storedPayload(large.message_id)],
    ]);
    ack(small);
    workflow(small, 'completed');
    ack(large);
    workflow(large, 'completed');

    const dryRun = pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF,
      dryRun: true,
      batchSize: 2,
    });
    expect(dryRun).toMatchObject({ dry_run: true, candidate_count: 2, tombstoned_count: 0 });

    const applied = pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF,
      dryRun: false,
      batchSize: 2,
    });
    expect(applied).toMatchObject({ dry_run: false, candidate_count: 2, tombstoned_count: 2 });
    expect(applied.reclaimed_payload_bytes).toBe(dryRun.reclaimed_payload_bytes);

    const netBytesByMessage = [small, large].map((message) => {
      const original = originals.get(message.message_id)!;
      const tombstone = storedPayload(message.message_id);
      return Buffer.byteLength(original, 'utf8') - Buffer.byteLength(tombstone, 'utf8');
    });
    expect(netBytesByMessage[0]).toBeLessThan(0);
    expect(netBytesByMessage[1]).toBeGreaterThan(0);
    expect(applied.reclaimed_payload_bytes).toBeLessThan(
      applied.candidates.reduce((total, candidate) => total + candidate.payload_bytes, 0),
    );

    const report = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF });
    const expectedPayloadBytes = [small, large].reduce(
      (total, message) => total + Buffer.byteLength(storedPayload(message.message_id), 'utf8'),
      0,
    );
    const expectedOriginalPayloadBytes = [...originals.values()].reduce(
      (total, payload) => total + Buffer.byteLength(payload, 'utf8'),
      0,
    );
    const expectedReclaimedBytes = Math.max(0, expectedOriginalPayloadBytes - expectedPayloadBytes);
    expect(applied.reclaimed_payload_bytes).toBe(expectedReclaimedBytes);
    expect(report).toMatchObject({
      tombstoned_message_count: 2,
      payload_bytes: expectedPayloadBytes,
      original_payload_bytes: expectedOriginalPayloadBytes,
    });
    expect(report.original_payload_bytes - report.payload_bytes).toBe(expectedReclaimedBytes);
  });

  it('rolls the whole bounded batch back when its fault seam trips', () => {
    const first = send({ body: 'first' });
    const second = send({ body: 'second' });
    ack(first);
    workflow(first, 'completed');
    ack(second);
    workflow(second, 'completed');
    const firstPayload = storedPayload(first.message_id);
    let calls = 0;

    expect(() => pruneTerminalAgentMessagePayloads(getDatabase(), {
      cutoff: CUTOFF,
      dryRun: false,
      batchSize: 2,
      fault: {
        beforeTombstone: () => {
          calls++;
          if (calls === 2) throw new Error('retention fault seam');
        },
      },
    })).toThrow('retention fault seam');

    expect(storedPayload(first.message_id)).toBe(firstPayload);
    expect(getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF })).toMatchObject({
      tombstoned_message_count: 0,
      terminal_prunable_message_count: 2,
      retention_fact_count: 0,
    });
  });

  it('rejects an over-quota send budget atomically before later message effects', () => {
    const existing = send({ body: 'existing' });
    const used = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF }).payload_bytes;
    const before = {
      messages: count('agent_messages'), deliveries: count('agent_message_deliveries'),
      events: count('agent_message_events'), idempotency: count('agent_message_idempotency'),
    };

    expect(() => getDatabase().transaction(() => {
      enforceAgentMessageStorageQuota(getDatabase(), { quotaBytes: used, additionalPayloadBytes: 1 });
      getDatabase().prepare(`INSERT INTO agent_messages (
        message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json
      ) VALUES ('must-not-exist', 'storage-project', 'sender', 'recipient', 'application/json', 'private', '{}', '{}')`).run();
    }).immediate()).toThrow(AgentMessageStorageQuotaExceededError);

    expect(count('agent_messages')).toBe(before.messages);
    expect(count('agent_message_deliveries')).toBe(before.deliveries);
    expect(count('agent_message_events')).toBe(before.events);
    expect(count('agent_message_idempotency')).toBe(before.idempotency);
    expect(storedPayload(existing.message_id)).toContain('existing');
    expect(() => enforceAgentMessageStorageQuota(getDatabase(), {
      quotaBytes: used + 1, additionalPayloadBytes: 1,
    })).not.toThrow();

    expect(() => sendAgentMessage(getDatabase(), {
      project: 'storage-project', sender: 'sender', recipient: 'recipient',
      idempotency_key: 'canonical-over-quota', content_type: 'application/json', payload: { body: 'blocked' },
    }, { storage_quota_bytes: used })).toThrow(AgentMessageStorageQuotaExceededError);
    expect(count('agent_messages')).toBe(before.messages);
    expect(count('agent_message_deliveries')).toBe(before.deliveries);
    expect(count('agent_message_events')).toBe(before.events);
    expect(count('agent_message_idempotency')).toBe(before.idempotency);
  });

  it('uses a deterministic small capacity fixture to show batch continuation and reusable-page accounting', () => {
    const messageCount = 24;
    const payload = { body: 'x'.repeat(8 * 1024) };
    const messages = Array.from({ length: messageCount }, () => send(payload));
    messages.forEach((message) => {
      ack(message);
      workflow(message, 'completed');
    });
    const before = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF });

    let processed = 0;
    while (true) {
      const result = pruneTerminalAgentMessagePayloads(getDatabase(), {
        cutoff: CUTOFF, dryRun: false, batchSize: 3,
      });
      processed += result.tombstoned_count;
      if (result.tombstoned_count === 0) break;
    }
    const after = getAgentMessageStorageReport(getDatabase(), { cutoff: CUTOFF });

    expect(processed).toBe(messageCount);
    expect(after).toMatchObject({ tombstoned_message_count: messageCount, terminal_prunable_message_count: 0 });
    expect(after.payload_bytes).toBeLessThan(before.payload_bytes / 10);
    expect(after.allocated_database_bytes).toBeGreaterThanOrEqual(before.allocated_database_bytes);
    expect(after.reusable_freelist_bytes).toBeGreaterThanOrEqual(0);
  });
});
