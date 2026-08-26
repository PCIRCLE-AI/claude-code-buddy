import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentIdempotencyConflictError,
  AgentMessageAccessError,
  AgentWaitAbortedError,
  fetchAgentMessage,
  pollAgentEvents,
  readAgentMessageReceipts,
  recordAgentReceipt,
  sendAgentMessage,
  waitForAgentEvents,
} from '../../src/core/agent-messaging.js';
import { getDatabase } from '../../src/db.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

const dbHandle = useTestDatabase('memesh-agent-messaging-');

afterEach(() => {
  expect(dbHandle.dbPath.endsWith('test.db')).toBe(true);
});

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function failingDb(failOn: RegExp) {
  const real = getDatabase();
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (failOn.test(sql)) throw new Error('injected agent-messaging failure');
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as typeof real;
}

describe('agent messaging durable core', () => {
  it('creates one message, one delivery, and one event, and exact retry returns the same canonical rows', () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello', secret: 'hidden-in-payload-only' },
      correlation_id: 'corr-1',
      privacy: 'private',
      provenance: { transport: 'cli', host: 'codex' },
    });

    expect(count('agent_messages')).toBe(1);
    expect(count('agent_message_deliveries')).toBe(1);
    expect(count('agent_message_events')).toBe(1);
    expect(count('agent_message_idempotency')).toBe(1);

    const retried = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello', secret: 'hidden-in-payload-only' },
      correlation_id: 'corr-1',
      privacy: 'private',
      provenance: { transport: 'cli', host: 'codex' },
    });

    expect(retried).toEqual(sent);

    const events = pollAgentEvents(getDatabase(), { project: 'proj-a', recipient: 'receiver-1' });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      event_id: sent.event_id,
      message_id: sent.message_id,
      sender: 'sender-1',
      recipient: 'receiver-1',
      content_type: 'application/json',
      correlation_id: 'corr-1',
      privacy: 'private',
    });
    expect(JSON.stringify(events.events[0])).not.toContain('hidden-in-payload-only');

    const fetched = fetchAgentMessage(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
    });
    expect(fetched.payload).toEqual({ text: 'hello', secret: 'hidden-in-payload-only' });
    expect(readAgentMessageReceipts(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
    })).toEqual([]);
  });

  it('rejects a conflicting retry under the same sender/project idempotency key', () => {
    sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello' },
    });

    expect(() => sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'changed' },
    })).toThrow(AgentIdempotencyConflictError);
  });

  it('rolls message and delivery back when event insertion fails', () => {
    expect(() => sendAgentMessage(failingDb(/INSERT INTO agent_message_events/), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello' },
    })).toThrow(/injected agent-messaging failure/);

    expect(count('agent_messages')).toBe(0);
    expect(count('agent_message_deliveries')).toBe(0);
    expect(count('agent_message_events')).toBe(0);
    expect(count('agent_message_idempotency')).toBe(0);
  });

  it('keeps the external cursor opaque and enforces recipient/project isolation', () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello' },
    });

    const first = pollAgentEvents(getDatabase(), { project: 'proj-a', recipient: 'receiver-1' });
    expect(first.next_cursor).not.toContain(sent.message_id);
    expect(first.next_cursor.length).toBeGreaterThan(10);
    expect(first.events).toHaveLength(1);

    expect(() => pollAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-2',
      cursor: first.next_cursor,
    })).toThrow(AgentMessageAccessError);
    expect(() => pollAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-2',
      cursor: 'unknown-opaque-cursor',
    })).toThrow(AgentMessageAccessError);

    expect(() => fetchAgentMessage(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-2',
      message_id: sent.message_id,
    })).toThrow(AgentMessageAccessError);

    expect(() => fetchAgentMessage(getDatabase(), {
      project: 'proj-b',
      recipient: 'receiver-1',
      message_id: sent.message_id,
    })).toThrow(AgentMessageAccessError);
  });

  it('supports duplicate-hint recovery through a stale cursor while intake receipts stay idempotent', () => {
    const empty = pollAgentEvents(getDatabase(), { project: 'proj-a', recipient: 'receiver-1' });
    expect(empty.events).toEqual([]);

    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello' },
    });

    const first = pollAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      cursor: empty.next_cursor,
    });
    const duplicate = pollAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      cursor: empty.next_cursor,
    });

    expect(first.events).toHaveLength(1);
    expect(duplicate.events).toHaveLength(1);
    expect(first.next_cursor).toBe(duplicate.next_cursor);
    expect(count('agent_message_cursors')).toBe(2);
    expect(first.events[0].message_id).toBe(sent.message_id);
    expect(duplicate.events[0].message_id).toBe(sent.message_id);

    const intake = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'intake',
      intake_state: 'ingested',
      actor: 'receiver-1',
      idempotency_key: 'intake-1',
      detail: { source: 'stale-cursor-replay' },
    });
    const intakeRetry = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'intake',
      intake_state: 'ingested',
      actor: 'receiver-1',
      idempotency_key: 'intake-1',
      detail: { source: 'stale-cursor-replay' },
    });

    expect(intakeRetry).toEqual(intake);
    const receipts = readAgentMessageReceipts(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ receipt_kind: 'intake', intake_state: 'ingested' });
  });

  it('keeps intake, ack, disposition, and host activation as separate append-only facts', () => {
    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-a',
      sender: 'sender-1',
      recipient: 'receiver-1',
      idempotency_key: 'send-1',
      content_type: 'application/json',
      payload: { text: 'hello' },
    });

    const intake = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'intake',
      intake_state: 'fetched',
      actor: 'receiver-1',
      idempotency_key: 'intake-1',
    });
    const ack = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'ack',
      actor: 'receiver-1',
      idempotency_key: 'ack-1',
    });
    const disposition = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'disposition',
      disposition: 'completed',
      actor: 'receiver-1',
      idempotency_key: 'disp-1',
    });
    const activation = recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'host_activation',
      host_activation: 'manual_resume_required',
      actor: 'receiver-1',
      idempotency_key: 'host-1',
    });

    expect(intake.receipt_kind).toBe('intake');
    expect(ack.receipt_kind).toBe('ack');
    expect(disposition.receipt_kind).toBe('disposition');
    expect(activation.receipt_kind).toBe('host_activation');

    expect(() => recordAgentReceipt(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
      receipt_kind: 'host_activation',
      host_activation: 'failed',
      actor: 'receiver-1',
      idempotency_key: 'host-1',
    })).toThrow(AgentIdempotencyConflictError);

    const receipts = readAgentMessageReceipts(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      message_id: sent.message_id,
    });
    expect(receipts.map((receipt) => receipt.receipt_kind)).toEqual([
      'intake',
      'ack',
      'disposition',
      'host_activation',
    ]);
    expect(receipts.find((receipt) => receipt.receipt_kind === 'host_activation')).toMatchObject({
      receipt_kind: 'host_activation',
      host_activation: 'manual_resume_required',
    });
  });

  it('waits for new events, returns a stable cursor on timeout, and supports cancellation', async () => {
    const start = pollAgentEvents(getDatabase(), { project: 'proj-a', recipient: 'receiver-1' });
    expect(start.events).toEqual([]);

    const wakeup = waitForAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      cursor: start.next_cursor,
      wait_ms: 400,
      poll_interval_ms: 20,
    });

    setTimeout(() => {
      sendAgentMessage(getDatabase(), {
        project: 'proj-a',
        sender: 'sender-1',
        recipient: 'receiver-1',
        idempotency_key: 'send-1',
        content_type: 'application/json',
        payload: { text: 'hello' },
      });
    }, 30);

    const result = await wakeup;
    expect(result.events).toHaveLength(1);

    const timeout = await waitForAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      cursor: result.next_cursor,
      wait_ms: 40,
      poll_interval_ms: 10,
    });
    expect(timeout.events).toEqual([]);
    expect(timeout.next_cursor).toBe(result.next_cursor);

    const controller = new AbortController();
    const aborted = waitForAgentEvents(getDatabase(), {
      project: 'proj-a',
      recipient: 'receiver-1',
      cursor: result.next_cursor,
      wait_ms: 400,
      poll_interval_ms: 20,
    }, controller.signal);

    setTimeout(() => controller.abort(), 25);
    await expect(aborted).rejects.toThrow(AgentWaitAbortedError);
  });
});
