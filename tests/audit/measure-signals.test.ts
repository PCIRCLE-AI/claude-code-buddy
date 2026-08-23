/**
 * The signal census, tested against databases whose answers are known.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Every other `measure-*.mjs` in `scripts/audit/` is triaged in baseline.json
 * as NOT-A-GATE — "a manual measurement tool a human runs". That triage is
 * accurate and it is also how a tool quietly stops being run: nothing calls
 * it, nothing notices when it breaks, and the number it was built to surface
 * goes back to being invisible. Which is the exact defect this particular
 * tool was written to catch.
 *
 * So it gets tests. They are not a gate on the numbers (those depend on a
 * live database and are a human's to read) — they are a gate on the tool
 * still working, and they make this script the one measurement harness in
 * the directory with an automated caller.
 *
 * WHAT IS ACTUALLY PINNED
 *
 * The three-state classification, because that is the whole product: a
 * counter that is ABSENT is not a counter that is ZERO. Collapsing those two
 * is what let `citation_sessions_cited` read as "0% compliance" when the
 * truth was "this branch has never run" — and the opposite error would tell
 * a healthy install it is broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'audit', 'measure-signals.mjs');

interface Signal { name: string; value: string; state: string }

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-signals-'));
  dbPath = path.join(dir, 'kg.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A database with just enough schema for the census to read. */
function seed(meta: Record<string, string> = {}, entities = 0): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY, name TEXT, type TEXT, created_at TEXT, status TEXT DEFAULT 'active',
    access_count INTEGER DEFAULT 0, last_accessed_at TEXT, recall_hits INTEGER DEFAULT 0,
    recall_misses INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS memesh_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS hook_runs (hook TEXT PRIMARY KEY, last_run_at TEXT)`);
  const ins = db.prepare(`INSERT INTO entities (name, type, created_at, status) VALUES (?, 'note', '2026-08-01', 'active')`);
  for (let i = 0; i < entities; i++) ins.run(`e${i}`);
  const setMeta = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) setMeta.run(k, v);
  db.close();
}

function census(): { signals: Signal[]; exitCode: number } {
  try {
    const out = execFileSync('node', [SCRIPT, '--db', dbPath, '--json'], { encoding: 'utf8' });
    return { signals: (JSON.parse(out) as { signals: Signal[] }).signals, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    throw new Error(`census failed (${e.status}): ${e.stderr || e.stdout}`, { cause: err });
  }
}

function find(signals: Signal[], name: string): Signal {
  const s = signals.find((x) => x.name === name);
  expect(s, `no signal named ${name}; got: ${signals.map((x) => x.name).join(', ')}`).toBeDefined();
  return s as Signal;
}

describe('the census reads a live database', () => {
  it('reports something for every probe, not an empty list', () => {
    // Anti-vacuity: every assertion below looks up a name in this array.
    seed({}, 3);
    const { signals } = census();
    expect(signals.length, 'an empty census satisfies every lookup below vacuously').toBeGreaterThan(3);
    expect(find(signals, 'entities.total').value).toContain('3');
  });

  it('names every probe the script emits, so none can go quiet unnoticed', () => {
    // `signals.length > 3` was the only structural assertion, and three of
    // the six probes were never named by any test. A probe that stopped
    // emitting — a renamed column, a query that started throwing into the
    // `?? {}` fallback — would take its line out of the census with the
    // suite green, which is precisely the class of silence this tool exists
    // to expose. If it can happen to what it measures, it can happen to it.
    seed({ citation_sessions_total: '4', citation_sessions_cited: '1' }, 3);
    const { signals } = census();
    const names = signals.map((sig) => sig.name);

    for (const probe of [
      'entities.total',
      'entities.access_count',
      'entities.recall_hits',
      'citation.sessions',
      'hooks.runs',
    ]) {
      expect(names, `the ${probe} probe emitted nothing`).toContain(probe);
    }
  });

  it('reads the counters it reports, rather than reporting a constant', () => {
    // Each of the three probes that had no assertion, given a value only the
    // database could supply.
    seed({ citation_sessions_total: '7', citation_sessions_cited: '2' }, 5);
    const db = new Database(dbPath);
    db.prepare('UPDATE entities SET access_count = 3, recall_hits = 4 WHERE name = ?').run('e0');
    db.prepare("INSERT OR REPLACE INTO hook_runs (hook, last_run_at) VALUES ('session-summary', '2026-08-24 01:00:00')").run();
    db.close();

    const { signals } = census();

    expect(find(signals, 'entities.access_count').value,
      'the access probe did not read access_count').toContain('1/5');
    expect(find(signals, 'entities.recall_hits').value,
      'the recall-hits probe did not read recall_hits').toContain('4 hits');
    expect(find(signals, 'citation.sessions').value,
      'the citation probe did not read the counters').toContain('7');
    expect(find(signals, 'hooks.session-summary').value,
      'the hook probe did not read hook_runs').toContain('2026-08-24');
  });

  it('refuses a database path that does not exist, rather than reporting zeroes', () => {
    // Reporting "0 signals, all healthy" for a missing file is the failure
    // mode this whole tool exists to remove.
    let status: number | undefined;
    try {
      execFileSync('node', [SCRIPT, '--db', path.join(dir, 'nope.db'), '--json'], { encoding: 'utf8' });
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status, 'a missing database was treated as a readable one').toBe(2);
  });
});

describe('absent is not zero — the distinction the tool was built for', () => {
  it('calls the citation rate UNKNOWN when the cited counter has never been written', () => {
    // The real state of a database on 2026-08-24: sessions were accounted,
    // and the key recording how many cited a memory did not exist, because
    // the branch writing it had never run. That is not a 0% compliance rate.
    seed({ citation_sessions_total: '4' });
    const s = find(census().signals, 'citation.sessions');
    expect(s.state, 'an absent counter was reported as a measured zero').toBe('unknown');
    expect(s.value).toContain('?');
    expect(s.value).toContain('4');
  });

  it('calls it DEAD when the counter exists and really is zero', () => {
    seed({ citation_sessions_total: '4', citation_sessions_cited: '0' });
    const s = find(census().signals, 'citation.sessions');
    expect(s.state, 'a measured zero was excused as unknown').toBe('dead');
    expect(s.value).toContain('0 cited / 4 injected');
  });

  it('calls it LIVE as soon as one session cites anything', () => {
    seed({ citation_sessions_total: '4', citation_sessions_cited: '1' });
    expect(find(census().signals, 'citation.sessions').state).toBe('live');
  });

  it('calls it EMPTY — not dead — before any session has been accounted', () => {
    // A fresh install has zero of everything and is not broken. A census
    // that cried "dead" here would be turned off within a week.
    seed({});
    expect(find(census().signals, 'citation.sessions').state).toBe('empty');
  });
});

describe('hooks', () => {
  it('reports a hook that has never stamped a run as dead', () => {
    seed({});
    expect(find(census().signals, 'hooks.runs').state).toBe('dead');
  });

  it('reports each hook that has run, by name and timestamp', () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', access_count INTEGER DEFAULT 0, last_accessed_at TEXT, recall_hits INTEGER DEFAULT 0, recall_misses INTEGER DEFAULT 0)`);
    db.exec(`CREATE TABLE IF NOT EXISTS memesh_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS hook_runs (hook TEXT PRIMARY KEY, last_run_at TEXT)`);
    db.prepare('INSERT INTO hook_runs (hook, last_run_at) VALUES (?, ?)').run('post-commit', '2026-08-23 16:36:25');
    db.close();

    const s = find(census().signals, 'hooks.post-commit');
    expect(s.state).toBe('live');
    expect(s.value).toContain('2026-08-23');
  });
});

describe('it does not write to the database it reads', () => {
  it('leaves the file byte-identical', () => {
    // Opened readOnly by construction. Pinned because this tool is pointed
    // at the user's real graph by default, and a census that mutated what it
    // measured would be worse than no census.
    seed({ citation_sessions_total: '4' }, 2);
    const before = fs.readFileSync(dbPath);
    census();
    expect(fs.readFileSync(dbPath).equals(before), 'the census modified the database it was reading').toBe(true);
  });
});
