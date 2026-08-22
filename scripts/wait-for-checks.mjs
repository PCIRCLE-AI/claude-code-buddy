import { execFileSync } from 'node:child_process';

/**
 * Block until every GitHub Actions check on a PR has concluded, and print an
 * unambiguous, machine-readable verdict.
 *
 * This exists because three different "wait for CI" approaches have stalled
 * in this repo across sessions:
 *
 *   1. `gh pr checks <n> --watch` returned exit 0 while checks were still
 *      `pending` (observed: "watch exit=0" then an immediate `gh pr checks`
 *      showed 11 pending). gh's own process exit code cannot be trusted as
 *      the verdict.
 *   2. `gh pr checks | grep -cv pass` — grep exits 1 when it matches zero
 *      lines, so the pipeline's exit code was grep's, not CI's.
 *   3. Hand-rolled `for i in $(seq 1 30); do gh pr checks ...; sleep 45; done`
 *      loops had to be rewritten every session, and a background variant
 *      silently stalled twice in one session.
 *   4. The GitHub API has returned HTTP 5xx mid-poll; a naive loop that reads
 *      "no pending rows in this response" as "done" is wrong when the
 *      response was actually an error page.
 *
 * The fix for all four is the same rule: derive the verdict ONLY from a
 * successfully parsed JSON body, never from any process's exit code (gh's,
 * grep's, or anything piped). If we can't parse a JSON array of checks, that
 * poll counts as "could not reach GitHub", not as "zero pending" and not as
 * "done".
 *
 * gh API shape used: `gh pr checks <n> --json name,state,bucket`. Confirmed
 * via `gh --version` (2.97.0) and `gh pr checks --help` on this machine,
 * which lists `bucket, completedAt, description, event, link, name, state,
 * startedAt, workflow` as valid --json fields and documents `bucket` as
 * `state` collapsed into `pass | fail | pending | skipping | cancel`. That
 * flag is present in the installed gh version, so the
 * `repos/{owner}/{repo}/commits/{sha}/check-runs` REST fallback described in
 * the task was not needed.
 *
 * Design decisions not fully specified by the task, made explicit here:
 *   - `skipping` is treated as non-blocking (folded into the "pass" tally).
 *     GitHub does not block merges on a skipped run, and a skip caused by an
 *     upstream failure still surfaces as a `fail` bucket on that upstream
 *     check, so it is still caught.
 *   - `fail` and `cancel` both count as a blocking failure (exit 1).
 *   - An unrecognized future bucket value is treated as pending, never as
 *     pass — an unknown value must never manufacture a false "done".
 *   - A response with zero checks (`[]`) is treated as pending, not success.
 *     Right after a push, GitHub Actions can take a few seconds to register
 *     any check runs at all; treating "no rows yet" as "nothing to wait for"
 *     would reproduce the exact failure mode in evidence #1 above.
 *
 * Usage:
 *   node scripts/wait-for-checks.mjs <pr-number> [--timeout-min N] [--interval-sec N]
 *
 * Exit codes:
 *   0 — every check concluded success (or non-blocking skip)
 *   1 — at least one check concluded failure or cancelled
 *   2 — timed out while checks were still pending
 *   3 — could not reach GitHub (10 consecutive transport failures, or the
 *       timeout was reached without ever getting a usable response)
 *   64 — usage error (bad arguments)
 */

const USAGE = 'usage: node scripts/wait-for-checks.mjs <pr-number> [--timeout-min N] [--interval-sec N]';
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 10;
const GH_CALL_TIMEOUT_MS = 20_000;

// gh's own `bucket` enum, per `gh pr checks --help` on gh 2.97.0.
const PASS_BUCKETS = new Set(['pass', 'skipping']);
const FAIL_BUCKETS = new Set(['fail', 'cancel']);
const PENDING_BUCKETS = new Set(['pending']);

function log(line) {
  process.stdout.write(`${line}\n`);
}

function usageError(message) {
  process.stderr.write(`error: ${message}\n${USAGE}\n`);
  process.exitCode = 64;
  return null;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return usageError('missing <pr-number>');
  }
  const prNumberRaw = args[0];
  if (!/^\d+$/.test(prNumberRaw)) {
    return usageError(`<pr-number> must be a positive integer, got: ${prNumberRaw}`);
  }

  let timeoutMin = 40;
  let intervalSec = 30;

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--timeout-min') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        return usageError('--timeout-min must be a positive number');
      }
      timeoutMin = value;
      i += 1;
    } else if (flag === '--interval-sec') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        return usageError('--interval-sec must be a positive number');
      }
      intervalSec = value;
      i += 1;
    } else {
      return usageError(`unknown argument: ${flag}`);
    }
  }

  return { prNumber: prNumberRaw, timeoutMin, intervalSec };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Call `gh pr checks` once. Never throws — always returns { stdout, stderr }
 * strings, even when gh exits non-zero (gh returns non-zero both for real
 * transport/lookup errors AND for legitimate "a check failed" or "checks
 * still pending" results, so the exit code alone cannot tell those apart;
 * only the parsed JSON body can).
 */
function invokeGhChecks(prNumber) {
  const args = ['pr', 'checks', prNumber, '--json', 'name,state,bucket'];
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: GH_CALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      // Capture only — execFileSync's default otherwise inherits the
      // child's stderr straight to ours, which would dump gh's raw error
      // text into the terminal on every failed poll and break the "one
      // clean status line per poll, no surprise output" contract.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (err) {
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' && err.stderr ? err.stderr : String(err.message || err),
    };
  }
}

/**
 * Turn a raw gh invocation result into either a usable list of checks or a
 * transport-failure reason. This is the ONLY place that decides "did we
 * actually hear back from GitHub" — everything downstream trusts its answer.
 */
function classify(raw) {
  const trimmed = (raw.stdout || '').trim();
  if (!trimmed) {
    const reason = raw.stderr ? raw.stderr.trim().split('\n')[0] : 'empty response from gh';
    return { ok: false, reason };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, reason: `unparseable JSON from gh: ${err.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'gh --json output was not a JSON array' };
  }
  return { ok: true, checks: parsed };
}

function tallyChecks(checks) {
  const tally = { pass: 0, pending: 0, fail: 0, notPassed: [] };
  for (const check of checks) {
    const bucket = check.bucket || '';
    const name = check.name || '(unnamed check)';
    const state = check.state || '?';
    if (PASS_BUCKETS.has(bucket)) {
      tally.pass += 1;
    } else if (FAIL_BUCKETS.has(bucket)) {
      tally.fail += 1;
      tally.notPassed.push(`${name} [${bucket}/${state}]`);
    } else if (PENDING_BUCKETS.has(bucket)) {
      tally.pending += 1;
      tally.notPassed.push(`${name} [${bucket}/${state}]`);
    } else {
      // Unrecognized bucket value: never let an unknown state count as pass.
      tally.pending += 1;
      tally.notPassed.push(`${name} [unknown bucket "${bucket}"/${state}]`);
    }
  }
  return tally;
}

function resultLine(tally, exitCode) {
  return `RESULT pass=${tally.pass} fail=${tally.fail} pending=${tally.pending} exit=${exitCode}`;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed) {
    return process.exitCode; // usageError already set process.exitCode to 64
  }
  const { prNumber, timeoutMin, intervalSec } = parsed;

  log(`waiting on PR #${prNumber} checks (timeout ${timeoutMin}min, poll every ${intervalSec}s)`);

  const deadline = Date.now() + timeoutMin * 60 * 1000;
  let consecutiveFailures = 0;

  for (;;) {
    const raw = invokeGhChecks(prNumber);
    const result = classify(raw);
    const now = new Date().toISOString();

    if (!result.ok) {
      consecutiveFailures += 1;
      log(`${now} TRANSPORT-ERROR (${consecutiveFailures}/${MAX_CONSECUTIVE_TRANSPORT_FAILURES} consecutive): ${result.reason}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
        log(`could not reach GitHub after ${consecutiveFailures} consecutive failed polls`);
        log(resultLine({ pass: 0, fail: 0, pending: 0 }, 3));
        return 3;
      }
      if (Date.now() >= deadline) {
        log('timed out while still unable to reach GitHub — verdict unknown, not reporting done');
        log(resultLine({ pass: 0, fail: 0, pending: 0 }, 3));
        return 3;
      }
      await delay(intervalSec * 1000);
      continue;
    }

    consecutiveFailures = 0;
    const { checks } = result;

    if (checks.length === 0) {
      log(`${now} pass=0 pending=0 fail=0 (no checks reported yet)`);
      if (Date.now() >= deadline) {
        log(resultLine({ pass: 0, fail: 0, pending: 0 }, 2));
        return 2;
      }
      await delay(intervalSec * 1000);
      continue;
    }

    const tally = tallyChecks(checks);
    const notPassedSuffix = tally.notPassed.length > 0 ? ` not-passed=[${tally.notPassed.join(', ')}]` : '';
    log(`${now} pass=${tally.pass} pending=${tally.pending} fail=${tally.fail}${notPassedSuffix}`);

    if (tally.fail > 0) {
      log(resultLine(tally, 1));
      return 1;
    }
    if (tally.pending === 0) {
      log(resultLine(tally, 0));
      return 0;
    }
    if (Date.now() >= deadline) {
      log(resultLine(tally, 2));
      return 2;
    }
    await delay(intervalSec * 1000);
  }
}

main(process.argv)
  .then((code) => {
    if (typeof code === 'number') {
      process.exitCode = code;
    }
  })
  .catch((err) => {
    process.stderr.write(`unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 3;
  });
