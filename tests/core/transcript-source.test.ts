import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  projectTranscriptSlug,
  scanTranscripts,
  claudeProjectsDir,
  recordedCwd,
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

describe('transcript-source slug-collision guard', () => {
  // projectTranscriptSlug is lossy: '/p/my-project' and '/p/my_project' both
  // map to '-p-my-project'. Without a per-session cwd check, scanning one would
  // pull in the other's sessions and stamp them with the wrong project tag.

  // Write a transcript whose entries record `recordCwd`. The first two lines are
  // metadata WITHOUT a cwd (mirrors real Claude Code files), so a guard that
  // only peeked line 1 would find nothing and never fire.
  function seedWithCwd(slugCwd: string, sessionId: string, recordCwd: string | null): void {
    const dir = path.join(root, projectTranscriptSlug(slugCwd));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'summary', leafUuid: 'x' }),
      JSON.stringify({ type: 'x', mode: 'default' }),
      JSON.stringify(recordCwd === null ? { type: 'user', text: 'hi' } : { type: 'user', cwd: recordCwd, text: 'hi' }),
    ];
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, new Date(), new Date());
  }

  it('recordedCwd finds the cwd past the metadata preamble, not just line 1', () => {
    const text = [
      JSON.stringify({ type: 'summary', leafUuid: 'x' }),
      JSON.stringify({ type: 'x', permissionMode: 'default' }),
      JSON.stringify({ type: 'user', cwd: '/p/my-project', text: 'hi' }),
    ].join('\n');
    expect(recordedCwd(text)).toBe('/p/my-project');
    // No cwd anywhere → null (best-effort; can't verify, so scan includes it).
    expect(recordedCwd(JSON.stringify({ type: 'user', text: 'hi' }))).toBe(null);
  });

  it('two slug-colliding projects each see only their OWN sessions', () => {
    // '/p/my-project' and '/p/my_project' collapse to the same slug dir.
    expect(projectTranscriptSlug('/p/my-project')).toBe(projectTranscriptSlug('/p/my_project'));
    seedWithCwd('/p/my-project', 'hyphen-sess', '/p/my-project');
    seedWithCwd('/p/my_project', 'underscore-sess', '/p/my_project');

    const hyphen = scanTranscripts({ cwd: '/p/my-project', windowDays: 3 });
    expect(hyphen.map((s) => s.sessionId)).toEqual(['hyphen-sess']);

    const underscore = scanTranscripts({ cwd: '/p/my_project', windowDays: 3 });
    expect(underscore.map((s) => s.sessionId)).toEqual(['underscore-sess']);
  });

  it('a session with NO recorded cwd is still included (best-effort, cannot verify)', () => {
    seedWithCwd('/p/solo', 'no-cwd-sess', null);
    const found = scanTranscripts({ cwd: '/p/solo', windowDays: 3 });
    expect(found.map((s) => s.sessionId)).toEqual(['no-cwd-sess']);
  });
});
