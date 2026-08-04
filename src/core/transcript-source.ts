// Mining Claude Code session transcripts as a dreamer input source.
//
// This module is the READ-ONLY discovery half (B1): it locates the JSONL
// transcripts Claude Code writes for a project and reports what is available
// to mine. It never calls an LLM, never writes to the graph, and never
// mutates a transcript — the extraction / dedup / staging halves (B2+) build
// on top of what this returns.
//
// Why a transcript source at all: the capture hook (session-summary) already
// parses these files, but only at session end and only if the hook fired
// (native binding built, hooks wired, session ended naturally, agentic-loop
// guard did not filter it — the `hook-activity.quiet` doctor check exists
// because that chain breaks often). The files themselves are on disk
// regardless. A batch that reads them directly is dropout-proof.

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Root of Claude Code's per-project transcript store. Override with
 * CLAUDE_PROJECTS_DIR for tests and non-default installs; otherwise
 * `~/.claude/projects`. HOME is honoured (the isolated test runner sets it),
 * so this never reads a developer's real transcripts under test.
 */
export function claudeProjectsDir(): string {
  const override = process.env.CLAUDE_PROJECTS_DIR;
  if (override && override.trim() !== '') return override;
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Claude Code names each project's transcript directory by taking the
 * project's absolute cwd and replacing every character that is not a letter
 * or digit with '-'. `/Users/kt/Dev/memesh` becomes
 * `-Users-kt-Dev-memesh`. This mirrors that scheme so a project can find its
 * own transcripts. It is a best-effort convention — if Claude Code changes
 * it, `scanTranscripts` degrades to "no sessions found", never throws.
 */
export function projectTranscriptSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface TranscriptSession {
  /** Session id = the transcript filename without .jsonl. */
  sessionId: string;
  /** Absolute path to the .jsonl file. */
  path: string;
  /** Last-modified time (ISO); the window filter and watermark use this. */
  modifiedAt: string;
  /** Total JSONL lines (cheap: a byte scan, not a parse). */
  lineCount: number;
  sizeBytes: number;
}

export interface ScanOptions {
  /** Project cwd whose transcripts to find. Defaults to process.cwd(). */
  cwd?: string;
  /** Only sessions modified within this many days. Default 3 (72h). */
  windowDays?: number;
  /** Test seam. */
  now?: Date;
}

/**
 * Enumerate the project's transcript sessions modified within the window.
 * Read-only and defensive: a missing directory, an unreadable file, or a
 * changed naming scheme yields an empty list, never an exception — a
 * discovery step must not be able to break a `dream run`.
 */
export function scanTranscripts(opts: ScanOptions = {}): TranscriptSession[] {
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const windowDays = opts.windowDays ?? 3;
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - windowDays * 86400_000;

  const dir = path.join(claudeProjectsDir(), projectTranscriptSlug(cwd));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no transcript dir for this project yet
  }

  const sessions: TranscriptSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // vanished between readdir and stat — skip
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoffMs) continue;

    let lineCount = 0;
    try {
      // Count newlines without holding the whole (possibly large) file as
      // one string longer than necessary; readFileSync is acceptable here
      // because we only run this on the in-window slice, but count by scan.
      const buf = fs.readFileSync(full);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lineCount++;
    } catch {
      continue; // unreadable — skip, do not fabricate a count
    }

    sessions.push({
      sessionId: name.replace(/\.jsonl$/, ''),
      path: full,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      lineCount,
      sizeBytes: stat.size,
    });
  }

  // Most-recent first — the window's freshest sessions are the ones a mine
  // pass should prioritise under a max-calls budget.
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return sessions;
}
