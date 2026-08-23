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
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { openHookDb } = require('../../scripts/hooks/_shared.js');

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
