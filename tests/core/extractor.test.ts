import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RuleBasedExtractor, parseTranscript } from '../../src/core/extractor.js';
import type { SessionContext } from '../../src/core/extractor.js';

// =============================================================================
// RuleBasedExtractor — filtering rules
// =============================================================================

describe('RuleBasedExtractor: session filtering', () => {
  const extractor = new RuleBasedExtractor();

  it('skips interrupted sessions', () => {
    const ctx: SessionContext = {
      sessionId: 'abc12345',
      cwd: '/Users/test/project',
      stopReason: 'user_interrupt',
      wasAgenticLoop: true,
    };
    expect(extractor.extract(ctx)).toEqual([]);
  });

  it('skips non-agentic sessions', () => {
    const ctx: SessionContext = {
      sessionId: 'abc12345',
      cwd: '/Users/test/project',
      stopReason: 'end_turn',
      wasAgenticLoop: false,
    };
    expect(extractor.extract(ctx)).toEqual([]);
  });

  it('skips sessions without transcript path', () => {
    const ctx: SessionContext = {
      sessionId: 'abc12345',
      cwd: '/Users/test/project',
      stopReason: 'end_turn',
      wasAgenticLoop: true,
    };
    expect(extractor.extract(ctx)).toEqual([]);
  });

  it('returns empty gracefully when transcript path does not exist', () => {
    const ctx: SessionContext = {
      sessionId: 'abc12345',
      transcriptPath: '/nonexistent/path.jsonl',
      cwd: '/Users/test/myproject',
      stopReason: 'end_turn',
      wasAgenticLoop: true,
    };
    expect(extractor.extract(ctx)).toEqual([]);
  });
});

// =============================================================================
// RuleBasedExtractor — with real transcript fixture
// =============================================================================

describe('RuleBasedExtractor: memory extraction', () => {
  const extractor = new RuleBasedExtractor();
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-extractor-'));
    transcriptPath = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(entries: object[]): void {
    fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  }

  function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
      sessionId: 'abc12345deadbeef',
      transcriptPath,
      cwd: '/Users/test/myproject',
      stopReason: 'end_turn',
      wasAgenticLoop: true,
      ...overrides,
    };
  }

  it('skips session with fewer than 3 tool calls', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);
    expect(extractor.extract(makeCtx())).toEqual([]);
  });

  it('Rule 1: produces file-editing memory when files are edited', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/core/extractor.ts' } },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/src/core/types.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run typecheck' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memories = extractor.extract(makeCtx());
    const fileMemory = memories.find(m => m.name.endsWith('-files'));
    expect(fileMemory).toBeDefined();
    expect(fileMemory!.type).toBe('session-insight');
    expect(fileMemory!.observations[0]).toContain('extractor.ts');
    expect(fileMemory!.observations[0]).toContain('types.ts');
  });

  it('Rule 1: tags include source:auto-capture, session prefix, and project name', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memories = extractor.extract(makeCtx());
    const tags = memories[0]?.tags ?? [];
    expect(tags).toContain('source:auto-capture');
    // Tag now uses the FULL session id (not first-8-chars) so that
    // `tag = session:<id>` is a unique key per session — prevents
    // colliding shortIds from sharing a tag and aggregating lessons
    // as if they were the same session.
    expect(tags).toContain('session:abc12345deadbeef');
    expect(tags).toContain('project:myproject');
  });

  it('Rule 2: produces bugfix memory when errors and edits both present', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', is_error: true, content: 'Error: cannot find module ./extractor' },
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/core/extractor.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memories = extractor.extract(makeCtx());
    const fixMemory = memories.find(m => m.name.endsWith('-fixes'));
    expect(fixMemory).toBeDefined();
    expect(fixMemory!.tags).toContain('type:bugfix');
    expect(fixMemory!.observations[0]).toContain('Fixed');
  });

  it('Rule 2: no bugfix memory when errors present but no files edited', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
      { type: 'tool_result', is_error: true, content: 'Error: test failed' },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run lint' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
    ]);

    const memories = extractor.extract(makeCtx());
    expect(memories.find(m => m.name.endsWith('-fixes'))).toBeUndefined();
  });

  it('Rule 2 (regression): does NOT count tool_result that mentions "Error" but has is_error=false', () => {
    // The bug: a Read of README.md containing the word "Error" was
    // being counted as a session error. Real impact: a 47MB transcript
    // produced 315 fake "errors", drowning the LLM analyzer in noise.
    // The fix: trust the is_error flag, not substring matching.
    writeTranscript([
      { type: 'tool_use', tool_name: 'Read', tool_input: { file_path: '/repo/README.md' } },
      { type: 'tool_result', is_error: false, content: 'Errors are documented in the troubleshooting section' },
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } },
    ]);

    const memories = extractor.extract(makeCtx());
    expect(memories.find(m => m.name.endsWith('-fixes'))).toBeUndefined();
  });

  it('Rule 3: produces summary memory for sessions with 20+ tool calls', () => {
    const entries: object[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ type: 'tool_use', tool_name: 'Bash', tool_input: { command: `npm run step-${i}` } });
    }
    entries.push({ type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } });
    writeTranscript(entries);

    const memories = extractor.extract(makeCtx());
    const summaryMemory = memories.find(m => m.name.endsWith('-summary'));
    expect(summaryMemory).toBeDefined();
    expect(summaryMemory!.tags).toContain('type:heavy-session');
    expect(summaryMemory!.observations[0]).toContain('tool calls');
  });

  it('Rule 3: no summary memory for sessions under 20 tool calls', () => {
    writeTranscript([
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memories = extractor.extract(makeCtx());
    expect(memories.find(m => m.name.endsWith('-summary'))).toBeUndefined();
  });

  it('memory names embed the full session ID (no shortId truncation collisions)', () => {
    // Used to truncate to first 8 chars, which silently merged two
    // sessions whose IDs happened to share a prefix (verify-fix-001
    // vs verify-fix-002 both → "verify-f"). The dup-guard in the Stop
    // hook then skipped the second session entirely. Lock the full
    // ID into the name so this can never recur.
    writeTranscript([
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/x.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memories = extractor.extract(makeCtx());
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) {
      // Old behavior matched /^session-abc12345-/ (8-char prefix).
      // New behavior embeds the FULL session id so any two distinct
      // session_ids produce distinct entity names — even when they
      // share an 8-character prefix.
      expect(m.name).toContain('abc12345deadbeef');
    }
  });

  it('two session_ids that share an 8-char prefix produce DISTINCT entity names (regression)', () => {
    // Production-realistic UUIDs almost never collide on 8 chars,
    // but artificial / sequential IDs (verify-fix-001 vs -002) DO.
    // Either way, the contract is: distinct session_id → distinct
    // entity name. The Stop hook's alreadyCaptured guard depends on
    // this to avoid silent skips of subsequent sessions.
    writeTranscript([
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/x.ts' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);

    const memoriesA = extractor.extract(makeCtx({ sessionId: 'verify-fix-001-aaaaaaaa' }));
    const memoriesB = extractor.extract(makeCtx({ sessionId: 'verify-fix-002-bbbbbbbb' }));

    expect(memoriesA.length).toBeGreaterThan(0);
    expect(memoriesB.length).toBeGreaterThan(0);

    const namesA = memoriesA.map(m => m.name);
    const namesB = memoriesB.map(m => m.name);
    for (const name of namesA) {
      expect(namesB).not.toContain(name);
    }
  });
});

// =============================================================================
// parseTranscript — unit tests
// =============================================================================

describe('parseTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-transcript-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLine(filePath: string, entries: object[]): void {
    fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8');
  }

  it('returns zeroed result for non-existent file', () => {
    const result = parseTranscript('/no/such/file.jsonl');
    expect(result.toolCallCount).toBe(0);
    expect(result.filesEdited).toEqual([]);
    expect(result.bashCommands).toEqual([]);
    expect(result.errorsEncountered).toEqual([]);
  });

  it('skips malformed JSONL lines without throwing', () => {
    const p = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(p, 'not json\n{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"npm run build"}}\n{broken', 'utf8');
    const result = parseTranscript(p);
    expect(result.toolCallCount).toBe(1);
  });

  it('counts tool_use entries', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm run build' } },
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/a.ts' } },
    ]);
    expect(parseTranscript(p).toolCallCount).toBe(2);
  });

  it('extracts basenames from Write and Edit tool_input.file_path', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/deep/path/extractor.ts' } },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/other/types.ts' } },
    ]);
    const result = parseTranscript(p);
    expect(result.filesEdited).toContain('extractor.ts');
    expect(result.filesEdited).toContain('types.ts');
  });

  it('deduplicates repeated edits to the same file', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } },
      { type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/src/foo.ts' } },
    ]);
    expect(parseTranscript(p).filesEdited).toEqual(['foo.ts']);
  });

  it('ignores short or trivial bash commands', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'cd /tmp' } },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'short' } },
    ]);
    expect(parseTranscript(p).bashCommands).toEqual([]);
  });

  it('captures meaningful bash commands', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test -- --run' } },
    ]);
    expect(parseTranscript(p).bashCommands).toHaveLength(1);
    expect(parseTranscript(p).bashCommands[0]).toBe('npm test -- --run');
  });

  it('truncates long bash commands to 100 chars', () => {
    const p = path.join(tmpDir, 't.jsonl');
    const longCmd = 'npm run ' + 'x'.repeat(200);
    writeLine(p, [
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: longCmd } },
    ]);
    expect(parseTranscript(p).bashCommands[0].length).toBe(100);
  });

  it('captures tool_result entries flagged is_error: true', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_result', is_error: true, content: 'Error: Cannot find module ./foo' },
    ]);
    expect(parseTranscript(p).errorsEncountered).toHaveLength(1);
  });

  it('does not capture non-error tool_result content', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_result', is_error: false, content: 'Build successful' },
    ]);
    expect(parseTranscript(p).errorsEncountered).toHaveLength(0);
  });

  it('does NOT capture tool_result whose content contains "Error" word but is_error is false (regression)', () => {
    // Read of a doc/CHANGELOG/source file that contains the word
    // "Error" should not be counted as a real session error. The 47MB
    // production transcript exposed this: 315 fake errors vs ~28 real.
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      { type: 'tool_result', is_error: false, content: 'Error handling section starts on line 42' },
      { type: 'tool_result', is_error: false, content: 'CHANGELOG: Fixed Error in auth flow' },
      { type: 'tool_result', is_error: false, content: 'FAIL was renamed to FAILURE in v2' },
    ]);
    expect(parseTranscript(p).errorsEncountered).toEqual([]);
  });

  it('current-format: extracts is_error blocks from user/message.content', () => {
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', is_error: true, content: 'Bash exit 1: command not found' },
            { type: 'tool_result', is_error: false, content: 'README mentions Error class' },
          ],
        },
      },
    ]);
    expect(parseTranscript(p).errorsEncountered).toEqual(['Bash exit 1: command not found']);
  });

  it('current-format regression: ignores blocks missing the is_error flag entirely', () => {
    // Pre-flag transcripts (older Claude Code) had no is_error field.
    // Treat missing flag as not-an-error (false negative is safer than
    // the old false positive that flooded the LLM with noise).
    const p = path.join(tmpDir, 't.jsonl');
    writeLine(p, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: 'Error: anything' },
          ],
        },
      },
    ]);
    expect(parseTranscript(p).errorsEncountered).toEqual([]);
  });
});
