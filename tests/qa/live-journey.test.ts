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

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WAIT_MS,
  MAX_SOCKET_PATH_BYTES,
  REQUIRED_DIST,
  assertCodexRanNoCommands,
  assertCodexReply,
  assertDistPresent,
  assertIntakeReceipt,
  assertNativeAccepted,
  assertNotCi,
  assertSupportedPlatform,
  assertOutsideOwnerMemesh,
  assertRecipientUnavailable,
  assertSocketPathFits,
  awaitSessionDisconnect,
  collectCodexAgentMessages,
  findIntakeReceipt,
  findLiveCards,
  helpText,
  isDistStale,
  parseArgs,
  parseCodexThreadId,
  realpathAsFarAsPossible,
  shouldRemoveWorkingDirectories,
} from '../../scripts/qa/live-journey.mjs';

const THREAD = '01a05ead-98e8-7091-a770-81f7339d3b29';
const MESSAGE_ID = 'b234ba88-fe4b-4f75-98b2-259c17097f41';
const DELIVERY_ID = '92f1bda2-5bd9-4da3-86f6-f083253a7ed1';
const SENTINEL = 'codex-4f19ab27';

/** `codex exec --json` output, in the shape a real turn emits it. */
function codexTurn(
  messages: string[],
  options: { threadId?: string; extraItems?: Record<string, unknown>[] } = {},
): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: options.threadId ?? THREAD }),
    JSON.stringify({ type: 'turn.started' }),
    ...messages.map((text, index) => JSON.stringify({
      type: 'item.completed',
      item: { id: `item_${index}`, type: 'agent_message', text },
    })),
    ...(options.extraItems ?? []).map((item) => JSON.stringify({ type: 'item.completed', item })),
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

  it('discloses the harness-driven Codex registration', () => {
    expect(helpText()).toMatch(/registration is harness-driven/);
  });

  it('warns that the launched Claude session is outside the isolation', () => {
    const text = helpText();
    expect(text).toMatch(/OUTSIDE the temporary-directory isolation/);
    expect(text).toMatch(/would write the REAL ~\/\.memesh/);
    expect(text).toMatch(/\/hooks and \/mcp/);
  });

  it('names the invocation that was actually verified', () => {
    expect(helpText()).toMatch(/TMPDIR=\/private\/tmp npm run qa:live-journey/);
  });
});

// POSIX path literals below: on Windows `path.resolve('/Users/example')` gains a
// drive letter and never matches the fixture, and `/tmp` does not exist. The
// runtime under test is macOS/Linux only, so this follows the repo's idiom.
describe.skipIf(process.platform === 'win32')('assertOutsideOwnerMemesh', () => {
  const home = '/Users/example';
  const identity = (candidate: string) => candidate;

  it('allows a temporary directory outside the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: {
        MEMESH_DIR: '/private/tmp/memesh-lj-abc/memesh',
        MEMESH_DB_PATH: '/private/tmp/memesh-lj-abc/memesh/knowledge-graph.db',
      },
      home,
      realpath: identity,
    })).not.toThrow();
  });

  it('refuses when MEMESH_DIR is the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DIR: `${home}/.memesh` },
      home,
      realpath: identity,
    })).toThrow(/Refusing to run: MEMESH_DIR/);
  });

  it('refuses when MEMESH_DB_PATH sits under the owner’s memesh directory', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DB_PATH: `${home}/.memesh/knowledge-graph.db` },
      home,
      realpath: identity,
    })).toThrow(/Refusing to run: MEMESH_DB_PATH/);
  });

  it('refuses a SYMLINKED temp root that really lands in ~/.memesh', () => {
    // The case a resolve-only prefix test cannot see: the literal path is
    // outside, the real path is inside, and deleting it would destroy memory.
    const realpath = (candidate: string) => (
      candidate.startsWith('/private/tmp/looks-safe')
        ? candidate.replace('/private/tmp/looks-safe', `${home}/.memesh/hidden`)
        : candidate
    );
    expect(() => assertOutsideOwnerMemesh({
      candidates: { TMPDIR: '/private/tmp/looks-safe' },
      home,
      realpath,
    })).toThrow(/Refusing to run: TMPDIR/);
  });

  it('does not confuse a sibling directory with a prefix match', () => {
    expect(() => assertOutsideOwnerMemesh({
      candidates: { MEMESH_DIR: `${home}/.memesh-scratch/memesh` },
      home,
      realpath: identity,
    })).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('realpathAsFarAsPossible', () => {
  it('resolves an existing directory', () => {
    expect(realpathAsFarAsPossible('/tmp')).toBe(fs.realpathSync('/tmp'));
  });

  it('resolves the existing ancestor of a path that does not exist yet', () => {
    const resolved = realpathAsFarAsPossible('/tmp/memesh-lj-does-not-exist-yet/memesh');
    expect(resolved).toBe(path.join(fs.realpathSync('/tmp'), 'memesh-lj-does-not-exist-yet', 'memesh'));
  });
});

describe('assertSupportedPlatform', () => {
  it('refuses on Windows, naming the documented boundary', () => {
    expect(() => assertSupportedPlatform('win32')).toThrow(/macOS\/Linux only/);
  });

  it('allows the platforms the host-native runtime supports', () => {
    expect(() => assertSupportedPlatform('darwin')).not.toThrow();
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });
});

describe('assertNotCi', () => {
  it('allows an ordinary owner shell', () => {
    expect(() => assertNotCi({})).not.toThrow();
    expect(() => assertNotCi({ CI: '' })).not.toThrow();
    expect(() => assertNotCi({ CI: 'false' })).not.toThrow();
  });

  it('refuses under CI, where neither host can exist', () => {
    expect(() => assertNotCi({ CI: 'true' })).toThrow(/Refusing to run: CI is set/);
    expect(() => assertNotCi({ CI: '1' })).toThrow(/Refusing to run: CI is set/);
  });
});

describe('assertSocketPathFits', () => {
  it('accepts a short temporary root', () => {
    expect(() => assertSocketPathFits('/private/tmp/memesh-lj-abc123/memesh/agent-router.sock')).not.toThrow();
  });

  it('refuses a path over the AF_UNIX limit and names the fix', () => {
    const tooLong = `/private/tmp/${'d'.repeat(MAX_SOCKET_PATH_BYTES)}/memesh/agent-router.sock`;
    expect(() => assertSocketPathFits(tooLong)).toThrow(/TMPDIR=\/private\/tmp/);
  });

  it('measures bytes, not characters', () => {
    // 61 characters — comfortably under the limit — but 121 UTF-8 bytes, which
    // is what the kernel counts. A `.length` check would pass this.
    const twoByteChars = `/${'é'.repeat(60)}`;
    expect(twoByteChars.length).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(twoByteChars, 'utf8')).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(() => assertSocketPathFits(twoByteChars)).toThrow(/AF_UNIX limit/);
  });
});

describe('isDistStale', () => {
  it('is stale when any dist artefact predates the newest source file', () => {
    expect(isDistStale({ newestSrcMs: 2_000, oldestDistMs: 1_000 })).toBe(true);
  });

  it('is fresh when every dist artefact is at least as new as the newest source', () => {
    expect(isDistStale({ newestSrcMs: 1_000, oldestDistMs: 1_000 })).toBe(false);
    expect(isDistStale({ newestSrcMs: 1_000, oldestDistMs: 2_000 })).toBe(false);
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

  it('rejects an otherwise-perfect reply from a turn that ran a command', () => {
    const withCommand = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{ id: 'item_9', type: 'command_execution', command: 'cat turn1.jsonl', exit_code: 0 }],
    });
    expect(() => assertCodexReply({ jsonl: withCommand, ...expected }))
      .toThrow(/non-answer items \(item:command_execution\)/);
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

describe('assertCodexRanNoCommands', () => {
  it('accepts a turn that only answered', () => {
    expect(() => assertCodexRanNoCommands(GOOD_REPLY)).not.toThrow();
  });

  it('tolerates Codex’s own error notices, which are not model actions', () => {
    const withNotice = codexTurn(['READY'], {
      extraItems: [{ id: 'item_9', type: 'error', message: 'Skill descriptions were shortened.' }],
    });
    expect(() => assertCodexRanNoCommands(withNotice)).not.toThrow();
  });

  it('REJECTS a turn that ran a command — the model could have read the ids off disk', () => {
    const withCommand = codexTurn([`CODEX_RECEIVED_${SENTINEL} ${MESSAGE_ID} ${DELIVERY_ID}`], {
      extraItems: [{
        id: 'item_9',
        type: 'command_execution',
        command: '/bin/zsh -lc \'cat ../memesh/knowledge-graph.db\'',
        exit_code: 0,
      }],
    });
    expect(() => assertCodexRanNoCommands(withCommand)).toThrow(/command_execution/);
  });

  it('rejects an unrecognised item type rather than assuming it is harmless', () => {
    const withTool = codexTurn(['ok'], { extraItems: [{ id: 'item_9', type: 'mcp_tool_call', name: 'read_file' }] });
    expect(() => assertCodexRanNoCommands(withTool)).toThrow(/mcp_tool_call/);
  });

  it('tolerates a reasoning item — thinking is not a model action', () => {
    const withReasoning = codexTurn(['ok'], { extraItems: [{ id: 'item_9', type: 'reasoning', text: 'considering' }] });
    expect(() => assertCodexRanNoCommands(withReasoning)).not.toThrow();
  });

  it('rejects an unrecognised EVENT type, not only an unrecognised item type', () => {
    // A native tool surfaced under some event other than item.* must not slip
    // past an item-only scan.
    const withForeignEvent = `${GOOD_REPLY}\n${JSON.stringify({ type: 'tool.call', name: 'read_file', path: '../memesh/knowledge-graph.db' })}`;
    expect(() => assertCodexRanNoCommands(withForeignEvent)).toThrow(/event:tool\.call/);
  });

  it('rejects a command that only STARTED (item.started) even if it never completed', () => {
    const withStartedCommand = `${GOOD_REPLY}\n${JSON.stringify({ type: 'item.started', item: { id: 'item_9', type: 'command_execution', command: 'cat x' } })}`;
    expect(() => assertCodexRanNoCommands(withStartedCommand)).toThrow(/item:command_execution/);
  });
});

describe('assertNativeAccepted', () => {
  it('accepts a send whose exact session took the frame', () => {
    expect(assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toMatchObject({ messageId: MESSAGE_ID, deliveryId: DELIVERY_ID });
  });

  it('rejects a durable send with NO native_delivery block', () => {
    const { native_delivery: _dropped, ...durableOnly } = ACCEPTED_SEND;
    expect(() => assertNativeAccepted(durableOnly, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/no native_delivery block/);
  });

  it('rejects a send whose native delivery was not accepted', () => {
    const unavailable = {
      ...ACCEPTED_SEND,
      native_delivery: { ...ACCEPTED_SEND.native_delivery, status: 'recipient_unavailable' },
    };
    expect(() => assertNativeAccepted(unavailable, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/not "native_accepted"/);
  });

  it('rejects acceptance by the wrong adapter', () => {
    expect(() => assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'claude-channel', recipient: THREAD }))
      .toThrow(/adapter_kind is "codex-cli-queue"/);
  });

  it('rejects an acceptance whose delivery_id belongs to a different delivery', () => {
    const mismatched = {
      ...ACCEPTED_SEND,
      native_delivery: { ...ACCEPTED_SEND.native_delivery, delivery_id: 'ffffffff-0000-4000-8000-000000000000' },
    };
    expect(() => assertNativeAccepted(mismatched, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/describes a different delivery/);
  });

  it('rejects a host receipt naming a different thread', () => {
    const wrongThread = {
      ...ACCEPTED_SEND,
      native_delivery: {
        ...ACCEPTED_SEND.native_delivery,
        receipt: { ...ACCEPTED_SEND.native_delivery.receipt, thread_id: 'ffffffff-0000-4000-8000-000000000000' },
      },
    };
    expect(() => assertNativeAccepted(wrongThread, { adapterKind: 'codex-cli-queue', recipient: THREAD }))
      .toThrow(/not the session we addressed/);
  });

  it('rejects a send whose recipient is not the session we addressed', () => {
    expect(() => assertNativeAccepted(ACCEPTED_SEND, { adapterKind: 'codex-cli-queue', recipient: 'someone-else' }))
      .toThrow(/reports recipient/);
  });

  it('rejects a result that is not an object', () => {
    expect(() => assertNativeAccepted('ok', { adapterKind: 'codex-cli-queue', recipient: THREAD })).toThrow(/no JSON object/);
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

  it('rejects a KILLED send process — no exit status is not a decision', () => {
    expect(() => assertRecipientUnavailable({ status: null, stderr: 'recipient_unavailable' }))
      .toThrow(/killed before it produced an exit status/);
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

describe('shutdown decision', () => {
  const noSleep = () => Promise.resolve();

  it('is immediately safe when no session was ever registered', async () => {
    const announce = vi.fn();
    await expect(awaitSessionDisconnect({
      sessionId: null,
      isGone: () => false,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce,
    })).resolves.toBe(true);
    expect(announce).not.toHaveBeenCalled();
  });

  it('is safe once the session has left the router directory', async () => {
    let calls = 0;
    await expect(awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => (calls += 1) > 2,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce: () => {},
    })).resolves.toBe(true);
  });

  it('tells the operator what to do, once, while it waits', async () => {
    let calls = 0;
    const announce = vi.fn();
    await awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => (calls += 1) > 3,
      waitMs: 30_000,
      now: () => 0,
      sleep: noSleep,
      announce,
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toMatch(/detached replacement/);
  });

  it('is NOT safe when the session is still connected at the bound', async () => {
    // The orphan case: a connected host whose router disappears spawns a
    // detached replacement that recreates this very directory.
    let clock = 0;
    await expect(awaitSessionDisconnect({
      sessionId: 'abc',
      isGone: () => false,
      waitMs: 5_000,
      now: () => (clock += 2_000),
      sleep: noSleep,
      announce: () => {},
    })).resolves.toBe(false);
  });

  it('keeps the directory when a session is still connected, and removes it otherwise', () => {
    expect(shouldRemoveWorkingDirectories({ keep: false, keptForSafety: false })).toBe(true);
    expect(shouldRemoveWorkingDirectories({ keep: false, keptForSafety: true })).toBe(false);
    expect(shouldRemoveWorkingDirectories({ keep: true, keptForSafety: false })).toBe(false);
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
