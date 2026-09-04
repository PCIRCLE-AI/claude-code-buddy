import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expectValidHookOutput, HOOK_SPECIFIC_OUTPUT_EVENTS } from '../helpers/hook-output-contract.js';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);
// Non-git identity = basename + real-path hash (tests/core/project-identity.test.ts).
const { getProjectName: mirrorProjectName } = require('../../scripts/hooks/_shared.js');

/**
 * The columns these assertions read off a `SELECT`. better-sqlite3 types
 * `.get()` and `.all()` as `unknown` — correctly, since it cannot know the
 * shape of an arbitrary query — so a test that reads columns has to say which
 * ones it is reading. Stating it here is the test declaring its own contract
 * with the schema; before this file was type-checked, it declared nothing and
 * `entity.typo` would have compiled.
 */
type Row = {
  id: number;
  name: string;
  type: string;
  content: string;
  tag: string;
};

describe('Feature: PreCompact Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-precompact-test-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runHook(input: object, env: Record<string, string> = {}): string {
    const hookPath = path.resolve('scripts/hooks/pre-compact.js');
    const jsonInput = JSON.stringify(input);
    return execFileSync('node', [hookPath], {
      input: jsonInput,
      env: { ...process.env, MEMESH_DB_PATH: dbPath, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  function openDb(): Database {
    return new Database(dbPath, { readOnly: true });
  }

  // spawnSync variant so stderr is visible regardless of exit code.
  function runHookStderr(input: object): string {
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const res = spawnSync('node', [path.resolve('scripts/hooks/pre-compact.js')], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    return res.stderr || '';
  }

  it('Scenario: an unreadable transcript traces to stderr (not a silent "0 insights")', () => {
    // A directory at the transcript path makes readFileSync throw EISDIR after
    // existsSync passes — stands in for a permission/IO fault on a real file.
    const dirAsTranscript = path.join(testDir, 'transcript-is-a-dir');
    fs.mkdirSync(dirAsTranscript);
    const stderr = runHookStderr({
      session_id: 'sess-unreadable',
      transcript_path: dirAsTranscript,
      cwd: '/tmp/myproject',
      trigger: 'auto',
    });
    expect(stderr).toContain('[memesh pre-compact]');
    expect(stderr).toContain('unreadable');
  });

  it('Scenario: payload with neither session_id nor transcript -> no entity, no "Saved" claim', () => {
    // `{"foo":1}` used to write a junk entity whose only content was
    // "Compaction reason: auto", answer "Saved 2 observations to MeMesh",
    // and that junk then surfaced in the NEXT session's context as a recent
    // memory. Not-an-event must mean no write and no claim of one.
    const result = runHook({ foo: 1 });
    expect(result.trim(), 'no output — nothing was saved, nothing may claim to be').toBe('');

    // The strongest possible form of "no entity": the database file was
    // never even created, because the hook skipped before touching it.
    expect(fs.existsSync(dbPath), 'no database may be created for a non-event').toBe(false);
  });

  it('Scenario: Basic pre-compact event -> entity created with correct type and tags', () => {
    const input = {
      session_id: 'sess-abc123',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    const result = runHook(input);
    const parsed = JSON.parse(result.trim());

    // Output must satisfy the real Claude Code contract, not a hand-written
    // shape. PreCompact has no `hookSpecificOutput` variant (#53).
    expectValidHookOutput(result, 'pre-compact output');
    expect(parsed.systemMessage).toContain('MeMesh');

    // Entity created in DB
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-abc123') as Row;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('session-summary');

    // Tags present
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entity.id) as Row[]).map((r) => r.tag);
    expect(tags).toContain('source:auto-capture');
    expect(tags).toContain('urgency:pre-compact');
    expect(tags).toContain(`project:${mirrorProjectName('/tmp/myproject')}`);

    // UX-1 title: date + project + what happened, marked heuristic. The raw
    // `pre-compact-<sessionId>` name was the clearest machine-key-as-label
    // case in the audit; the title is what the dashboard shows instead.
    const titled = db.prepare('SELECT title, metadata FROM entities WHERE name = ?')
      .get('pre-compact-sess-abc123') as { title: string | null; metadata: string | null };
    expect(titled.title).toMatch(/^\d{4}-\d{2}-\d{2} .+: auto compaction \(0 tool calls\)$/);
    expect(titled.title).toContain(mirrorProjectName('/tmp/myproject'));
    expect(JSON.parse(titled.metadata as string).title_source).toBe('heuristic');

    db.close();
  });

  it('Scenario: a successful run stamps the hook_runs heartbeat AFTER capture', () => {
    runHook({
      session_id: 'sess-heartbeat',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const db = openDb();
    const run = db.prepare("SELECT hook, run_count FROM hook_runs WHERE hook = 'pre-compact'").get() as
      { hook: string; run_count: number } | undefined;
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-heartbeat');
    db.close();

    expect(entity, 'capture itself must have happened for the stamp to mean anything').toBeTruthy();
    expect(run, 'a completed capture run must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a write that fails WITHOUT throwing leaves no new heartbeat', () => {
    // captureEntity's silent failure mode: a RAISE(IGNORE) trigger swallows
    // the INSERT and it returns null without throwing — the crash test below
    // never reaches this path. The `if (written)` gate on the stamp is what
    // keeps a landed-nothing run from reporting itself alive.
    runHook({
      session_id: 'sess-first',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const setup = new Database(dbPath);
    setup.exec('CREATE TRIGGER block_inserts BEFORE INSERT ON entities BEGIN SELECT RAISE(IGNORE); END;');
    setup.close();

    runHook({
      session_id: 'sess-swallowed',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const db = openDb();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-swallowed');
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'pre-compact'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'precondition: the trigger must actually have swallowed the write').toBeUndefined();
    expect(run!.run_count, 'a run that landed nothing must not stamp on top of the first run').toBe(1);
  });

  it('Scenario: a run that dies mid-capture leaves NO heartbeat', () => {
    // The heartbeat used to be stamped at openHookDb time, which made a hook
    // that opened the database and then crashed in captureEntity read as
    // "auto-capture is alive" in doctor for the next 24 hours — the exact
    // dead-loop-looks-healthy lie the hook_runs table exists to end.
    //
    // Poison the database so the run reaches captureEntity and throws there:
    // an entities table missing the `metadata` column survives openHookDb
    // (SCHEMA_SQL is CREATE IF NOT EXISTS; the migration chain only backfills
    // the columns it knows) and fails on captureEntity's INSERT.
    const poisoned = new Database(dbPath);
    poisoned.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    poisoned.close();

    const stderr = runHookStderr({
      session_id: 'sess-dies-mid-capture',
      transcript_path: '',
      cwd: '/tmp/myproject',
      trigger: 'auto',
    });
    expect(stderr, 'the capture failure must be visible, not swallowed').toContain('metadata');

    const db = openDb();
    const runs = db.prepare('SELECT hook FROM hook_runs').all();
    const entity = db.prepare('SELECT id FROM entities WHERE name = ?').get('pre-compact-sess-dies-mid-capture');
    db.close();

    expect(entity, 'precondition: capture must actually have failed').toBeUndefined();
    expect(runs, 'a crashed capture run must not look alive').toHaveLength(0);
  });

  it('Scenario: trigger (the real Claude Code field) stored as reason observation', () => {
    // Claude Code's PreCompact payload names the field `trigger`, not `reason`.
    // Feeding the REAL field proves the hook reads it; before the fix (which
    // read data.reason) this asserted 'auto' and the manual/auto distinction
    // was silently lost on every compaction.
    const input = {
      session_id: 'sess-manual1',
      transcript_path: '',
      cwd: '/tmp/testproject',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-manual1') as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as { content: string }[];
    const reasonObs = obs.find(o => o.content.startsWith('Compaction reason:'));
    expect(reasonObs?.content).toBe('Compaction reason: manual');
    db.close();
  });

  it('Scenario: Transcript with tool uses -> tool call count stored', () => {
    // Write a minimal transcript JSONL with tool_use blocks
    const transcriptPath = path.join(testDir, 'transcript.jsonl');
    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/foo.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/bar.ts' } },
          { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/tmp/baz.ts' } },
        ],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(assistantMsg) + '\n');

    const input = {
      session_id: 'sess-transcript1',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-transcript1') as Row;
    expect(entity).toBeTruthy();
    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id').all(entity.id) as { content: string }[];

    // Tool call count observation
    const toolObs = obs.find(o => o.content.startsWith('Tool calls:'));
    expect(toolObs?.content).toBe('Tool calls: 3');

    // Files edited observation (Edit + Write = 2 unique files)
    const filesObs = obs.find(o => o.content.startsWith('Files edited:'));
    expect(filesObs).toBeTruthy();
    expect(filesObs?.content).toContain('bar.ts');
    expect(filesObs?.content).toContain('baz.ts');

    db.close();
  });

  it('Scenario: MEMESH_AUTO_CAPTURE=false -> exits cleanly, no DB created', () => {
    const input = {
      session_id: 'sess-optout',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input, { MEMESH_AUTO_CAPTURE: 'false' });

    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Missing transcript path -> exits cleanly, entity still created', () => {
    const input = {
      session_id: 'sess-notranscript',
      transcript_path: '/nonexistent/path/transcript.jsonl',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-notranscript') as Row;
    expect(entity).toBeTruthy();
    db.close();
  });

  it('Scenario: Invalid JSON input -> exits cleanly (exit 0)', () => {
    const hookPath = path.resolve('scripts/hooks/pre-compact.js');
    // Must not throw
    execFileSync('node', [hookPath], {
      input: 'not-json-at-all',
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 15000,
    });
    // DB should not exist (errored before db open)
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('Scenario: Duplicate session_id -> no duplicate entities', () => {
    const input = {
      session_id: 'sess-dup',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    runHook(input);
    runHook(input);

    const db = openDb();
    const entities = db.prepare('SELECT * FROM entities WHERE name = ?').all('pre-compact-sess-dup') as Row[];
    expect(entities).toHaveLength(1);
    db.close();
  });

  it('Scenario: Output JSON satisfies the Claude Code hook-output contract', () => {
    const input = {
      session_id: 'sess-output-check',
      transcript_path: '',
      cwd: '/tmp/someproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    const result = runHook(input);
    expectValidHookOutput(result, 'pre-compact output');

    const parsed = JSON.parse(result.trim());
    expect(typeof parsed.systemMessage).toBe('string');
  });

  // Regression guard for #53. Claude Code has no `hookSpecificOutput` variant
  // for PreCompact, so emitting one fails validation at the root and surfaces
  // an error to the user on every single compaction. The previous version of
  // this test asserted the broken shape, which is why CI stayed green while
  // the bug shipped — assert the absence explicitly so it cannot come back.
  it('Scenario: Output never contains hookSpecificOutput (no PreCompact variant exists)', () => {
    const input = {
      session_id: 'sess-no-hso',
      transcript_path: '',
      cwd: '/tmp/someproject',
      hook_event_name: 'PreCompact',
      reason: 'manual',
    };

    const result = runHook(input);
    const parsed = JSON.parse(result.trim());

    expect(parsed).not.toHaveProperty('hookSpecificOutput');
    expect(HOOK_SPECIFIC_OUTPUT_EVENTS).not.toHaveProperty('PreCompact');
  });

  it('Scenario: says it could not save, rather than announcing a save that failed', () => {
    // `captureEntity` returns null when the entity row cannot be resolved after
    // its INSERT. The message used to print "Saved N insights" regardless, with
    // N derived from the transcript instead of from what was written — a
    // success-shaped report for a save that did not happen, which is the exact
    // class this release exists to remove.
    //
    // Forced with a CHECK constraint: `INSERT OR IGNORE` skips a row that
    // violates one, so the insert is silently dropped and the follow-up SELECT
    // finds nothing — captureEntity's null path, reached without stubbing it.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type <> 'session-summary'),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSON,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    seed.close();

    const result = runHook({
      session_id: 'sess-cannot-save',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    });

    const parsed = JSON.parse(result.trim());
    expect(parsed.systemMessage).toContain('could not save');
    expect(parsed.systemMessage).not.toMatch(/^Saved /);
  });
  /**
   * #240, widened. The Stop hook got a duplicate guard in 4.8.2; this hook did
   * not, and it is the one that runs MOST often per session — a session
   * compacts many times. On the maintainer's real graph that produced 2,188
   * duplicate observation rows across 58 `pre-compact-<sessionId>` entities
   * (worst: 220 observations, 2 distinct), and the entity for the session that
   * found the defect was still growing while it was being read.
   *
   * The guard is on CONTENT, not on "this session already has an entity",
   * because a session legitimately compacts more than once — the second test
   * below is the one an existence guard would fail.
   */
  it('Scenario: a second compaction of the same session appends no duplicate observation', () => {
    const input = {
      session_id: 'sess-repeat',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
    };
    runHook(input);
    runHook(input);
    runHook(input);

    const db = openDb();
    const rows = db.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all('pre-compact-sess-repeat') as Row[];
    const entities = db.prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ?').get('pre-compact-sess-repeat') as { n: number };
    db.close();

    expect(entities.n).toBe(1);
    expect(rows.map((r) => r.content)).toEqual(['Compaction reason: auto', 'Tool calls: 0']);
  });

  it('Scenario: a later compaction that recorded DIFFERENT work is still stored', () => {
    // What a per-session existence guard would have thrown away. The first
    // compaction saw nothing; the second saw a real transcript. Both are true,
    // and only the repeated line is dropped.
    const transcript = path.join(testDir, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/auth.ts' } }] },
    }) + '\n');

    runHook({ session_id: 'sess-grows', transcript_path: '', cwd: '/tmp/myproject', trigger: 'auto' });
    runHook({ session_id: 'sess-grows', transcript_path: transcript, cwd: '/tmp/myproject', trigger: 'manual' });

    const db = openDb();
    const rows = db.prepare(
      'SELECT o.content AS content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
    ).all('pre-compact-sess-grows') as Row[];
    db.close();

    expect(rows.map((r) => r.content)).toEqual([
      'Compaction reason: auto',
      'Tool calls: 0',
      'Compaction reason: manual',
      'Tool calls: 1',
      'Files edited: auth.ts',
    ]);
  });

  it('Scenario: a no-op re-capture does not claim "Saved 2 observations"', () => {
    // The message read `Saved ${obsLines.length}` — the count BUILT, not the
    // count stored. With the dedupe in place that sentence would announce a
    // save on a run that wrote nothing: a success-shaped lie of exactly the
    // kind this hook's own comments exist to prevent.
    const input = {
      session_id: 'sess-message',
      transcript_path: '',
      cwd: '/tmp/myproject',
      hook_event_name: 'PreCompact',
      trigger: 'auto',
    };
    const first = JSON.parse(runHook(input).trim());
    expect(first.systemMessage).toBe('Saved 2 observations to MeMesh before compaction');

    const second = JSON.parse(runHook(input).trim());
    expect(second.systemMessage).not.toMatch(/^Saved /);
    expect(second.systemMessage).toContain('already captured');
  });
});
