/**
 * A hook must not wait for a database lock longer than the harness will wait
 * for the hook.
 *
 * `MemeshDatabase` sets `busy_timeout = 30000`, and for the processes that
 * number was chosen for — the CLI, the MCP server, the HTTP server — it is
 * right: a 30k-vector `swapVectorGeneration` holds the write lock for ~9s and
 * a writer that WAITS is the whole point. A hook is not one of those. Its
 * budget in `hooks/hooks.json` runs from 3s to 10s, so a 30s wait has one
 * possible ending: the harness kills the hook. The capture is lost either
 * way; the difference is that the user also sees a hook-timeout error, and
 * that error is what turns memesh into something to switch off.
 *
 * Two invariants, and they are checked against each other rather than against
 * a number written twice:
 *   1. every hook the manifest declares has an explicit timeout
 *   2. the SQLite lock wait is strictly smaller than the smallest of them
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { openHookDb } = require('../../scripts/hooks/_shared.js');
const { MemeshDatabase } = require('../../scripts/hooks/_generated/sqlite.js');

interface HookEntry { matcher?: string; hooks: Array<{ command: string; timeout?: number }> }

function manifest(): Record<string, HookEntry[]> {
  const raw = fs.readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { hooks: Record<string, HookEntry[]> }).hooks;
}

function declaredHooks(): Array<{ event: string; command: string; timeout?: number }> {
  return Object.entries(manifest()).flatMap(([event, entries]) =>
    entries.flatMap((e) => e.hooks.map((h) => ({ event, command: h.command, timeout: h.timeout }))),
  );
}

describe('every declared hook states its own budget', () => {
  it('leaves no hook to the harness default', () => {
    const all = declaredHooks();
    // Fixture: a manifest that failed to parse into anything would make the
    // filter below trivially empty.
    expect(all.length, 'fixture: the manifest declared no hooks').toBeGreaterThan(5);

    const untimed = all.filter((h) => h.timeout === undefined).map((h) => `${h.event}:${path.basename(h.command)}`);
    expect(untimed, 'a hook with no timeout can hold up the user for the harness default').toEqual([]);
  });
});

describe('the SQLite lock wait fits inside the smallest budget', () => {
  it('opens hook databases with a busy_timeout below every declared timeout', () => {
    const budgets = declaredHooks().map((h) => h.timeout ?? 0);
    const smallestMs = Math.min(...budgets) * 1000;
    expect(smallestMs, 'fixture: no budget was read').toBeGreaterThan(0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-budget-'));
    try {
      const { db } = openHookDb({ ...process.env, MEMESH_DB_PATH: path.join(dir, 'kg.db') });
      try {
        // Read the value back off the handle. Asserting the source constant
        // would prove the constant exists, not that it reaches the database.
        const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
        expect(row.timeout, 'the hook handle kept the 30s wait meant for long-lived processes')
          .toBeLessThan(smallestMs);
        // And not zero: a hook that fails on the FIRST contended write loses
        // captures to overlaps that would have cleared in milliseconds.
        expect(row.timeout, 'the hook handle waits not at all').toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('the read-only hooks apply the same cap they cannot get from openHookDb', () => {
  // guard-check.js, session-start.js and pre-edit-recall.js each need a
  // `readOnly` handle, which `openHookDb` cannot express, so all three
  // open `MemeshDatabase` directly and must set the busy_timeout pragma
  // themselves. Proving the constant exists (the describe block above)
  // does not prove these three call sites apply it — only running them
  // does. `locking_mode = EXCLUSIVE` makes a second connection hold the
  // file exclusively (even against readers, unlike a plain WAL writer),
  // which is the one lock a `readOnly` SELECT can actually be made to
  // wait on.
  const cases: Array<{ script: string; input: object; maxMs: number }> = [
    { script: 'guard-check.js', input: { tool_input: { command: 'echo hi' } }, maxMs: 4_000 },
    { script: 'session-start.js', input: { cwd: '/tmp/hook-budget-probe' }, maxMs: 4_000 },
    // pre-edit-recall.js runs a guard query and then, on the same
    // connection, a recall query. `loadActiveGuards` swallows the guard
    // query's own failure, so a still-contended lock could pay the
    // busy_timeout wait TWICE in sequence (once hidden, once fatal) before
    // this hook gives up — roughly 2 * HOOK_BUSY_TIMEOUT_MS. 4s sits
    // between one wait (~2.2s observed) and two (~4.4s observed), so this
    // bound is the one that actually distinguishes a single probe from a
    // compounding one — 8s would pass either way.
    { script: 'pre-edit-recall.js', input: { tool_name: 'Edit', tool_input: { file_path: '/tmp/hook-budget-probe/a.ts', new_string: 'x' }, cwd: '/tmp/hook-budget-probe' }, maxMs: 4_000 },
  ];

  it.each(cases)('$script returns well inside its own budget while the db is held exclusively', ({ script, input, maxMs }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readonly-budget-'));
    const dbPath = path.join(dir, 'kg.db');
    // Create the schema (and close) before taking the exclusive lock —
    // an exclusive holder refuses even the migration this would run.
    const { db: seedDb } = openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath });
    seedDb.close();

    const locker = new MemeshDatabase(dbPath);
    locker.pragma('journal_mode = WAL');
    locker.pragma('locking_mode = EXCLUSIVE');
    // `locking_mode = EXCLUSIVE` only escalates to (and holds) the OS-level
    // exclusive lock on this connection's first WRITE — a read alone stays
    // at a shared lock, which does not block another reader. A scratch
    // table keeps this write out of the schema the hooks themselves query.
    locker.exec('CREATE TABLE __contention_probe (id INTEGER)');
    try {
      const hookPath = path.resolve('scripts/hooks', script);
      const startedAt = Date.now();
      const result = spawnSync('node', [hookPath], {
        input: JSON.stringify(input),
        env: { ...process.env, MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: 25_000,
      });
      const elapsedMs = Date.now() - startedAt;
      if (result.error) throw result.error;
      expect(result.status, `hook exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
      // The fix caps the wait at 2s; an unfixed direct `new MemeshDatabase`
      // inherits the 30s meant for long-lived writers. `maxMs` is per-case:
      // see the comment on pre-edit-recall.js above for why it is tighter
      // than "comfortably below 30s" would otherwise suggest.
      expect(elapsedMs, 'the hook waited past its own hooks.json budget for the exclusive lock').toBeLessThan(maxMs);
    } finally {
      locker.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});

describe('the PreCompact budget is the external one', () => {
  it('declares the timeout the harness enforces', () => {
    // pre-compact.js used to arm `setTimeout(() => process.exit(0), 10_000)
    // .unref()` as well. It could not fire: everything after stdin's `end`
    // in that file is one synchronous block, so the event loop never gets a
    // turn between the handler starting and the process exiting, and a JS
    // timer cannot interrupt the blocking SQLite call it was written for.
    //
    // Its REMOVAL is deliberately not pinned here. The only assertion
    // available would be `source.not.toMatch(/setTimeout\(/)` — a check on
    // source text, which this repository has learned to distrust: it passes
    // for dead code and fails on a comment (it did, on the comment three
    // lines above this one). A timer that can never fire has no observable
    // behaviour to assert in either direction. What IS assertable is the
    // timeout that replaced it, which lives outside the process.
    const preCompact = declaredHooks().find((h) => h.event === 'PreCompact');
    expect(preCompact, 'fixture: PreCompact is not declared at all').toBeDefined();
    expect(preCompact?.timeout, 'the external timeout is gone').toBe(10);
  });
});
