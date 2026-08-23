/**
 * The Stop hook copies two kinds of transcript text straight into the
 * knowledge graph: the bash command lines it saw, and the text of every
 * failed tool result.
 *
 * Both are the most likely place a credential appears in a session —
 * `export ANTHROPIC_API_KEY=sk-...` on a command line, an auth error echoing
 * back the `Authorization: Bearer ...` header it was sent. Neither was
 * redacted, so the secret became a permanent observation: searchable,
 * exportable, and included in the payload `analyzeFailure` sends to whatever
 * LLM provider the user configured.
 *
 * `redactSecrets` already existed and was already exported from the hooks'
 * own `_generated/core-paths.js`. Nothing called it.
 *
 * Redaction happens at the point the text ENTERS the process, not at the
 * three places it leaves, because the entry point is one line and the exits
 * are not enumerable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';

describe('secrets do not enter the graph', () => {
  let testDir: string;
  let dbPath: string;
  let transcriptPath: string;

  // Shapes `redactSecrets` recognises, each in the field it really turns up in.
  const API_KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-secret-capture-'));
    dbPath = path.join(testDir, 'test.db');
    transcriptPath = path.join(testDir, 'transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeTranscript(entries: object[]): void {
    fs.writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n'));
  }

  function runHook(): void {
    const hookPath = path.resolve('scripts/hooks/session-summary.js');
    try {
      execFileSync('node', [hookPath], {
        input: JSON.stringify({ session_id: 'secret-test', transcript_path: transcriptPath, cwd: testDir }),
        env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined },
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch {
      // The hook exits 0 before draining stdin on some platforms.
    }
  }

  /** Every observation the hook wrote, as one string. */
  function storedText(): string {
    if (!fs.existsSync(dbPath)) return '';
    const db = new Database(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT content FROM observations').all() as Array<{ content: string }>;
      return rows.map((r) => r.content).join('\n');
    } finally {
      db.close();
    }
  }

  /** 20+ tool calls, so the "heavy session" rule fires and stores commands. */
  function heavyTranscriptWithCommand(command: string): object[] {
    const entries: object[] = [{ type: 'user', message: { role: 'user', content: 'deploy it' } }];
    entries.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
    });
    for (let i = 0; i < 25; i++) {
      entries.push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `/repo/src/file${i}.ts` } }],
        },
      });
    }
    return entries;
  }

  it('does not store an API key that appeared on a bash command line', () => {
    writeTranscript(heavyTranscriptWithCommand(`export ANTHROPIC_API_KEY=${API_KEY} && npm run deploy`));
    runHook();

    const text = storedText();
    // Fixture first: if the hook stored nothing at all, "the key is absent"
    // is true and meaningless.
    expect(text, 'fixture: the hook wrote no observations').toContain('Command:');
    expect(text, 'an API key was stored verbatim as an observation').not.toContain(API_KEY);
    expect(text).toContain('REDACTED');
  });

  it('does not store a bearer token echoed back by a failed tool result', () => {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'call the api' } },
      ...['a.ts', 'b.ts', 'c.ts'].map((f) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
      })),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            is_error: true,
            content: `401 Unauthorized. Request sent with Authorization: ${BEARER}`,
          }],
        },
      },
    ]);
    runHook();

    const text = storedText();
    expect(text, 'fixture: the error rule did not fire').toContain('Error:');
    expect(text, 'a bearer token was stored verbatim as an observation').not.toContain(BEARER.split(' ')[1]);
    expect(text).toContain('REDACTED');
  });

  it('still stores the surrounding, non-secret text — the anti-vacuity half', () => {
    // Redaction that swallowed the whole line would satisfy both tests
    // above while destroying the observation's usefulness.
    writeTranscript(heavyTranscriptWithCommand('npm run deploy --workspace packages/api'));
    runHook();

    const text = storedText();
    expect(text).toContain('npm run deploy');
    expect(text, 'a command with no secret in it was redacted anyway').not.toContain('REDACTED');
  });
});
