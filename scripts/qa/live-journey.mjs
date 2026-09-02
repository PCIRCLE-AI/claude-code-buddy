#!/usr/bin/env node

// Owner-run, repeatable live-journey checks for the two host-native delivery
// paths: an ordinary Codex CLI thread (issue #270) and a Claude Code session
// with the memesh-channel development channel admitted (issue #272).
//
// WHY THIS EXISTS, AND WHY IT IS NOT A TEST
//
// `scripts/smoke-packed-artifact.mjs` proves the installed router and adapter
// plumbing with a fake `codex` executable and a stubbed `connectRouterHost()`.
// That is real evidence of the plumbing and no evidence at all that a live
// model ever saw a message. Both issues asked for the missing half: a check
// that binds a REAL active session identity, sends one exact-session message,
// and then requires proof that came out of the model rather than out of the
// database.
//
// The proof shape differs per host, because the two hosts expose different
// model-visible surfaces:
//
//   codex  — the next turn's reply must quote the `message_id` and
//            `delivery_id` from the injected envelope. Neither id exists
//            anywhere in the prompt, so a reply containing them cannot have
//            been produced without reading the envelope.
//   claude — the session's own model must call `intake` on that message. The
//            intake receipt is written by the recipient session, not by this
//            harness, so its presence is model-visible proof.
//
// This cannot run in CI. It needs the owner's Codex login, or a human at an
// interactive Claude session. It is deliberately a script under `scripts/qa/`
// and NOT a file under `tests/` — a check that cannot run unattended must not
// sit where an unattended runner will find it. The parts that CAN be checked
// without a live host (argument parsing, the path refusal, every assertion
// applied to recorded fixtures) are exported from here and exercised by
// `tests/qa/live-journey.test.ts`.
//
// SAFETY BOUNDARY
//
// Everything MeMesh writes goes to a fresh `mktemp` MEMESH_DIR that is deleted
// on exit. The script refuses to run against `$HOME/.memesh`. It reads no auth
// files: the Codex precondition is `codex login status`, whose exit code is the
// answer. It writes no host configuration outside the temp directory.
//
// The one thing it touches outside the temp directory is the owner's Codex
// rollout store: `codex exec` creates one throwaway thread there and
// `codex queue` appends one message to it. That is the product path under
// test, it is session state rather than configuration, and it is disclosed in
// the report's `limitations`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'memesh-live-journey';
export const DEFAULT_WAIT_MS = 300_000;

/** dist artefacts this check runs. Missing any of them is a refusal, not a skip. */
export const REQUIRED_DIST = [
  'dist/host-runtime/router.js',
  'dist/transports/cli/cli.js',
  'dist/host-runtime/codex-session.js',
  'dist/host-runtime/claude.js',
  'dist/mcp/server.js',
];

export function helpText() {
  return [
    'memesh qa:live-journey — owner-run live host-native delivery checks',
    '',
    'Usage:',
    '  npm run qa:live-journey -- --host codex  [--out report.json] [--keep] [--wait-ms N]',
    '  npm run qa:live-journey -- --host claude [--out report.json] [--keep] [--wait-ms N]',
    '',
    'Options:',
    '  --host <codex|claude>  Which live path to exercise. Required.',
    '  --out <path>           Write the JSON evidence report here (also written on failure).',
    '  --keep                 Keep the temporary MEMESH_DIR instead of deleting it on exit.',
    `  --wait-ms <N>          Bound for each wait on the operator or the model, default ${DEFAULT_WAIT_MS}.`,
    '                         Only --host claude waits on a person; the codex path is unattended.',
    '  --help                 Print this text.',
    '',
    'Preconditions:',
    '  codex   — `codex` on PATH and `codex login status` reporting a logged-in owner.',
    '            Costs one or two small Codex turns. Creates one throwaway Codex thread.',
    '  claude  — `claude` on PATH, and the owner launching one interactive session with',
    '            the command this script prints. Print mode (`claude -p`) is NOT supported:',
    '            a print-mode session does not surface memesh-channel notifications to the',
    '            model even when the channel host reports the frame accepted (issue #275),',
    '            so it can never produce the model-visible proof this check requires.',
    '',
    'This check never runs in CI, never touches $HOME/.memesh, and reads no auth files.',
  ].join('\n');
}

/**
 * @param {string[]} argv arguments after the script path
 * @returns {{help: boolean, host: string|null, out: string|null, keep: boolean, waitMs: number}}
 */
export function parseArgs(argv) {
  const parsed = { help: false, host: null, out: null, keep: false, waitMs: DEFAULT_WAIT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    if (flag === '--help' || flag === '-h') parsed.help = true;
    else if (flag === '--keep') parsed.keep = true;
    else if (flag === '--host') parsed.host = value();
    else if (flag === '--out') parsed.out = value();
    else if (flag === '--wait-ms') {
      const raw = Number(value());
      if (!Number.isSafeInteger(raw) || raw < 1_000 || raw > 3_600_000) {
        throw new Error('--wait-ms must be a whole number of milliseconds between 1000 and 3600000.');
      }
      parsed.waitMs = raw;
    } else throw new Error(`Unknown argument ${flag}. Run with --help.`);
  }
  if (parsed.help) return parsed;
  if (parsed.host === null) throw new Error('--host is required (codex | claude). Run with --help.');
  if (parsed.host !== 'codex' && parsed.host !== 'claude') {
    throw new Error(`--host must be codex or claude, not ${parsed.host}.`);
  }
  return parsed;
}

/**
 * Refuse to run against the owner's real knowledge graph. A live check writes
 * messages, registers hosts and then deletes its whole data directory; pointed
 * at `~/.memesh` that is data loss, not a check.
 *
 * @param {{memeshDir: string, dbPath: string, home: string}} input
 */
export function assertSafeMemeshPaths(input) {
  const home = path.resolve(input.home);
  const forbidden = path.join(home, '.memesh');
  for (const [label, candidate] of [['MEMESH_DIR', input.memeshDir], ['MEMESH_DB_PATH', input.dbPath]]) {
    const resolved = path.resolve(candidate);
    if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(
        `Refusing to run: ${label} resolves to ${resolved}, inside the owner's ${forbidden}. `
        + 'This check creates and deletes its own data directory and must never be pointed at real memory.',
      );
    }
  }
}

/**
 * @param {string} repoRoot
 * @param {(file: string) => boolean} [exists] injectable for tests
 */
export function assertDistPresent(repoRoot, exists = (file) => fs.existsSync(file)) {
  const missing = REQUIRED_DIST.filter((relative) => !exists(path.join(repoRoot, relative)));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run: this repository has no built dist/ for ${missing.join(', ')}. Run \`npm run build\` first.`,
    );
  }
}

/** @param {string} text JSONL as emitted by `codex exec --json` */
export function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // A partial or interleaved line is not evidence of anything; the
      // assertions below fail closed when the event they need is absent.
    }
  }
  return events;
}

/** @param {string} text @returns {string} the thread id Codex printed */
export function parseCodexThreadId(text) {
  for (const event of parseJsonl(text)) {
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0) {
      return event.thread_id;
    }
  }
  throw new Error('Codex emitted no `thread.started` event, so there is no thread to register.');
}

/** @param {string} text @returns {string[]} every agent_message this turn produced */
export function collectCodexAgentMessages(text) {
  const messages = [];
  for (const event of parseJsonl(text)) {
    const item = event?.item;
    if (event?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text);
    }
  }
  return messages;
}

/**
 * The model-visible half of the Codex claim.
 *
 * The prompt that produced this reply names neither the sentinel nor either id
 * — it only says "substitute the values from that envelope". So a reply
 * carrying the exact `message_id` is proof the envelope reached the model. The
 * sentinel alone is not: it is the only one of the three a model could in
 * principle guess from context, which is why `message_id` is required too.
 *
 * @param {{jsonl: string, sentinel: string, messageId: string, deliveryId: string}} input
 */
export function assertCodexReply(input) {
  const messages = collectCodexAgentMessages(input.jsonl);
  if (messages.length === 0) throw new Error('Codex produced no agent message on the resume turn.');
  const joined = messages.join('\n');
  if (/\bNO_ENVELOPE\b/.test(joined)) {
    throw new Error('Codex replied NO_ENVELOPE: the queued envelope was not visible to the model.');
  }
  const token = `CODEX_RECEIVED_${input.sentinel}`;
  if (!joined.includes(token)) {
    throw new Error(`Codex reply does not contain ${token}. Reply was: ${joined}`);
  }
  if (!joined.includes(input.messageId)) {
    throw new Error(
      `Codex reply does not quote message_id ${input.messageId}; without it the sentinel proves nothing. Reply was: ${joined}`,
    );
  }
  if (!joined.includes(input.deliveryId)) {
    throw new Error(`Codex reply does not quote delivery_id ${input.deliveryId}. Reply was: ${joined}`);
  }
  return joined;
}

/**
 * `send` returning a message row is NOT delivery. Only
 * `native_delivery.status === "native_accepted"` means a host took the frame.
 *
 * @param {unknown} result parsed `message send` stdout
 * @param {string} expectedAdapterKind
 */
export function assertNativeAccepted(result, expectedAdapterKind) {
  if (result === null || typeof result !== 'object') throw new Error('message send returned no JSON object.');
  const record = /** @type {Record<string, unknown>} */ (result);
  const native = record.native_delivery;
  if (native === null || typeof native !== 'object') {
    throw new Error('message send returned no native_delivery block, so nothing proves a host accepted it.');
  }
  const nativeRecord = /** @type {Record<string, unknown>} */ (native);
  if (nativeRecord.status !== 'native_accepted') {
    throw new Error(`native_delivery.status is ${JSON.stringify(nativeRecord.status)}, not "native_accepted".`);
  }
  if (nativeRecord.adapter_kind !== expectedAdapterKind) {
    throw new Error(
      `native_delivery.adapter_kind is ${JSON.stringify(nativeRecord.adapter_kind)}, not ${JSON.stringify(expectedAdapterKind)}.`,
    );
  }
  if (typeof record.message_id !== 'string' || typeof record.delivery_id !== 'string') {
    throw new Error('message send returned no message_id/delivery_id pair.');
  }
  return { messageId: record.message_id, deliveryId: record.delivery_id, native: nativeRecord };
}

/**
 * The failure path. `recipient_unavailable` is a SHARED failure surface: the
 * same string comes back when the sender cannot reach the router at all. So
 * the caller must pair this with proof that the router is still answering and
 * the durable row survived — see `runCodex`/`runClaude`, which assert both.
 *
 * @param {{status: number|null, stderr: string}} outcome
 */
export function assertRecipientUnavailable(outcome) {
  if (outcome.status === 0) {
    throw new Error('Sending to the stopped session succeeded; the exact-session target did not fail closed.');
  }
  if (!/recipient_unavailable/.test(outcome.stderr)) {
    throw new Error(`Expected recipient_unavailable on stderr, got: ${outcome.stderr.trim() || '<empty>'}`);
  }
}

/**
 * @param {unknown} receipts parsed `message receipts` stdout
 * @param {{messageId: string, actor: string}} expected
 */
export function findIntakeReceipt(receipts, expected) {
  if (!Array.isArray(receipts)) return null;
  return receipts.find((fact) => (
    fact !== null && typeof fact === 'object'
    && fact.receipt_kind === 'intake'
    && fact.message_id === expected.messageId
    && fact.actor === expected.actor
  )) ?? null;
}

/**
 * @param {unknown} receipts
 * @param {{messageId: string, actor: string}} expected
 */
export function assertIntakeReceipt(receipts, expected) {
  const found = findIntakeReceipt(receipts, expected);
  if (!found) {
    throw new Error(
      `No intake receipt written by ${expected.actor} for message ${expected.messageId}. `
      + 'host_accept alone proves the channel took the frame, not that the model read it.',
    );
  }
  return found;
}

/**
 * @param {unknown} discovered parsed `message discover` stdout
 * @param {{hostKind?: string, sessionId?: string}} filter
 */
export function findLiveCards(discovered, filter = {}) {
  const cards = discovered !== null && typeof discovered === 'object'
    ? /** @type {Record<string, unknown>} */ (discovered).cards
    : undefined;
  if (!Array.isArray(cards)) return [];
  return cards.filter((card) => (
    card !== null && typeof card === 'object'
    && (filter.hostKind === undefined || card.host_kind === filter.hostKind)
    && (filter.sessionId === undefined || card.session_id === filter.sessionId)
  ));
}

// ---------------------------------------------------------------------------
// Everything below performs I/O and is exercised by the live run, not by tests.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function dist(relative) {
  return path.join(repoRoot, relative);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** One live-journey run: owns the temp directory, the child processes and the report. */
class Journey {
  constructor(options) {
    this.options = options;
    this.steps = [];
    this.limitations = [];
    this.children = [];
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-live-journey-'));
    this.memeshDir = path.join(this.dir, 'memesh');
    this.dbPath = path.join(this.memeshDir, 'knowledge-graph.db');
    assertSafeMemeshPaths({ memeshDir: this.memeshDir, dbPath: this.dbPath, home: os.homedir() });
    fs.mkdirSync(this.memeshDir, { recursive: true, mode: 0o700 });
    this.env = { ...process.env, MEMESH_DIR: this.memeshDir, MEMESH_DB_PATH: this.dbPath };
    this.socketPath = path.join(this.memeshDir, 'agent-router.sock');
    /** Set by the accepted send; the fail-closed step fetches this exact row back. */
    this.lastDurableMessageId = null;
  }

  step(name, evidence) {
    this.steps.push({ step: this.steps.length + 1, name, status: 'PASS', at: new Date().toISOString(), ...evidence });
    process.stdout.write(`  ok   ${name}\n`);
  }

  note(text) {
    this.limitations.push(text);
  }

  say(text) {
    process.stdout.write(`${text}\n`);
  }

  cli(args, options = {}) {
    return run(process.execPath, [dist('dist/transports/cli/cli.js'), ...args], { env: this.env, ...options });
  }

  cliJson(args, options = {}) {
    const outcome = this.cli(args, options);
    if (outcome.status !== 0) {
      throw new Error(`memesh ${args.join(' ')} exited ${outcome.status}: ${outcome.stderr.trim() || outcome.stdout.trim()}`);
    }
    try {
      return JSON.parse(outcome.stdout);
    } catch {
      throw new Error(`memesh ${args.join(' ')} did not print JSON: ${outcome.stdout.slice(0, 400)}`);
    }
  }

  discover() {
    return this.cliJson(['message', 'discover', '--project', PROJECT]);
  }

  startRouter() {
    const log = fs.openSync(path.join(this.dir, 'router.log'), 'a');
    const child = spawn(process.execPath, [dist('dist/host-runtime/router.js')], {
      env: this.env,
      stdio: ['ignore', log, log],
    });
    this.children.push({ name: 'router', child });
    return child;
  }

  async waitForRouterSocket(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(this.socketPath)) return;
      await sleep(200);
    }
    throw new Error(`The router did not create ${this.socketPath} within ${timeoutMs} ms.`);
  }

  /**
   * Poll a predicate until it holds or the bound expires. `describe` is what
   * the failure says, so it must name the thing that did not happen — never a
   * generic timeout.
   */
  async until(describe, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(1_000);
    }
    throw new Error(`${describe} (waited ${Math.round(timeoutMs / 1000)} s)`);
  }

  send(recipient, sentinel, idempotencyKey) {
    const payload = JSON.stringify({
      qa_sentinel: sentinel,
      instruction: 'No action required. MeMesh owner-run live journey check; run no commands.',
    });
    return this.cli([
      'message', 'send',
      '--project', PROJECT,
      '--sender', 'memesh-live-journey-harness',
      '--recipient', recipient,
      '--target-kind', 'session',
      '--idempotency-key', idempotencyKey,
      '--payload-stdin',
      '--content-type', 'application/json',
      '--privacy', 'private',
    ], { input: payload });
  }

  sendAccepted(recipient, sentinel, idempotencyKey, adapterKind) {
    const outcome = this.send(recipient, sentinel, idempotencyKey);
    if (outcome.status !== 0) {
      throw new Error(`message send exited ${outcome.status}: ${outcome.stderr.trim()}`);
    }
    return assertNativeAccepted(JSON.parse(outcome.stdout), adapterKind);
  }

  /**
   * The fail-closed half. `recipient_unavailable` is returned both when the
   * recipient session is gone AND when the sender cannot reach the router, so
   * proving the intended cause needs two more facts in the same breath: the
   * router still answers `discover`, and the durable payload is still fetchable.
   */
  provesFailClosed(recipient, sentinel) {
    const outcome = this.send(recipient, sentinel, `${sentinel}-after-stop`);
    assertRecipientUnavailable(outcome);
    // Both of these are part of the same assertion, not decoration. Without
    // them a dead router produces the identical `recipient_unavailable` string
    // and this step would pass for the wrong reason.
    const stillLive = this.discover();
    if (!Array.isArray(stillLive?.cards)) {
      throw new Error('The router stopped answering `discover`, so recipient_unavailable cannot be attributed to the recipient.');
    }
    const durable = this.cliJson([
      'message', 'fetch',
      '--project', PROJECT,
      '--recipient', recipient,
      '--target-kind', 'session',
      '--message-id', this.lastDurableMessageId,
    ]);
    if (durable?.payload?.qa_sentinel !== sentinel) {
      throw new Error(
        `Durable recovery broke: fetching ${this.lastDurableMessageId} as the stopped session returned `
        + `${JSON.stringify(durable?.payload?.qa_sentinel)} instead of ${JSON.stringify(sentinel)}.`,
      );
    }
    return {
      send_stderr: outcome.stderr.trim(),
      router_still_answering_discover: true,
      durable_message_still_fetchable_after_disconnect: this.lastDurableMessageId,
    };
  }

  cleanup() {
    for (const { child } of this.children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // A child that already exited is the outcome we wanted.
      }
    }
    if (this.options.keep) {
      process.stdout.write(`\nKept working directory: ${this.dir}\n`);
      return;
    }
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`Could not remove ${this.dir}: ${error.message}\n`);
    }
  }
}

async function runCodex(journey) {
  const version = run('codex', ['--version']);
  if (version.status !== 0) {
    throw new Error('`codex` is not on PATH. This check needs the owner\'s Codex CLI installed.');
  }
  const login = run('codex', ['login', 'status']);
  if (login.status !== 0) {
    throw new Error('`codex login status` reports the owner is not logged in. Run `codex login` first.');
  }
  journey.step('codex preconditions', {
    codex_version: version.stdout.trim(),
    login_status_exit_code: login.status,
  });

  journey.startRouter();
  await journey.waitForRouterSocket();
  journey.step('router started against the temporary MEMESH_DIR', { socket_path: journey.socketPath });

  const workspaceDir = path.join(journey.dir, 'codex-workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  // realpath because the companion realpaths both its configured workspace and the
  // SessionStart `cwd` before it will register; on macOS os.tmpdir() is a symlink.
  const workspace = fs.realpathSync(workspaceDir);
  const setup = journey.cliJson([
    'agent', 'setup', 'codex-session',
    '--project', PROJECT,
    '--principal', 'codex-live-journey',
    '--workspace', workspace,
    '--json',
  ]);
  journey.step('agent setup codex-session', { config_path: setup.config_path, mode: setup.mode });

  const first = run('codex', [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-s', 'read-only', '-C', workspace, 'Reply with exactly READY',
  ], { timeout: 180_000 });
  if (first.status !== 0) {
    throw new Error(`codex exec exited ${first.status}: ${first.stderr.trim().slice(0, 600)}`);
  }
  fs.writeFileSync(path.join(journey.dir, 'codex-turn1.jsonl'), first.stdout);
  const threadId = parseCodexThreadId(first.stdout);
  journey.step('real Codex thread created', {
    thread_id: threadId,
    first_turn_reply: collectCodexAgentMessages(first.stdout).join(' | '),
  });

  // Registration is harness-driven, and that is a disclosed limitation rather
  // than a shortcut: `codex exec --ignore-user-config` structurally prevents
  // the packaged plugin SessionStart hook from running, so there is no way to
  // reach the shipped registration path from a scripted exec turn. What runs
  // here is the SHIPPED companion — dist/host-runtime/codex-session.js — fed
  // the SessionStart payload the hook would have handed it.
  const companionLog = fs.openSync(path.join(journey.dir, 'codex-session.log'), 'a');
  const companion = spawn(process.execPath, [dist('dist/host-runtime/codex-session.js')], {
    env: { ...journey.env, PLUGIN_ROOT: repoRoot },
    stdio: ['pipe', companionLog, companionLog],
  });
  journey.children.push({ name: 'codex-session', child: companion });
  companion.stdin.end(JSON.stringify({
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: threadId,
    cwd: workspace,
  }));
  journey.note(
    'The Codex registration half is harness-driven: `codex exec --ignore-user-config` cannot load the '
    + 'packaged plugin SessionStart hook, so this check feeds the shipped dist/host-runtime/codex-session.js '
    + 'the SessionStart payload that hook would have supplied. Dispatch -> `codex queue` -> model-visible '
    + 'reply is product-path evidence; the registration step is not.',
  );
  const card = await journey.until(
    'The Codex session never registered with the router',
    () => journey.discover().cards.find((entry) => entry.session_id === threadId) ?? false,
    60_000,
  );
  journey.step('Codex thread registered with the router', {
    session_id: card.session_id,
    principal_id: card.principal_id,
    host_kind: card.host_kind,
    generation: card.generation,
  });

  const sentinel = `codex-${randomUUID().slice(0, 8)}`;
  const sent = journey.sendAccepted(threadId, sentinel, sentinel, 'codex-cli-queue');
  journey.lastDurableMessageId = sent.messageId;
  journey.step('exact-session send accepted by the codex-cli-queue adapter', {
    sentinel,
    message_id: sent.messageId,
    delivery_id: sent.deliveryId,
    native_delivery: sent.native,
  });

  // The prompt names neither the sentinel nor either id on purpose. The model
  // can only produce them by reading the envelope Codex queued.
  const prompt = 'If a MeMesh envelope containing a qa_sentinel field was injected into this session, '
    + 'reply with exactly one line: CODEX_RECEIVED_<qa_sentinel> <message_id> <delivery_id>, substituting '
    + 'the three values from that envelope. Otherwise reply with exactly: NO_ENVELOPE. '
    + 'Do nothing else and run no commands.';
  const second = run('codex', [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-s', 'read-only', '-C', workspace, 'resume', threadId, prompt,
  ], { timeout: 180_000 });
  if (second.status !== 0) {
    throw new Error(`codex exec resume exited ${second.status}: ${second.stderr.trim().slice(0, 600)}`);
  }
  fs.writeFileSync(path.join(journey.dir, 'codex-turn2.jsonl'), second.stdout);
  const reply = assertCodexReply({
    jsonl: second.stdout,
    sentinel,
    messageId: sent.messageId,
    deliveryId: sent.deliveryId,
  });
  journey.step('the Codex model quoted the envelope back (model-visible proof)', {
    model_visible_evidence: reply,
    proves: 'the reply carries message_id and delivery_id, neither of which appears in the prompt',
  });

  companion.kill('SIGTERM');
  await journey.until(
    'The router still lists the Codex session as live after its companion was stopped',
    () => journey.discover().cards.every((entry) => entry.session_id !== threadId),
    15_000,
  );
  journey.step('companion stopped and the session left the router directory', { session_id: threadId });

  journey.step('a send to the stopped session fails closed and the durable row survives',
    journey.provesFailClosed(threadId, sentinel));

  journey.note(
    '`recipient_unavailable` is a shared failure surface — the same string is returned when the SENDER '
    + 'cannot reach the router. The final step therefore also records that `message discover` still '
    + 'answered and that `message fetch` still returned the payload; that pairing is what attributes the '
    + 'failure to the stopped recipient rather than to a dead router.',
  );
  journey.note(
    'One throwaway Codex thread is created in the owner\'s Codex rollout store and one message is queued '
    + 'into it. No Codex or MeMesh configuration outside the temporary directory is written, and no auth '
    + 'file is read: the login precondition is the exit code of `codex login status`.',
  );
}

async function runClaude(journey, waitMs) {
  const version = run('claude', ['--version']);
  if (version.status !== 0) {
    throw new Error('`claude` is not on PATH. This check needs Claude Code installed.');
  }
  journey.step('claude precondition', { claude_version: version.stdout.trim() });

  journey.startRouter();
  await journey.waitForRouterSocket();
  journey.step('router started against the temporary MEMESH_DIR', { socket_path: journey.socketPath });

  const setup = journey.cliJson([
    'agent', 'setup', 'claude',
    '--project', PROJECT,
    '--principal', 'claude-live-journey',
    '--json',
  ]);
  journey.step('agent setup claude', { config_path: setup.config_path, mode: setup.mode });

  const workspace = path.join(journey.dir, 'claude-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const mcpConfig = path.join(journey.dir, 'claude-mcp.json');
  fs.writeFileSync(mcpConfig, `${JSON.stringify({
    mcpServers: {
      memesh: {
        command: process.execPath,
        args: [dist('dist/mcp/server.js')],
        env: { MEMESH_DIR: journey.memeshDir, MEMESH_DB_PATH: journey.dbPath },
      },
      'memesh-channel': {
        command: process.execPath,
        args: [dist('dist/host-runtime/claude.js'), '--config', setup.config_path],
        env: { MEMESH_DIR: journey.memeshDir, MEMESH_DB_PATH: journey.dbPath },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const launch = `cd ${JSON.stringify(workspace)} && claude --dangerously-load-development-channels `
    + `server:memesh-channel --mcp-config ${JSON.stringify(mcpConfig)} --strict-mcp-config`;
  journey.say([
    '',
    '  ACTION REQUIRED — in a second terminal, run exactly:',
    '',
    `    ${launch}`,
    '',
    '  Then TYPE NOTHING. Leave the session sitting at its prompt. This check is',
    '  measuring what the session does on its own when an envelope arrives.',
    '',
  ].join('\n'));

  const card = await journey.until(
    'No Claude channel session registered with the router. Was the session launched with '
    + '--dangerously-load-development-channels and the local-development warning confirmed?',
    () => findLiveCards(journey.discover(), { hostKind: 'claude' })[0] ?? false,
    waitMs,
  );
  journey.step('interactive Claude session registered on the channel', {
    session_id: card.session_id,
    principal_id: card.principal_id,
    host_kind: card.host_kind,
    generation: card.generation,
    launch_command: launch,
    operator_prompt: 'none-instructed',
  });

  const sentinel = `claude-${randomUUID().slice(0, 8)}`;
  const sent = journey.sendAccepted(card.session_id, sentinel, sentinel, 'claude-channel');
  journey.lastDurableMessageId = sent.messageId;
  journey.step('exact-session send accepted by the claude-channel adapter', {
    sentinel,
    message_id: sent.messageId,
    delivery_id: sent.deliveryId,
    native_delivery: sent.native,
  });

  journey.say('  Waiting for the session\'s own model to call `intake` on that message. Still type nothing.\n');
  const intake = await journey.until(
    `The Claude session never recorded an intake receipt for ${sent.messageId}. host_accept proves only that `
    + 'the channel took the frame, not that the model saw it (this is exactly the print-mode failure of issue #275).',
    () => findIntakeReceipt(journey.cliJson([
      'message', 'receipts',
      '--project', PROJECT,
      '--recipient', card.session_id,
      '--message-id', sent.messageId,
    ]), { messageId: sent.messageId, actor: card.session_id }),
    waitMs,
  );
  journey.step('the Claude model called intake itself (model-visible proof)', {
    model_visible_evidence: { receipt_id: intake.receipt_id, receipt_kind: intake.receipt_kind, actor: intake.actor },
    proves: 'the intake receipt was written by the recipient session, not by this harness',
  });

  journey.say('\n  ACTION REQUIRED — exit that Claude session now (Ctrl-D or /exit).\n');
  await journey.until(
    'The Claude session is still registered with the router. Exit the interactive session to continue.',
    () => findLiveCards(journey.discover(), { sessionId: card.session_id }).length === 0,
    waitMs,
  );
  journey.step('session disconnected and left the router directory', { session_id: card.session_id });

  journey.step('a send to the stopped session fails closed and the durable row survives',
    journey.provesFailClosed(card.session_id, sentinel));

  journey.note(
    'The operator is instructed to type nothing, but this check cannot observe whether anything was typed. '
    + 'The intake receipt proves the model called `intake` in that session; it does not prove it did so unprompted.',
  );
  journey.note(
    'The intake receipt is matched on its `actor`, which `intake` sets from the caller\'s `recipient`. The model '
    + 'must therefore intake under its own session id; an intake recorded against the principal id instead would '
    + 'not match and this check would report no model-visible proof.',
  );
  journey.note(
    'Print mode (`claude -p`) is not supported and is not exercised: a print-mode session does not surface '
    + 'memesh-channel notifications to the model even when the channel host reports the frame accepted '
    + '(issue #275), so it cannot produce the model-visible proof this check requires.',
  );
  journey.note(
    '`recipient_unavailable` is a shared failure surface — the same string is returned when the SENDER '
    + 'cannot reach the router. The final step therefore also records that `message discover` still '
    + 'answered and that `message fetch` still returned the payload; that pairing is what attributes the '
    + 'failure to the stopped recipient rather than to a dead router.',
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  assertDistPresent(repoRoot);
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  if (revision.length === 0) throw new Error('Could not read the repository revision; the report would name no code.');
  const journey = new Journey(options);
  const startedAt = new Date().toISOString();
  let failure = null;

  process.stdout.write(`memesh live journey — host=${options.host} revision=${revision}\n`);
  process.stdout.write(`  MEMESH_DIR=${journey.memeshDir}\n\n`);

  try {
    if (options.host === 'codex') await runCodex(journey);
    else await runClaude(journey, options.waitMs);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    journey.steps.push({
      step: journey.steps.length + 1,
      name: 'FAILED',
      status: 'FAIL',
      at: new Date().toISOString(),
      error: failure,
    });
    process.stderr.write(`  FAIL ${failure}\n`);
  }

  const report = {
    schema_version: 'memesh-live-journey/v1',
    revision,
    host: options.host,
    project: PROJECT,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    verdict: failure === null ? 'PASS' : 'FAIL',
    memesh_dir: journey.memeshDir,
    steps: journey.steps,
    limitations: journey.limitations,
    ...(failure === null ? {} : { error: failure }),
  };
  if (options.out) {
    const target = path.resolve(options.out);
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`\nReport: ${target}\n`);
  } else {
    process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  }
  journey.cleanup();
  process.exit(failure === null ? 0 : 1);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
