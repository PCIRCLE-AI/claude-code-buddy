import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Non-git identity = basename + real-path hash (tests/core/project-identity.test.ts).
const { getProjectName: mirrorProjectName } = require('../../scripts/hooks/_shared.js');

describe('Feature: Session Summary (Stop Hook)', () => {
  let testDir: string;
  let dbPath: string;
  let transcriptPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-session-summary-test-'));
    dbPath = path.join(testDir, 'test.db');
    transcriptPath = path.join(testDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeTranscript(entries: object[]): void {
    fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n'));
  }

  function runHook(input: object, env: Record<string, string> = {}): string {
    const hookPath = path.resolve('scripts/hooks/session-summary.js');
    const jsonInput = JSON.stringify(input);
    try {
      return execFileSync('node', [hookPath], {
        input: jsonInput,
        env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined, ...env },
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch (err: any) {
      // Hook may exit 0 before reading all stdin — that's OK
      return err.stdout || '';
    }
  }

  // Like runHook but captures stderr regardless of exit code (execFileSync
  // only surfaces stderr when the process throws; the hook exits 0).
  function runHookCapturingStderr(input: object, env: Record<string, string> = {}): { stderr: string } {
    const hookPath = path.resolve('scripts/hooks/session-summary.js');
    const res = spawnSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
    return { stderr: res.stderr || '' };
  }

  /** A transcript with enough tool calls to clear the low-signal guard. */
  function writeQualifyingTranscript(): void {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...['parser.ts', 'lexer.ts', 'ast.ts', 'tokens.ts'].map((f) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
      })),
    ]);
  }

  it('Scenario: the hook does not load sqlite-vec — it has never used it', () => {
    // Not a style rule. This hook runs two statements, neither of them a
    // vector query, and `captureEntity` touches no vectors either — but it
    // used to load sqlite-vec anyway, "for embedding-aware recall-effectiveness
    // tracking" that does not exist. sqlite-vec ships its engine as a
    // per-platform file, so on a platform it does not publish that load threw
    // and took the ENTIRE Stop capture with it. Measured: 0 entities against a
    // control run's 1, plus a `Require stack:` dump on stderr.
    //
    // A behavioural test would have to hide a package from node_modules, which
    // is global state in a serial suite. This asserts the thing that actually
    // regressed: the dependency coming back.
    // Comments stripped first: the invariant is about CODE. The block above
    // this test's subject explains the removal and names the very calls being
    // banned, and a naive match on the raw file flags that prose.
    const code = fs.readFileSync(path.resolve('scripts/hooks/session-summary.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'session-summary reached for sqlite-vec again').not.toMatch(/require\(['"`]sqlite-vec/);
    expect(code).not.toMatch(/sqliteVec\.load/);
    expect(code).not.toMatch(/enableLoadExtension/);
    // Anti-vacuity: the stripper must not have eaten the whole file.
    expect(code).toContain('openHookDb');
  });

  it('Scenario: no cwd in the payload -> nothing captured, and the reason is traced', () => {
    // `cwd` decides the project tag, and the project tag decides which sessions
    // session-start injects and which memories pre-edit-recall surfaces. The
    // old fallback to `process.cwd()` — the hook process's launch directory,
    // unspecified for a Stop hook — filed the session under whatever happened
    // to be current. Measured: a payload with no cwd tagged the whole session
    // `project:memesh-llm-memory`, leaking one project's files, commands and
    // errors into another project's context.
    writeQualifyingTranscript();
    const { stderr } = runHookCapturingStderr({
      session_id: 'no-cwd-session',
      transcript_path: transcriptPath,
    });
    expect(stderr).toContain('cwd absent');
    expect(fs.existsSync(dbPath), 'a session was filed under a guessed project').toBe(false);
  });

  it('Scenario: a payload WITH cwd still captures (the guard is not a blanket refusal)', () => {
    writeQualifyingTranscript();
    runHook({ session_id: 'with-cwd-session', transcript_path: transcriptPath, cwd: '/tmp/realproject' });
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readOnly: true });
    try {
      const names = (db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map((r) => r.name);
      expect(names.length).toBeGreaterThanOrEqual(1);
      const tags = (db.prepare('SELECT DISTINCT tag FROM tags').all() as Array<{ tag: string }>).map((r) => r.tag);
      expect(tags).toContain(`project:${mirrorProjectName('/tmp/realproject')}`);
      // The provenance marker, asserted against the DATABASE rather than the
      // source text. `tests/auto-capture-provenance.test.ts` greps for the
      // constant, which the import line alone satisfies — mutation-verified:
      // dropping AUTO_CAPTURE_TAG from this hook's baseTags left that test and
      // all 19 hook files green. This is what `memesh doctor` counts to answer
      // "is the auto-capture loop alive"; without it this hook's captures stop
      // being counted and the row stays green on the other three writers.
      expect(tags, 'session-summary stopped marking what it writes as auto-captured')
        .toContain('source:auto-capture');
    } finally {
      db.close();
    }
  });

  it('Scenario: an unreadable transcript traces to stderr instead of silently emptying capture', () => {
    // A directory at the transcript path makes readFileSync throw EISDIR
    // (not ENOENT) — stands in for a permission/IO fault on a real file.
    const dirAsTranscript = path.join(testDir, 'transcript-is-a-dir');
    fs.mkdirSync(dirAsTranscript);
    const { stderr } = runHookCapturingStderr({
      session_id: 'test-unreadable',
      transcript_path: dirAsTranscript,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
    });
    expect(stderr).toContain('[memesh session-summary]');
    expect(stderr).toContain('unreadable');
  });

  it('Scenario: a MISSING transcript does not emit the unreadable trace (normal case)', () => {
    const { stderr } = runHookCapturingStderr({
      session_id: 'test-missing',
      transcript_path: path.join(testDir, 'never-created.jsonl'),
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
    });
    expect(stderr).not.toContain('unreadable');
  });

  function openDb(): Database {
    return new Database(dbPath, { readOnly: true });
  }

  it('Scenario: Agentic session with file edits creates session-insight entity', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/proj/src/config.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All tests passed' }] } },
    ]);

    runHook({
      session_id: 'test-sess-001',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const entity = db.prepare("SELECT * FROM entities WHERE name LIKE 'session-test-ses%'").get() as any;
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('session-insight');

    const obs = db.prepare('SELECT content FROM observations WHERE entity_id = ?').all(entity.id) as any[];
    const filesObs = obs.find((o: any) => o.content.includes('auth.ts'));
    expect(filesObs).toBeTruthy();
    db.close();
  });

  it('Regression: session-insight memory is FTS-recallable (was written but never indexed)', () => {
    // Root-cause guard for the fake-working bug: storeMemory used to insert
    // entity + observations + tags but skip entities_fts, so every session
    // memory was invisible to `recall` and pre-edit-recall (both FTS paths).
    // There is no FTS trigger and no rebuild-on-open, so the omission was total.
    // captureEntity() now owns the write dance and keeps FTS in sync.
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/authentication.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/proj/src/config.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All tests passed' }] } },
    ]);

    runHook({
      session_id: 'test-fts-recall',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const entity = db.prepare("SELECT id FROM entities WHERE name = 'session-test-fts-recall-files'").get() as any;
    expect(entity).toBeTruthy();

    // The observation text contains the edited filename token — it must be
    // reachable through the FTS5 index, not just the entities table.
    const ftsRowids = (db.prepare(
      "SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'authentication'",
    ).all() as any[]).map((r) => r.rowid);
    expect(ftsRowids).toContain(entity.id);
    db.close();
  });

  it('Scenario: producer writes file: tags that pre-edit-recall Strategy 1 queries', () => {
    // The capture is the PRODUCER for pre-edit-recall's `file:<name>` lookup.
    // Before this, nothing wrote those tags, so Strategy 1 returned zero rows
    // on every real DB. Assert both forms are emitted: full basename and the
    // extension-less form, since the read path queries `file:auth.ts` OR
    // `file:auth`.
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/proj/src/config.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'done' }] } },
    ]);

    runHook({
      session_id: 'test-filetags',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
    });

    const db = openDb();
    const entity = db.prepare("SELECT id FROM entities WHERE name = 'session-test-filetags-files'").get() as any;
    expect(entity).toBeTruthy();
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entity.id) as any[]).map((r) => r.tag);
    expect(tags).toContain('file:auth.ts');
    expect(tags).toContain('file:auth');
    expect(tags).toContain('file:config.ts');
    expect(tags).toContain('file:config');
    db.close();
  });

  it('Scenario: Session with errors creates bugfix entity', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      // Real Claude Code marks failed tool calls with `is_error: true`.
      // The parser now trusts this flag instead of substring-matching
      // the result text (which produced 315 false errors against ~28
      // real ones on a 47MB production transcript).
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Error: Cannot find module ./config' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/config.ts' } }] } },
    ]);

    runHook({
      session_id: 'test-sess-002',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const fixEntity = db.prepare("SELECT * FROM entities WHERE name LIKE 'session-test-ses%-fixes'").get() as any;
    expect(fixEntity).toBeTruthy();

    const tags = db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(fixEntity.id) as any[];
    const hasBugfixTag = tags.some((t: any) => t.tag === 'type:bugfix');
    expect(hasBugfixTag).toBe(true);
    db.close();
  });

  it('Scenario: Non-agentic session is skipped (explicit was_in_agentic_loop: false)', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
    ]);

    runHook({
      session_id: 'test-sess-003',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: false,
    });

    // Nothing captured — but the bail is a CORRECT decision on a well-formed
    // payload, so it stamps the heartbeat: a user whose sessions are
    // consistently non-agentic must not read as "capture has stopped".
    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(count.c).toBe(0);
    expect(run, 'a correct non-agentic bail must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a transcript that VANISHED after the payload named it still stamps', () => {
    // Log-rotation race: the payload carried transcript_path but the file is
    // gone by the time the hook runs. The hook itself worked correctly —
    // this must stamp, unlike the schema-flip bail where the FIELD is
    // absent (no-cwd test pins that side: DB never even created).
    runHook({
      session_id: 'vanished-transcript',
      transcript_path: path.join(testDir, 'rotated-away.jsonl'),
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(run, 'a vanished transcript is a correct nothing-to-do decision').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: an UNREADABLE transcript leaves no heartbeat — capture was lost, not skipped', () => {
    // Permission/I-O failure while reading: parseTranscript returns zeros,
    // which are indistinguishable from a quiet session — except for the
    // readFailed flag. Stamping here would keep doctor green through
    // repeated read failures while every session's capture is lost.
    // Root reads through chmod 000; Windows maps it differently — same
    // skip guard as tests/hooks/session-start-unwritable.test.ts.
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
    writeQualifyingTranscript();
    fs.chmodSync(transcriptPath, 0o000);
    try {
      const { stderr } = runHookCapturingStderr({
        session_id: 'unreadable-session',
        transcript_path: transcriptPath,
        cwd: '/tmp/myproject',
        was_in_agentic_loop: true,
      });
      expect(stderr).toContain('unreadable');
      expect(fs.existsSync(dbPath), 'a lost capture must not create a DB just to stamp itself alive').toBe(false);
    } finally {
      fs.chmodSync(transcriptPath, 0o644);
    }
  });

  // Regression: production Stop payloads were silently omitting
  // `was_in_agentic_loop` for an unknown number of Claude Code releases,
  // and the hook's default-deny gate (treat absent as false) caused zero
  // session-insight entities to ever be written. Default-allow now: only
  // an EXPLICIT `false` skips. This pins the new contract.
  it('Scenario: Missing was_in_agentic_loop field still captures (default-allow)', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/proj/README.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'pass' }] } },
    ]);

    runHook({
      session_id: 'test-sess-noflag',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      // no was_in_agentic_loop — simulates current Claude Code Stop payload
    });

    expect(fs.existsSync(dbPath)).toBe(true);
    const db = openDb();
    const insights = db.prepare("SELECT COUNT(*) as c FROM entities WHERE type = 'session-insight'").get() as any;
    expect(insights.c).toBeGreaterThan(0);
    db.close();
  });

  it('Scenario: low-signal session (< 3 tool calls) is skipped', () => {
    // This previously claimed to test a `stop_reason === 'user_interrupt'`
    // guard, feeding a stop_reason the Stop payload never carries — so the
    // guard was dead and the session was actually skipped by the toolCallCount
    // filter below (2 tool calls < 3). The guard has been removed; this now
    // honestly tests the real low-signal filter, which is what does the work.
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All passed' }] } },
    ]);

    runHook({
      session_id: 'test-sess-004',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    if (fs.existsSync(dbPath)) {
      const db = openDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
      expect(count.c).toBe(0);
      db.close();
    }
  });

  it('Scenario: a low-signal bail still stamps the heartbeat — a quiet day is not a dead hook', () => {
    // The <3-tool-call bail is a correct decision on a well-formed payload,
    // so it stamps hook_runs. Without the stamp, a stretch of light sessions
    // reads to doctor exactly like "session-summary died". The schema-flip
    // bails (no cwd, malformed JSON) sit ABOVE the stamp on purpose — the
    // no-cwd test asserts the DB is never even created there.
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);

    runHook({
      session_id: 'light-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(count.c, 'a light session must not be captured').toBe(0);
    expect(run, 'a correct nothing-to-do decision must stamp the heartbeat').toBeDefined();
    expect(run!.run_count).toBe(1);
  });

  it('Scenario: a run that dies mid-capture leaves NO heartbeat', () => {
    // An entities table missing the `metadata` column survives openHookDb
    // (CREATE IF NOT EXISTS) and makes captureEntity throw; the outer catch
    // exits without reaching the end-of-run stamp. A crashed capture must
    // not look alive to doctor.
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

    writeQualifyingTranscript();
    runHook({
      session_id: 'poisoned-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    const runs = db.prepare("SELECT hook FROM hook_runs WHERE hook = 'session-summary'").all();
    db.close();
    expect(count.c, 'precondition: capture must actually have failed').toBe(0);
    expect(runs, 'a crashed capture run must not look alive').toHaveLength(0);
  });

  it('Scenario: a write that fails WITHOUT throwing leaves no new heartbeat', () => {
    // captureEntity's silent failure mode: a RAISE(IGNORE) trigger swallows
    // the INSERT, captureEntity returns null, nothing throws. The poisoned
    // crash test above cannot reach this path, so the writeFailed gate on the
    // end-of-run stamp is what this pins.
    writeQualifyingTranscript();
    runHook({
      session_id: 'first-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const setup = new Database(dbPath);
    setup.exec('CREATE TRIGGER block_inserts BEFORE INSERT ON entities BEGIN SELECT RAISE(IGNORE); END;');
    setup.close();

    runHook({
      session_id: 'swallowed-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const entity = db.prepare("SELECT id FROM entities WHERE name LIKE 'session-swallowe%'").get();
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    db.close();
    expect(entity, 'precondition: the trigger must actually have swallowed the write').toBeUndefined();
    expect(run!.run_count, 'a run that landed nothing must not stamp on top of the first run').toBe(1);
  });

  it('Scenario: Auto-capture opt-out skips processing', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All passed' }] } },
    ]);

    runHook(
      {
        session_id: 'test-sess-005',
        transcript_path: transcriptPath,
        cwd: '/tmp/myproject',
        stop_reason: 'end_turn',
        was_in_agentic_loop: true,
      },
      { MEMESH_AUTO_CAPTURE: 'false' },
    );

    if (fs.existsSync(dbPath)) {
      const db = openDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
      expect(count.c).toBe(0);
      db.close();
    }
  });

  it('Scenario: Heavy session (20+ tool calls) creates summary entity', () => {
    const entries: object[] = [];
    for (let i = 0; i < 22; i++) {
      entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo "step ${i} of build"` } }] } });
    }
    entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/main.ts' } }] } });

    writeTranscript(entries);

    runHook({
      session_id: 'test-sess-006',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    const summaryEntity = db.prepare("SELECT * FROM entities WHERE name LIKE 'session-test-ses%-summary'").get() as any;
    expect(summaryEntity).toBeTruthy();

    const tags = db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(summaryEntity.id) as any[];
    const hasHeavyTag = tags.some((t: any) => t.tag === 'type:heavy-session');
    expect(hasHeavyTag).toBe(true);
    db.close();
  });

  it('Scenario: Duplicate session is not re-captured', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'All passed' }] } },
    ]);

    const hookInput = {
      session_id: 'test-sess-007',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    };

    // Run hook twice with same session ID
    runHook(hookInput);
    runHook(hookInput);

    const db = openDb();
    const entities = db.prepare("SELECT * FROM entities WHERE name LIKE 'session-test-ses%'").all();
    // Should have exactly 1 entity (not duplicated)
    expect(entities.length).toBe(1);

    // Both runs stamp the heartbeat: a dedup bail is a SUCCESSFUL run — the
    // loop executed and correctly decided there was nothing to do. If the
    // bail stopped stamping, a day of already-captured sessions would read
    // as "capture stopped" in doctor.
    const run = db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get() as
      { run_count: number } | undefined;
    expect(run, 'session-summary must stamp its heartbeat').toBeDefined();
    expect(run!.run_count, 'the dedup bail must stamp too — it is a successful run').toBe(2);
    db.close();
  });

  it('Scenario: LLM analysis section does not run without LLM config (Level 0)', () => {
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/auth.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --run' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'Error: Cannot find module ./config' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/proj/src/config.ts' } }] } },
    ]);

    runHook({
      session_id: 'test-sess-008',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: true,
    });

    const db = openDb();
    // Should have session-insight entities (rule-based) but NO lesson_learned (LLM)
    const lessons = db.prepare("SELECT * FROM entities WHERE type = 'lesson_learned'").all();
    expect(lessons.length).toBe(0);

    // Rule-based extraction should still work
    const insights = db.prepare("SELECT * FROM entities WHERE type = 'session-insight'").all();
    expect(insights.length).toBeGreaterThan(0);
    db.close();
  });
});
