import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

describe('Feature: PreCompact Hook', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-precompact-test-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
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

  function openDb(): InstanceType<typeof import('better-sqlite3')> {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  }

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

    // Output has correct structure
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('MeMesh');

    // Entity created in DB
    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-abc123');
    expect(entity).toBeTruthy();
    expect(entity.type).toBe('session-summary');

    // Tags present
    const tags = db.prepare('SELECT tag FROM tags WHERE entity_id = ?').all(entity.id).map((r: { tag: string }) => r.tag);
    expect(tags).toContain('source:auto-capture');
    expect(tags).toContain('urgency:pre-compact');
    expect(tags).toContain('project:myproject');

    db.close();
  });

  it('Scenario: Reason stored as observation', () => {
    const input = {
      session_id: 'sess-manual1',
      transcript_path: '',
      cwd: '/tmp/testproject',
      hook_event_name: 'PreCompact',
      reason: 'manual',
    };

    runHook(input);

    const db = openDb();
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-manual1');
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
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/foo.ts' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/bar.ts' } },
        { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/tmp/baz.ts' } },
      ],
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
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-transcript1');
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
    const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get('pre-compact-sess-notranscript');
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
    const entities = db.prepare('SELECT * FROM entities WHERE name = ?').all('pre-compact-sess-dup');
    expect(entities).toHaveLength(1);
    db.close();
  });

  it('Scenario: Output JSON has correct hookEventName', () => {
    const input = {
      session_id: 'sess-output-check',
      transcript_path: '',
      cwd: '/tmp/someproject',
      hook_event_name: 'PreCompact',
      reason: 'auto',
    };

    const result = runHook(input);
    const parsed = JSON.parse(result.trim());
    expect(parsed).toHaveProperty('hookSpecificOutput');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  });
});
