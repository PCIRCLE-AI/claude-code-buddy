/**
 * Unit tests for the pure half of `scripts/qa/live-journey.mjs`.
 *
 * The live check itself cannot run here — it needs the owner's Codex login or a
 * human at an interactive Claude session, and a test suite that shells out to
 * either would be a test that passes by not running. What CAN be pinned is
 * everything the live run *decides*: how it parses its arguments, when it
 * refuses to start, and — the part that matters — whether each assertion
 * actually rejects the evidence it is supposed to reject.
 *
 * The fixtures below are the recorded shapes from a real journey on 87edb292:
 * `codex exec --json` event lines, a `message send` result with its
 * `native_delivery` block, and a `message receipts` projection. They are inline
 * rather than read from disk on purpose — this suite must pass on a clean
 * clone, and the original logs live outside the repository.
 *
 * Every assertion is tested from BOTH sides. A test that only feeds an
 * assertion the input it accepts proves the happy path and nothing else; the
 * negative cases here are the ones that would have caught a `qa_sentinel`-only
 * check, an intake-free receipts projection, or a send whose native delivery
 * never happened.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAIT_MS,
  REQUIRED_DIST,
  assertCodexReply,
  assertDistPresent,
  assertIntakeReceipt,
  assertNativeAccepted,
  assertRecipientUnavailable,
  assertSafeMemeshPaths,
  collectCodexAgentMessages,
  findIntakeReceipt,
  findLiveCards,
  helpText,
  parseArgs,
  parseCodexThreadId,
} from '../../scripts/qa/live-journey.mjs';

const THREAD = '01a05ead-98e8-7091-a770-81f7339d3b29';
const MESSAGE_ID = 'b234ba88-fe4b-4f75-98b2-259c17097f41';
const DELIVERY_ID = '92f1bda2-5bd9-4da3-86f6-f083253a7ed1';
const SENTINEL = 'codex-4f19ab27';

/** `codex exec --json` output, in the shape a real turn emits it. */
function codexTurn(messages: string[], threadId: string = THREAD): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'turn.started' }),
    ...messages.map((text, index) => JSON.stringify({
      type: 'item.completed',
      item: { id: `item_${index}`, type: 'agent_message', text },
    })),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    '',
  ].join('\n');
}

const GOOD_REPLY = codexTurn([
  'Acknowledged. No action taken.',
  `CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`,
]);

const ACCEPTED_SEND = {
  message_id: MESSAGE_ID,
  delivery_id: DELIVERY_ID,
  project: 'memesh-live-journey',
  sender: 'memesh-live-journey-harness',
  recipient: THREAD,
  target_kind: 'session',
  native_delivery: {
    status: 'native_accepted',
    delivery_id: DELIVERY_ID,
    adapter_kind: 'codex-cli-queue',
    receipt: { host: 'codex-cli', status: 'queued', thread_id: THREAD },
    accepted_at: '2026-09-01 20:34:52',
  },
};

/** A `message receipts` projection: host_accept present, intake present. */
const RECEIPTS_WITH_INTAKE = [
  {
    fact_source: 'agent_host_accept',
    receipt_kind: 'host_accept',
    message_id: MESSAGE_ID,
    recipient: THREAD,
    actor: 'claude-channel',
    created_at: '2026-09-01 20:48:48',
  },
  {
    fact_source: 'agent_message_receipt',
    receipt_id: '2aef2959-ac4e-4040-9820-c84f9b33dec7',
    receipt_kind: 'intake',
    intake_state: 'ingested',
    message_id: MESSAGE_ID,
    recipient: THREAD,
    actor: THREAD,
    created_at: '2026-09-01 20:50:13',
  },
];

/** The same projection with the model's own intake missing — host_accept only. */
const RECEIPTS_WITHOUT_INTAKE = [RECEIPTS_WITH_INTAKE[0]];

describe('parseArgs', () => {
  it('accepts each supported host', () => {
    expect(parseArgs(['--host', 'codex']).host).toBe('codex');
    expect(parseArgs(['--host', 'claude']).host).toBe('claude');
  });

  it('defaults out/keep/wait-ms', () => {
    const parsed = parseArgs(['--host', 'codex']);
    expect(parsed.out).toBeNull();
    expect(parsed.keep).toBe(false);
    expect(parsed.waitMs).toBe(DEFAULT_WAIT_MS);
  });

  it('reads --out, --keep and --wait-ms', () => {
    const parsed = parseArgs(['--host', 'claude', '--out', 'report.json', '--keep', '--wait-ms', '30000']);
    expect(parsed).toMatchObject({ host: 'claude', out: 'report.json', keep: true, waitMs: 30_000 });
  });

  it('requires a host', () => {
    expect(() => parseArgs([])).toThrow(/--host is required/);
  });

  it('rejects an unsupported host rather than guessing one', () => {
    expect(() => parseArgs(['--host', 'gemini'])).toThrow(/must be codex or claude/);
  });

  it('rejects unknown arguments instead of ignoring them', () => {
    expect(() => parseArgs(['--host', 'codex', '--print'])).toThrow(/Unknown argument --print/);
  });

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArgs(['--host'])).toThrow(/--host requires a value/);
    expect(() => parseArgs(['--host', 'codex', '--out', '--keep'])).toThrow(/--out requires a value/);
  });

  it('bounds --wait-ms', () => {
    expect(() => parseArgs(['--host', 'codex', '--wait-ms', '10'])).toThrow(/between 1000 and 3600000/);
    expect(() => parseArgs(['--host', 'codex', '--wait-ms', 'soon'])).toThrow(/between 1000 and 3600000/);
  });

  it('does not demand a host when only --help was asked for', () => {
    expect(parseArgs(['--help'])).toMatchObject({ help: true, host: null });
  });
});

describe('--help', () => {
  it('says print mode is unsupported and names the issue', () => {
    const text = helpText();
    expect(text).toMatch(/claude -p/);
    expect(text).toMatch(/NOT supported/);
    expect(text).toMatch(/issue #275/);
  });

  it('states that it never touches the owner’s real memory directory', () => {
    expect(helpText()).toMatch(/\$HOME\/\.memesh/);
  });
});

describe('assertSafeMemeshPaths', () => {
  const home = '/Users/example';

  it('allows a temporary directory outside the owner’s memesh directory', () => {
    expect(() => assertSafeMemeshPaths({
      memeshDir: '/private/tmp/memesh-live-journey-abc/memesh',
      dbPath: '/private/tmp/memesh-live-journey-abc/memesh/knowledge-graph.db',
      home,
    })).not.toThrow();
  });

  it('refuses when MEMESH_DIR is the owner’s memesh directory', () => {
    expect(() => assertSafeMemeshPaths({
      memeshDir: `${home}/.memesh`,
      dbPath: '/private/tmp/x/knowledge-graph.db',
      home,
    })).toThrow(/Refusing to run: MEMESH_DIR/);
  });

  it('refuses when MEMESH_DB_PATH sits under the owner’s memesh directory', () => {
    expect(() => assertSafeMemeshPaths({
      memeshDir: '/private/tmp/x/memesh',
      dbPath: `${home}/.memesh/knowledge-graph.db`,
      home,
    })).toThrow(/Refusing to run: MEMESH_DB_PATH/);
  });

  it('refuses a path that only reaches ~/.memesh after normalisation', () => {
    expect(() => assertSafeMemeshPaths({
      memeshDir: `${home}/projects/../.memesh/hosts`,
      dbPath: '/private/tmp/x/knowledge-graph.db',
      home,
    })).toThrow(/Refusing to run/);
  });

  it('does not confuse a sibling directory with a prefix match', () => {
    expect(() => assertSafeMemeshPaths({
      memeshDir: `${home}/.memesh-scratch/memesh`,
      dbPath: `${home}/.memesh-scratch/memesh/knowledge-graph.db`,
      home,
    })).not.toThrow();
  });
});

describe('assertDistPresent', () => {
  it('names every missing artefact rather than the first one', () => {
    expect(() => assertDistPresent('/repo', () => false))
      .toThrow(/router\.js.*cli\.js.*codex-session\.js/s);
  });

  it('passes when every required artefact exists', () => {
    expect(() => assertDistPresent('/repo', () => true)).not.toThrow();
    expect(REQUIRED_DIST).toContain('dist/host-runtime/router.js');
  });
});

describe('parseCodexThreadId', () => {
  it('reads the thread id Codex printed', () => {
    expect(parseCodexThreadId(GOOD_REPLY)).toBe(THREAD);
  });

  it('fails closed when Codex started no thread', () => {
    expect(() => parseCodexThreadId('{"type":"turn.completed"}\n')).toThrow(/no `thread.started` event/);
  });

  it('ignores non-JSON noise interleaved on the stream', () => {
    expect(parseCodexThreadId(`warning: something\n${GOOD_REPLY}`)).toBe(THREAD);
  });
});

describe('collectCodexAgentMessages', () => {
  it('collects every agent message in the turn, not just the last', () => {
    expect(collectCodexAgentMessages(GOOD_REPLY)).toEqual([
      'Acknowledged. No action taken.',
      `CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`,
    ]);
  });

  it('ignores non-agent-message items such as command executions', () => {
    const withCommand = [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', command: 'ls', exit_code: 0 },
      }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'READY' } }),
    ].join('\n');
    expect(collectCodexAgentMessages(withCommand)).toEqual(['READY']);
  });
});

describe('assertCodexReply', () => {
  const expected = { sentinel: SENTINEL, messageId: MESSAGE_ID, deliveryId: DELIVERY_ID };

  it('accepts a reply quoting the sentinel and both ids', () => {
    expect(assertCodexReply({ jsonl: GOOD_REPLY, ...expected }))
      .toContain(`CODEX_RECEIVED_${SENTINEL}`);
  });

  it('rejects a reply carrying the WRONG message_id', () => {
    const wrong = codexTurn([`CODEX_RECEIVED_${SENTINEL} 00000000-0000-4000-8000-000000000000 ${DELIVERY_ID}`]);
    expect(() => assertCodexReply({ jsonl: wrong, ...expected }))
      .toThrow(/does not quote message_id b234ba88/);
  });

  it('rejects a reply with the sentinel but no ids at all', () => {
    expect(() => assertCodexReply({ jsonl: codexTurn([`CODEX_RECEIVED_${SENTINEL}`]), ...expected }))
      .toThrow(/does not quote message_id/);
  });

  it('rejects a reply carrying the wrong delivery_id', () => {
    const wrong = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} 11111111-1111-4111-8111-111111111111`]);
    expect(() => assertCodexReply({ jsonl: wrong, ...expected }))
      .toThrow(/does not quote delivery_id/);
  });

  it('rejects NO_ENVELOPE with the reason, not a generic mismatch', () => {
    expect(() => assertCodexReply({ jsonl: codexTurn(['NO_ENVELOPE']), ...expected }))
      .toThrow(/not visible to the model/);
  });

  it('rejects a turn that produced no agent message', () => {
    expect(() => assertCodexReply({ jsonl: '{"type":"turn.completed"}', ...expected }))
      .toThrow(/no agent message/);
  });
});

describe('assertNativeAccepted', () => {
  it('accepts a send whose exact session took the frame', () => {
    expect(assertNativeAccepted(ACCEPTED_SEND, 'codex-cli-queue'))
      .toMatchObject({ messageId: MESSAGE_ID, deliveryId: DELIVERY_ID });
  });

  it('rejects a durable send with NO native_delivery block', () => {
    const { native_delivery: _dropped, ...durableOnly } = ACCEPTED_SEND;
    expect(() => assertNativeAccepted(durableOnly, 'codex-cli-queue'))
      .toThrow(/no native_delivery block/);
  });

  it('rejects a send whose native delivery was not accepted', () => {
    const unavailable = {
      ...ACCEPTED_SEND,
      native_delivery: { ...ACCEPTED_SEND.native_delivery, status: 'recipient_unavailable' },
    };
    expect(() => assertNativeAccepted(unavailable, 'codex-cli-queue'))
      .toThrow(/not "native_accepted"/);
  });

  it('rejects acceptance by the wrong adapter', () => {
    expect(() => assertNativeAccepted(ACCEPTED_SEND, 'claude-channel'))
      .toThrow(/adapter_kind is "codex-cli-queue"/);
  });

  it('rejects a result that is not an object', () => {
    expect(() => assertNativeAccepted('ok', 'codex-cli-queue')).toThrow(/no JSON object/);
  });
});

describe('assertRecipientUnavailable', () => {
  it('accepts a non-zero exit naming recipient_unavailable', () => {
    expect(() => assertRecipientUnavailable({
      status: 1,
      stderr: 'Error: recipient_unavailable: the exact active session did not accept the native message.\n',
    })).not.toThrow();
  });

  it('rejects a send to a stopped session that SUCCEEDED', () => {
    expect(() => assertRecipientUnavailable({ status: 0, stderr: '' }))
      .toThrow(/did not fail closed/);
  });

  it('rejects a different failure wearing a non-zero exit code', () => {
    expect(() => assertRecipientUnavailable({ status: 1, stderr: 'Error: native_message_too_large' }))
      .toThrow(/Expected recipient_unavailable/);
  });
});

describe('intake receipts', () => {
  it('finds the intake the recipient session wrote', () => {
    expect(findIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: MESSAGE_ID, actor: THREAD }))
      .toMatchObject({ receipt_kind: 'intake', actor: THREAD });
  });

  it('rejects a projection carrying host_accept but NO intake', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITHOUT_INTAKE, { messageId: MESSAGE_ID, actor: THREAD }))
      .toThrow(/No intake receipt written by/);
  });

  it('rejects an intake written by a different session', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: MESSAGE_ID, actor: 'someone-else' }))
      .toThrow(/No intake receipt written by someone-else/);
  });

  it('rejects an intake for a different message', () => {
    expect(() => assertIntakeReceipt(RECEIPTS_WITH_INTAKE, { messageId: 'other-message', actor: THREAD }))
      .toThrow(/No intake receipt/);
  });

  it('treats an empty projection as no proof', () => {
    expect(findIntakeReceipt([], { messageId: MESSAGE_ID, actor: THREAD })).toBeNull();
    expect(findIntakeReceipt(null, { messageId: MESSAGE_ID, actor: THREAD })).toBeNull();
  });
});

describe('findLiveCards', () => {
  const discovered = {
    cards: [
      { session_id: THREAD, principal_id: 'codex-live-journey', host_kind: 'codex', active: true, generation: 1 },
      { session_id: 'abc', principal_id: 'claude-live-journey', host_kind: 'claude', active: true, generation: 1 },
    ],
  };

  it('filters by host kind', () => {
    expect(findLiveCards(discovered, { hostKind: 'claude' }).map((card) => card.session_id)).toEqual(['abc']);
  });

  it('filters by session id', () => {
    expect(findLiveCards(discovered, { sessionId: THREAD })).toHaveLength(1);
  });

  it('returns nothing for a router answer with no cards array', () => {
    expect(findLiveCards({}, { hostKind: 'claude' })).toEqual([]);
    expect(findLiveCards(null)).toEqual([]);
  });
});
