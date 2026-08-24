/**
 * `citation_sessions_cited` is the numerator of the injection-ROI rate, and
 * it was counting a different thing from its denominator.
 *
 * The denominator, `citation_sessions_total`, counts sessions that RECEIVED
 * an injection. The numerator was `if (cited.size > 0)` — true whenever the
 * transcript contained any `[mem:N]` at all, for any N. A marker carried over
 * from an earlier session, or a number the agent simply invented, made the
 * session count as compliant. Three lines above, `recall_hits` had it right:
 * it credits an id only when THIS session injected it.
 *
 * The two are now literally the same measurement — the numerator is the count
 * the `recall_hits` loop already produces.
 *
 * The unconditional `INSERT … DO NOTHING` initialiser is pinned here too. It
 * exists so that "zero sessions cited" and "this code never ran" stop being
 * the same absent key, which is what a real database showed on 2026-08-24
 * (total=4, cited absent). Nothing tested it; deleting it left the suite
 * green.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import { removeTempDir } from '../helpers/temp-dir.js';

const require = createRequire(import.meta.url);
const { getProjectName: mirrorProjectName } = require('../../scripts/hooks/_shared.js');

describe('the compliance numerator counts what the denominator counts', () => {
  let testDir: string;
  let dbPath: string;
  let transcriptPath: string;
  const cwd = '/tmp/realproject';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-citation-num-'));
    dbPath = path.join(testDir, 'test.db');
    transcriptPath = path.join(testDir, 'transcript.jsonl');
  });

  afterEach(() => {
    removeTempDir(testDir);
  });

  function writeTranscript(entries: object[]): void {
    fs.writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n'));
  }

  function runHook(sessionId: string): void {
    try {
      execFileSync('node', [path.resolve('scripts/hooks/session-summary.js')], {
        input: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd }),
        env: { ...process.env, MEMESH_DB_PATH: dbPath, MEMESH_AUTO_CAPTURE: undefined },
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch {
      // The hook exits 0 before draining stdin on some platforms.
    }
  }

  /** Enough tool calls to clear the low-signal guard. */
  function editEntries(): object[] {
    return ['parser.ts', 'lexer.ts', 'ast.ts', 'tokens.ts'].map((f) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/' + f } }] },
    }));
  }

  function meta(key: string): string | undefined {
    const db = new Database(dbPath, { readOnly: true });
    try {
      return (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as
        { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  }

  /** Seed the schema, one entity, and the injected-set record for it. */
  function seed(): number {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...editEntries(),
    ]);
    runHook('seed-session');

    const db = new Database(dbPath);
    db.prepare("INSERT INTO entities (name, type) VALUES ('injected-decision', 'decision')").run();
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'injected-decision'").get() as { id: number }).id;
    db.close();

    const sessionsDir = path.join(path.dirname(dbPath), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'cite-1.json'), JSON.stringify({
      injectedAt: new Date().toISOString(),
      project: mirrorProjectName(cwd),
      entityIds: [id],
      entityNames: ['injected-decision'],
      injectedContext: 'unused-by-the-accounting',
    }));
    return id;
  }

  it('does not count a marker for an id this session never injected', () => {
    const id = seed();
    // The agent cites a DIFFERENT id — one carried over from an earlier
    // session, or invented. The denominator counts this session (it received
    // an injection); the numerator must not.
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...editEntries(),
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `per [mem:${id + 9999}] we keep it split` }] },
      },
    ]);

    runHook('cite-session');

    expect(meta('citation_sessions_total'), 'fixture: the session was not accounted at all').toBe('1');
    expect(meta('citation_sessions_cited'), 'a foreign marker counted as compliance').toBe('0');
  });

  it('DOES count a marker for an id this session injected — the anti-vacuity half', () => {
    // Without this, a numerator hardwired to 0 would satisfy the test above
    // and report every user as never citing anything.
    const id = seed();
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...editEntries(),
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `per [mem:${id}] we keep it split` }] },
      },
    ]);

    runHook('cite-session');

    expect(meta('citation_sessions_total')).toBe('1');
    expect(meta('citation_sessions_cited')).toBe('1');
  });

  it('writes a zero rather than leaving the key absent', () => {
    // "Zero sessions cited" and "this counter has never run" must not be the
    // same observation. Doctor branches on exactly this: an absent key is
    // reported as "not recorded yet", a present 0 as a real 0% rate.
    seed();
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'fix the parser' } },
      ...editEntries(),
    ]);

    runHook('cite-session');

    expect(meta('citation_sessions_cited'), 'a session with no citation left the counter absent').toBe('0');
  });
});
