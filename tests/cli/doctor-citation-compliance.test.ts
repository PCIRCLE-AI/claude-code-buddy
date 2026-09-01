/**
 * `memesh doctor` says out loud when nothing is citing the memories it injects.
 *
 * The numbers behind this row already existed and already worked. The Stop
 * hook writes `citation_sessions_total` / `citation_sessions_cited`,
 * `analytics.ts` reads them and computes a compliance rate, and both sides
 * have tests. But those tests SEED the counters, so the only values anyone
 * had ever looked at were fixtures. Measured on a real database on
 * 2026-08-24: total 4, cited absent — a 0% rate, correct, computable, and
 * reported to nobody.
 *
 * That is the defect this row closes, and it is a different one from an
 * unpinned diagnostic: here every layer was present and tested, and the
 * output still reached no one because reaching someone required going to
 * look. A metric you have to go looking for reports nothing.
 *
 * Spawns the built CLI against a real database in a throwaway HOME: the row
 * reads `memesh_metadata` and branches on what is there, and a stub that
 * answers canned rows cannot exercise a predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { CITATION_RULE_BODY, CITATION_RULE_FILENAME } from '../../src/core/citation-rule.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

interface DoctorCheck {
  id: string;
  status: string;
  summary: string;
  fix?: string;
  code?: string;
  params?: Record<string, string | number>;
  informational?: boolean;
}

describe('doctor: the memory-citation rate is reported, not left to be found', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-citerate-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function run(
    args: string[],
    envOverride: NodeJS.ProcessEnv = {},
  ): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...envOverride };
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST', 'MEMESH_DIR', 'MEMESH_DB_PATH']) {
      delete env[key];
    }
    try {
      return { status: 0, stdout: execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env }), stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  function doctorChecks(envOverride: NodeJS.ProcessEnv = {}): DoctorCheck[] {
    const r = run(['doctor', '--json'], envOverride);
    let report: { checks?: DoctorCheck[] };
    try {
      report = JSON.parse(r.stdout) as { checks?: DoctorCheck[] };
    } catch {
      throw new Error(`doctor --json produced no JSON (status ${r.status}): ${r.stdout || r.stderr}`);
    }
    expect(Array.isArray(report.checks), 'doctor --json has no checks array').toBe(true);
    return report.checks as DoctorCheck[];
  }

  /**
   * A database built by the real code path, holding one memory.
   *
   * `openDatabase` + `KnowledgeGraph`, not a spawned `memesh remember`. Same
   * schema, same migrations, same write path — the CLI would only add a
   * process launch, and this file already spawns doctor once per test. On the
   * Windows runner each launch costs seconds, and a suite that spends them
   * without buying anything is a suite that eventually trips a hook timeout
   * in some unrelated file.
   */
  function seedDatabase(): void {
    try { closeDatabase(); } catch { /* none open */ }
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('a-note', 'note', {
      observations: ['something worth keeping'],
    });
    closeDatabase();
    expect(fs.existsSync(dbPath), 'setup: no database was created').toBe(true);
  }

  /** Write the counters the Stop hook keeps, exactly as it writes them. */
  function seedCounters(total: string | null, cited: string | null): void {
    const db = new Database(dbPath);
    const set = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    if (total !== null) set.run('citation_sessions_total', total);
    if (cited !== null) set.run('citation_sessions_cited', cited);
    db.close();
  }

  function row(envOverride: NodeJS.ProcessEnv = {}): DoctorCheck | undefined {
    const checks = doctorChecks(envOverride);
    // Anti-vacuity: every assertion below reads a FILTER of this array, so an
    // empty report would satisfy "no citation row" and "no warning" alike.
    // Doctor emits well over a dozen rows on any real database; six is a
    // floor that cannot be met by a broken run.
    expect(checks.length, 'doctor returned an empty report — every filter below is vacuous')
      .toBeGreaterThan(6);
    const matches = checks.filter((c) => c.id === 'citation_compliance');
    expect(matches.length, `doctor emitted ${matches.length} citation rows`).toBeLessThan(2);
    return matches[0];
  }

  it('says nothing before any session has been accounted', () => {
    // The half that gives the warning meaning: a fresh install has injected
    // nothing yet, and telling it that nothing cited its memories would be
    // both true and useless.
    seedDatabase();
    expect(row(), 'doctor complained about citations before anything was injected').toBeUndefined();
  });

  it('WARNS when sessions received memories and none cited one', () => {
    // The real measured state on 2026-08-24.
    seedDatabase();
    seedCounters('4', '0');

    const check = row();
    expect(check, 'a 0% citation rate went unreported').toBeDefined();
    expect(check?.status).toBe('warn');
    expect(check?.code).toBe('citation.none');
    expect(check?.params?.total).toBe(4);
    expect(check?.summary).toContain('4');
    expect(check?.summary, 'the cost side is what makes this actionable').toMatch(/token/i);
    expect(check?.informational, 'a warning that cannot affect Overall is not a warning').toBeFalsy();
  });

  it('reports a healthy rate as information, not as a problem', () => {
    seedDatabase();
    seedCounters('4', '3');

    const check = row();
    expect(check?.informational).toBe(true);
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('75%');
    expect(check?.code, 'a healthy rate carried a failure code').toBeUndefined();
  });

  it('does not read an ABSENT cited-counter as zero', () => {
    // The distinction the unconditional initialisation exists for: before
    // that fix, "no session cited anything" and "this counter never ran"
    // were the same missing key. Calling an unknown rate 0% would accuse a
    // working install of ignoring every memory.
    seedDatabase();
    seedCounters('4', null);

    const check = row();
    expect(check, 'an un-measurable rate produced no row at all').toBeDefined();
    expect(check?.status, 'an unknown rate was reported as a failure').toBe('pass');
    expect(check?.informational).toBe(true);
    expect(check?.summary).toMatch(/not recorded/i);
    expect(check?.code).toBeUndefined();
  });

  it('points at the citation contract when the rate is zero', () => {
    // A warning with no remedy is noise. The fix line names where the
    // contract lives, because a missing contract is the first thing that
    // would produce a 0% rate.
    seedDatabase();
    seedCounters('2', '0');

    const check = row();
    expect(check?.fix, 'a zero rate was reported with no remedy').toBeTruthy();
    expect(check?.fix).toMatch(/memesh-citations\.md|install-hooks/);
  });

  it('reads the citation contract from a relocated CLAUDE_CONFIG_DIR', () => {
    seedDatabase();
    seedCounters('2', '0');
    const relocated = path.join(home, 'relocated-claude');
    const rulePath = path.join(relocated, 'rules', CITATION_RULE_FILENAME);
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, CITATION_RULE_BODY);

    const check = row({ CLAUDE_CONFIG_DIR: relocated });
    expect(check?.fix).toContain(rulePath);
    expect(check?.fix).toMatch(/installed/i);
    expect(check?.fix).not.toContain(path.join(home, '.claude', 'rules'));
  });
});
