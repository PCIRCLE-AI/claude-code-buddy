import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expectValidHookOutput, HOOK_SPECIFIC_OUTPUT_EVENTS } from '../helpers/hook-output-contract.js';

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
});
