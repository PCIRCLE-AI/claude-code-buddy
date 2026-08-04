import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  projectTranscriptSlug,
  scanTranscripts,
  claudeProjectsDir,
} from '../../src/core/transcript-source.js';

// Discovery half of the transcript source (Task #18, B1). Every test points
// CLAUDE_PROJECTS_DIR at a temp dir — this suite never reads the developer's
// real ~/.claude/projects, and never writes anything anywhere but the temp
// dir it owns.

let root: string;
let prev: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-transcripts-'));
  prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = root;
});

afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
  else process.env.CLAUDE_PROJECTS_DIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

function seedSession(cwd: string, sessionId: string, lines: number, ageDays: number): string {
  const dir = path.join(root, projectTranscriptSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  const t = Date.now() - ageDays * 86400_000;
  fs.utimesSync(file, new Date(t), new Date(t));
  return file;
}

describe('transcript-source discovery', () => {
  it('slug mirrors Claude Code: every non-alphanumeric char becomes a dash', () => {
    expect(projectTranscriptSlug('/Users/kt/Dev/memesh-llm-memory'))
      .toBe('-Users-kt-Dev-memesh-llm-memory');
  });

  it('honours CLAUDE_PROJECTS_DIR so it never reads the real ~/.claude', () => {
    expect(claudeProjectsDir()).toBe(root);
  });

  it('lists only in-window .jsonl sessions for the given project, newest first', () => {
    const cwd = '/proj/alpha';
    seedSession(cwd, 'sess-fresh', 10, 0);
    seedSession(cwd, 'sess-old', 10, 30); // outside a 3-day window
    seedSession(cwd, 'sess-yesterday', 5, 1);
    // Noise that must be ignored:
    const dir = path.join(root, projectTranscriptSlug(cwd));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');

    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['sess-fresh', 'sess-yesterday']);
    expect(found[0].lineCount).toBe(10);
    expect(found[1].lineCount).toBe(5);
  });

  it('does not cross project boundaries — only the requested cwd is scanned', () => {
    seedSession('/proj/alpha', 'a1', 3, 0);
    seedSession('/proj/beta', 'b1', 3, 0);
    const found = scanTranscripts({ cwd: '/proj/alpha', windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('returns [] (never throws) when the project has no transcript dir', () => {
    expect(scanTranscripts({ cwd: '/proj/never-seen', windowDays: 3 })).toEqual([]);
  });

  it('skips an unreadable file rather than fabricating a line count', () => {
    const cwd = '/proj/gamma';
    seedSession(cwd, 'ok', 4, 0);
    const dir = path.join(root, projectTranscriptSlug(cwd));
    const bad = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(bad, 'x\ny\n');
    fs.utimesSync(bad, new Date(), new Date());
    // Make it unreadable on POSIX; on platforms where chmod is a no-op the
    // file simply reads normally and both sessions appear — either way no
    // fabricated count and no throw.
    try { fs.chmodSync(bad, 0o000); } catch { /* ignore */ }
    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.some((s) => s.sessionId === 'ok')).toBe(true);
    for (const s of found) expect(s.lineCount).toBeGreaterThan(0);
    try { fs.chmodSync(bad, 0o644); } catch { /* ignore */ }
  });

  it('binds stat and read to one fd — a path swap after readdir cannot mislead the count', () => {
    // Regression for the js/file-system-race (TOCTOU) CodeQL flagged: the
    // old code did statSync(path) then readFileSync(path), so the count and
    // the window decision could describe two different inodes. The scanner
    // now opens once and reads through that fd. We can't portably swap an
    // inode mid-call, but we can prove the count comes from the file's
    // actual bytes (not a re-stat) and that the loop is defensive: a file
    // that disappears between readdir and open is skipped, not fabricated.
    const cwd = '/proj/race';
    seedSession(cwd, 'real', 7, 0);
    const dir = path.join(root, projectTranscriptSlug(cwd));
    // A dangling entry: present at readdir, gone at open.
    const ghost = path.join(dir, 'ghost.jsonl');
    fs.writeFileSync(ghost, 'a\nb\n');
    fs.utimesSync(ghost, new Date(), new Date());
    fs.rmSync(ghost);
    const found = scanTranscripts({ cwd, windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['real']);
    expect(found[0].lineCount).toBe(7);
  });
});
