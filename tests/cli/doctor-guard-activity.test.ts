/**
 * `memesh doctor` says whether any accepted guard has ever fired.
 *
 * `recordGuardFires` increments `metadata.guard.fires` on every match, and
 * `applyProposal` initialises it to 0 with the comment "the field exists so
 * block can arrive per-guard once measured fire accuracy justifies it".
 * Nothing read it. There was no command, no HTTP route and no dashboard panel
 * that showed a guard at all — so the measurement the escalation was waiting
 * on could not be looked at, by anyone, ever. A write with no reader.
 *
 * Informational rather than a check, because a guard that has never fired is
 * not a fault: it may be guarding a mistake nobody has repeated.
 *
 * Spawns the built CLI against a real database in a throwaway HOME. The row
 * branches on `json_extract(metadata, '$.guard.enabled')`, and a stub that
 * answers canned rows cannot exercise a predicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

interface DoctorCheck {
  id: string;
  status: string;
  summary: string;
  informational?: boolean;
}

describe('doctor: guard activity is reported, not merely recorded', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-guardrow-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function doctorChecks(): DoctorCheck[] {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST', 'MEMESH_DIR', 'MEMESH_DB_PATH']) {
      delete env[key];
    }
    let stdout: string;
    try {
      stdout = execFileSync('node', [CLI_PATH, 'doctor', '--json'], { encoding: 'utf8', env });
    } catch (err) {
      // doctor exits non-zero whenever any row fails, which a throwaway HOME
      // routinely produces. The report is on stdout either way.
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    let report: { checks?: DoctorCheck[] };
    try {
      report = JSON.parse(stdout) as { checks?: DoctorCheck[] };
    } catch {
      throw new Error(`doctor --json produced no JSON: ${stdout.slice(0, 400)}`);
    }
    const checks = report.checks ?? [];
    // Anti-vacuity for every filter below: an empty report would satisfy
    // "no guard row" just as well as a working one.
    expect(checks.length, 'doctor returned an empty report').toBeGreaterThan(6);
    return checks;
  }

  function guardRow(): DoctorCheck | undefined {
    const matches = doctorChecks().filter((c) => c.id === 'guard_activity');
    expect(matches.length, `doctor emitted ${matches.length} guard rows`).toBeLessThan(2);
    return matches[0];
  }

  /** A memory carrying the guard metadata `applyProposal` writes. */
  function seedGuard(name: string, fires: number): void {
    try { closeDatabase(); } catch { /* none open */ }
    const db = openDatabase(dbPath);
    const kg = new KnowledgeGraph(db);
    kg.createEntity(name, 'lesson_learned', { observations: ['never do that again'] });
    kg.updateEntityMetadata(name, (current) => ({
      ...current,
      guard: {
        enabled: true,
        action: 'warn',
        tool: 'Bash',
        pattern: 'rm -rf',
        message: 'that command took a week off someone once',
        fires,
      },
    }));
    closeDatabase();
  }

  function seedPlainMemory(): void {
    try { closeDatabase(); } catch { /* none open */ }
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('an-ordinary-note', 'note', {
      observations: ['nothing to do with guards'],
    });
    closeDatabase();
  }

  it('names the fire count a guard has accumulated', () => {
    seedGuard('lesson-never-rm-rf', 3);

    const row = guardRow();
    expect(row, 'the guard row is missing — the count still has no reader').toBeDefined();
    expect(row?.summary).toContain('lesson-never-rm-rf (3)');
    expect(row?.informational, 'a guard that fired is not a fault').toBe(true);
  });

  it('says plainly when a guard has never matched', () => {
    seedGuard('lesson-untriggered', 0);

    const row = guardRow();
    expect(row?.summary).toContain('1 active guard');
    expect(row?.summary).toContain('None has matched yet');
  });

  it('emits no row at all on a database with no guards — the anti-vacuity half', () => {
    // A row that always appeared would pass both tests above and add a line
    // to every user's report for a feature they have never used.
    seedPlainMemory();

    expect(guardRow(), 'a guard row appeared with no guards in the database').toBeUndefined();
  });
});
