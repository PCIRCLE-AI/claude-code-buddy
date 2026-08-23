/**
 * Five diagnostics that reported the wrong thing, and the two writes that
 * had no reader.
 *
 * The shape they share is the one this whole review kept finding: a value is
 * produced correctly and then judged by something that is asking a different
 * question, or by nothing at all.
 *
 *   version compare   `packageVersion < update.latestVersion` — a STRING
 *                     comparison, with a comment conceding a semantic one
 *                     "would be more accurate" and claiming the string form
 *                     "catches 99% of cases". It stops working at the first
 *                     two-digit component: `'4.6.9' < '4.6.10'` is false.
 *                     At 4.6.10 doctor announced "Running pre-release
 *                     version (4.6.9)" while the banner urged an upgrade.
 *
 *   citation scope    doctor read the rule file at a hardcoded `'user'`
 *                     scope while both writers resolve it from the install
 *                     marker — so on a `--scope project` install it reported
 *                     the contract missing and pointed its fix at a path
 *                     nothing would ever write.
 *
 *   guard fires       `recordGuardFires` increments `metadata.guard.fires`
 *                     on every match and `applyProposal` initialises it,
 *                     with a comment saying escalation waits on "measured
 *                     fire accuracy". No command, route or panel ever showed
 *                     it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { classifyBump } from '../../src/core/updater.js';
import { parseValidatorResponse } from '../../src/core/digest-validator.js';

describe('a newer version is recognised past the first two-digit component', () => {
  it('sees 4.6.10 as an upgrade over 4.6.9, where a string compare does not', () => {
    // The predicate doctor now uses.
    expect(classifyBump('4.6.9', '4.6.10'), 'the upgrade was not recognised').toBe('patch');
    // And the one it used to use, spelled out so the reason is on the record.
    expect('4.6.9' < '4.6.10', 'fixture: string compare has stopped being wrong').toBe(false);
  });

  it('still refuses to call a LOWER version an upgrade — the anti-vacuity half', () => {
    // A comparison that answered "upgrade" for everything would satisfy the
    // test above and put a permanent update warning on every release branch,
    // which is the bug the string compare was introduced to fix.
    expect(classifyBump('4.7.0', '4.6.9')).toBeNull();
    expect(classifyBump('4.6.9', '4.6.9')).toBeNull();
  });
});

describe('an unreadable validator answer is not an approval', () => {
  it('reports unavailable for prose', () => {
    expect(parseValidatorResponse('sorry, I cannot do that').status).toBe('unavailable');
  });

  it('reports unavailable for JSON that names no verdict', () => {
    expect(parseValidatorResponse('{"suspicious": []}').status).toBe('unavailable');
  });

  it('still approves a body that says pass — the anti-vacuity half', () => {
    expect(parseValidatorResponse('{"verdict": "pass", "suspicious": []}').status).toBe('pass');
  });

  it('still rejects a body that says reject WITH evidence', () => {
    const result = parseValidatorResponse(
      '{"verdict": "reject", "suspicious": [{"claim": "it doubled throughput", "reason": "no source says so"}]}',
    );
    expect(result.status).toBe('reject');
    expect(result.suspiciousClaims).toHaveLength(1);
  });
});

describe('guard fires have a reader', () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-guardread-'));
    saved = process.env.MEMESH_DIR;
    process.env.MEMESH_DIR = dir;
    try { closeDatabase(); } catch { /* none open */ }
    openDatabase(path.join(dir, 'kg.db'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    if (saved === undefined) delete process.env.MEMESH_DIR;
    else process.env.MEMESH_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The query doctor's Guard activity row runs. */
  function activeGuards(): Array<{ name: string; fires: number }> {
    const rows = getDatabase()
      .prepare(
        `SELECT name, metadata FROM entities
         WHERE status = 'active'
           AND metadata IS NOT NULL
           AND json_extract(metadata, '$.guard.enabled') = 1`,
      )
      .all() as Array<{ name: string; metadata: string }>;
    return rows.map((r) => {
      const meta = JSON.parse(r.metadata) as { guard?: { fires?: number } };
      return { name: r.name, fires: meta.guard?.fires ?? 0 };
    });
  }

  function makeGuard(name: string, fires: number): void {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity(name, 'lesson_learned', { observations: ['a lesson worth guarding'] });
    kg.updateEntityMetadata(name, (current) => ({
      ...current,
      guard: { enabled: true, action: 'warn', tool: 'Bash', pattern: 'rm -rf', fires },
    }));
  }

  it('finds an accepted guard and the count recordGuardFires wrote', () => {
    makeGuard('lesson-never-rm-rf', 3);

    const guards = activeGuards();
    expect(guards, 'fixture: the guard was not written in the shape doctor queries').toHaveLength(1);
    expect(guards[0].fires, 'the fire count is unreachable from the query that reports it').toBe(3);
  });

  it('does not count an ordinary memory as a guard — the anti-vacuity half', () => {
    // A query without the `guard.enabled` predicate would report every
    // memory in the database as a guard that has never fired.
    makeGuard('lesson-never-rm-rf', 1);
    new KnowledgeGraph(getDatabase()).createEntity('an-ordinary-note', 'note', {
      observations: ['nothing to do with guards'],
    });

    expect(activeGuards().map((g) => g.name)).toEqual(['lesson-never-rm-rf']);
  });

  it('reports a guard that has never fired as zero, not as absent', () => {
    makeGuard('lesson-untriggered', 0);

    const guards = activeGuards();
    expect(guards).toHaveLength(1);
    expect(guards[0].fires).toBe(0);
  });
});
