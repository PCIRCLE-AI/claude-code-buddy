import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

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
    fs.rmSync(testDir, { recursive: true, force: true });
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

  function openDb(): InstanceType<typeof import('better-sqlite3')> {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  }

  it('Scenario: Agentic session with file edits creates session-insight entity', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/tmp/proj/src/config.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', content: 'All tests passed' },
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

  it('Scenario: Session with errors creates bugfix entity', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', content: 'Error: Cannot find module ./config' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/config.ts' } },
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

  it('Scenario: Non-agentic session is skipped', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
    ]);

    runHook({
      session_id: 'test-sess-003',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'end_turn',
      was_in_agentic_loop: false,
    });

    // DB should not be created (or be empty) since non-agentic sessions are skipped
    if (fs.existsSync(dbPath)) {
      const db = openDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
      expect(count.c).toBe(0);
      db.close();
    }
  });

  it('Scenario: User interrupt is skipped', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', content: 'All passed' },
    ]);

    runHook({
      session_id: 'test-sess-004',
      transcript_path: transcriptPath,
      cwd: '/tmp/myproject',
      stop_reason: 'user_interrupt',
      was_in_agentic_loop: true,
    });

    if (fs.existsSync(dbPath)) {
      const db = openDb();
      const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
      expect(count.c).toBe(0);
      db.close();
    }
  });

  it('Scenario: Auto-capture opt-out skips processing', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', content: 'All passed' },
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
      entries.push({ type: 'tool_use', tool_name: 'Bash', tool_input: { command: `echo "step ${i} of build"` } });
    }
    entries.push({ type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/main.ts' } });

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
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_result', content: 'All passed' },
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
    db.close();
  });

  it('Scenario: LLM analysis section does not run without LLM config (Level 0)', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/auth.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', content: 'Error: Cannot find module ./config' },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/src/config.ts' } },
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
