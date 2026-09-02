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

describe('agent messaging scope identity', () => {
  // An inbox is keyed on (project, recipient). Two spellings of ONE identity
  // are two inboxes — the split measured on the maintainer's graph. The
  // opposite mistake is worse: fusing two identities delivers one agent's
  // messages to another. These three cases pin both edges and the refusal
  // between them.

  it('two spellings of one identity converge: an NFD recipient lands in the NFC inbox', () => {
    // Unicode calls these canonically equivalent; SQLite compares bytes and
    // would call them two inboxes.
    const composed = 'caf\u00e9-reviewer';
    const decomposed = 'cafe\u0301-reviewer';
    expect(composed).not.toBe(decomposed);
    expect(decomposed.normalize('NFC')).toBe(composed);

    const sent = sendAgentMessage(getDatabase(), {
      project: 'proj-nfc',
      sender: 'author',
      recipient: decomposed,
      idempotency_key: 'nfc-1',
      content_type: 'text/plain',
      payload: 'converged',
    });
    expect(sent.recipient).toBe(composed);

    // Stored once, under the canonical spelling...
    const stored = getDatabase()
      .prepare('SELECT DISTINCT recipient AS r FROM agent_message_deliveries')
      .all() as Array<{ r: string }>;
    expect(stored.map((row) => row.r)).toEqual([composed]);

    // ...and reachable from either spelling, because reads canonicalise too.
    for (const spelling of [composed, decomposed]) {
      expect(fetchAgentMessage(getDatabase(), {
        project: 'proj-nfc',
        recipient: spelling,
        message_id: sent.message_id,
      }).payload).toBe('converged');
      expect(pollAgentEvents(getDatabase(), { project: 'proj-nfc', recipient: spelling }).events).toHaveLength(1);
    }
  });

  it('two genuinely different identities stay apart: `session_X` and `claude-code:session_X`', () => {
    // THE dangerous failure mode. `claude-code:` looks like a namespace
    // prefix, but it appears nowhere in this repository's source or history:
    // there is no convention to normalise against, and stripping it would
    // hand one agent another agent's mail. Both spellings really do occur in
    // the maintainer's graph (17 and 14 deliveries), and they stay separate.
    const bare = 'session_01PDMer3P4cVYeHr4KRen3Un';
    const prefixed = `claude-code:${bare}`;
    const db = getDatabase();

    const toBare = sendAgentMessage(db, {
      project: 'memesh', sender: 'reviewer', recipient: bare,
      idempotency_key: 'split-1', content_type: 'text/plain', payload: 'for the bare id',
    });
    const toPrefixed = sendAgentMessage(db, {
      project: 'memesh', sender: 'reviewer', recipient: prefixed,
      idempotency_key: 'split-2', content_type: 'text/plain', payload: 'for the prefixed id',
    });

    expect(toBare.recipient).toBe(bare);
    expect(toPrefixed.recipient).toBe(prefixed);
    expect(count('agent_message_deliveries')).toBe(2);

    // Neither can read the other's payload...
    expect(() => fetchAgentMessage(db, { project: 'memesh', recipient: prefixed, message_id: toBare.message_id }))
      .toThrow(AgentMessageAccessError);
    expect(() => fetchAgentMessage(db, { project: 'memesh', recipient: bare, message_id: toPrefixed.message_id }))
      .toThrow(AgentMessageAccessError);
    // ...and neither sees the other's event.
    expect(pollAgentEvents(db, { project: 'memesh', recipient: bare }).events.map((e) => e.message_id))
      .toEqual([toBare.message_id]);
    expect(pollAgentEvents(db, { project: 'memesh', recipient: prefixed }).events.map((e) => e.message_id))
      .toEqual([toPrefixed.message_id]);
  });

  it('an absolute filesystem path is refused, naming the field and a valid value', () => {
    const base = {
      project: 'memesh-llm-memory', sender: 'author', recipient: 'root',
      idempotency_key: 'abs-1', content_type: 'text/plain' as const, payload: 'x',
    };
    // `/root` is the spelling that split the maintainer's inbox. It is
    // refused rather than silently rewritten: turning `/root` into `root`
    // would just as silently fuse `/tmp/root` with `/var/root`.
    expect(() => sendAgentMessage(getDatabase(), { ...base, recipient: '/root' }))
      .toThrow(/recipient must be a stable identifier, not a filesystem path.*"\/root".*"root"/s);
    expect(() => sendAgentMessage(getDatabase(), { ...base, project: '/Users/x/Projects/memesh-llm-memory' }))
      .toThrow(/project must be a stable identifier, not a filesystem path.*"memesh-llm-memory"/s);
    expect(() => sendAgentMessage(getDatabase(), { ...base, project: 'C:\\work\\repo' }))
      .toThrow(/project must be a stable identifier/);
    expect(count('agent_messages')).toBe(0);

    // Reads are gated by the same rule, so the refused spelling cannot be
    // used to reach rows either.
    expect(() => pollAgentEvents(getDatabase(), { project: 'memesh-llm-memory', recipient: '/root' }))
      .toThrow(/recipient must be a stable identifier/);

    // `sender` is provenance, not routing: it keys no inbox and it keys
    // replay protection, so it is deliberately left alone.
    const sent = sendAgentMessage(getDatabase(), { ...base, sender: '/root/full-board-scan-luna' });
    expect(sent.sender).toBe('/root/full-board-scan-luna');
  });
});
