/**
 * D13 — `memesh doctor` says out loud when an AI-backed feature has quietly
 * stopped working.
 *
 * `llm_telemetry` (llm-telemetry.ts) is written by every Smart-Mode flow and,
 * until this row existed, read by nothing that could alert anyone: `memesh
 * telemetry` shows it on request, which means a broken flow needed someone to
 * think to ask. Measured on the maintainer's own graph on 2026-09-02:
 * `guard_proposer` had failed all 69 of its calls, every one of them, for
 * five straight days, and doctor had no check that so much as read the
 * table (`grep -n "llm_telemetry" src/core/doctor.ts` found nothing before
 * this file).
 *
 * These spawn the built CLI against a real database in a throwaway HOME —
 * the row's window filter (`ts >= datetime(?)`) and per-flow grouping run
 * inside `summariseTelemetry`'s own SQL, which a canned stub cannot exercise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

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

describe('doctor: an AI-backed feature that quietly stopped working is reported', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-llmtelem-'));
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
      // doctor exits non-zero whenever any row fails, which the warn case
      // here routinely produces. The report is on stdout either way.
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
    // "no telemetry row" just as well as a working one.
    expect(checks.length, 'doctor returned an empty report').toBeGreaterThan(6);
    return checks;
  }

  function telemetryRow(): DoctorCheck | undefined {
    const matches = doctorChecks().filter((c) => c.id === 'llm_telemetry_health');
    expect(matches.length, `doctor emitted ${matches.length} llm_telemetry_health rows`).toBeLessThan(2);
    return matches[0];
  }

  /** A database built by the real code path, holding one memory. */
  function seedDatabase(): void {
    try { closeDatabase(); } catch { /* none open */ }
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('a-note', 'note', { observations: ['something worth keeping'] });
    closeDatabase();
    expect(fs.existsSync(dbPath), 'setup: no database was created').toBe(true);
  }

  /** One `llm_telemetry` row, at an explicit age — the shape recordTelemetry writes. */
  function seedCall(
    flow: string,
    status: 'ok' | 'fail',
    hoursAgo: number,
    errorClass: string | null = null,
    attemptIndex = 0,
  ): void {
    const db = new Database(dbPath);
    const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, model, attempt_index, status, latency_ms, error_class, fallback_used)
       VALUES (?, ?, 'anthropic', 'claude-3-5-haiku-latest', ?, ?, 400, ?, ?)`,
    ).run(ts, flow, attemptIndex, status, errorClass, attemptIndex > 0 ? 1 : 0);
    db.close();
  }

  it('says nothing on a database with no telemetry at all — absence is not health', () => {
    seedDatabase();
    expect(telemetryRow(), 'doctor invented a verdict about a flow that has never run').toBeUndefined();
  });

  it('WARNS when a flow failed every one of its recent calls', () => {
    seedDatabase();
    // The measured real shape: guard_proposer, 69/69 failed, all inside 5 days.
    for (let i = 0; i < 5; i++) seedCall('guard_proposer', 'fail', i * 20, 'bad_request');

    const check = telemetryRow();
    expect(check, 'a flow at 0% recent success went unreported').toBeDefined();
    expect(check?.status).toBe('warn');
    expect(check?.code).toBe('llm-telemetry.silent-failure');
    expect(check?.summary).toContain('guard_proposer (5 calls, 0 succeeded)');
    expect(check?.summary, 'the cost side is what makes this actionable').toMatch(/silently doing nothing/i);
    expect(check?.fix).toMatch(/memesh telemetry/);
    expect(check?.informational, 'a warning that cannot affect Overall is not a warning').toBeFalsy();
  });

  it('reports a healthy flow as information, not as a problem', () => {
    seedDatabase();
    for (let i = 0; i < 8; i++) seedCall('transcript_extractor', 'ok', i);
    seedCall('transcript_extractor', 'fail', 9, 'network');

    const check = telemetryRow();
    expect(check, 'measured calls with no confirmed failure went unreported').toBeDefined();
    expect(check?.informational).toBe(true);
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('9 call(s)');
    expect(check?.summary).toMatch(/89%|90%/);
    expect(check?.code, 'a healthy state carried a failure code').toBeUndefined();
  });

  it('does not flag a flow on a single failed call — a blip is not a trend', () => {
    seedDatabase();
    seedCall('failure_analyzer', 'fail', 1, 'bad_request');
    seedCall('failure_analyzer', 'fail', 2, 'bad_request');

    const check = telemetryRow();
    expect(check?.status, 'two calls tripped the warn threshold').toBe('pass');
    expect(check?.summary).toContain('2 call(s)');
    expect(check?.summary).toContain('0%');
  });

  it('excludes a flow whose only success sits outside the 7-day window from diluting a live failure', () => {
    seedDatabase();
    // dreamer's real shape: a stale success 10 days back, then five recent
    // calls that all failed. A window wide enough to blend the two would
    // report "1 of 6 succeeded" and hide that it has been broken all week.
    seedCall('dreamer', 'ok', 10 * 24);
    for (let i = 0; i < 5; i++) seedCall('dreamer', 'fail', i * 20, 'bad_request');

    const check = telemetryRow();
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('dreamer (5 calls, 0 succeeded)');
  });

  it('does not flag a flow with an ordinary background failure rate mixed among successes', () => {
    seedDatabase();
    // transcript_extractor's real shape: failures sandwiched between
    // successes, never a run of `minCalls` failures in a row.
    seedCall('transcript_extractor', 'ok', 1);
    seedCall('transcript_extractor', 'fail', 2, 'network');
    seedCall('transcript_extractor', 'ok', 3);
    seedCall('transcript_extractor', 'fail', 4, 'network');
    seedCall('transcript_extractor', 'ok', 5);

    const check = telemetryRow();
    expect(check?.status, 'an ordinary background failure rate was reported as broken').toBe('pass');
  });

  it('counts calls, not provider attempts, when a failover chain fires', () => {
    seedDatabase();
    // Two calls, each trying two providers and failing both: 2 calls, 4
    // failed ATTEMPTS. minCalls (3) is not met by call count, so this must
    // stay unflagged — a naive attempt-count gate would treat 4 as ≥3 and
    // warn on two data points instead of the blip they are.
    seedCall('failure_analyzer', 'fail', 1, 'bad_request', 0);
    seedCall('failure_analyzer', 'fail', 1, 'bad_request', 1);
    seedCall('failure_analyzer', 'fail', 2, 'bad_request', 0);
    seedCall('failure_analyzer', 'fail', 2, 'bad_request', 1);

    const check = telemetryRow();
    expect(check?.status, 'attempt count (4) was mistaken for call count (2) and warned early').toBe('pass');
    expect(check?.summary).toContain('2 call(s)');
  });
});
