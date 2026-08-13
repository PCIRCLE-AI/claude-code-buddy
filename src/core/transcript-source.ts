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
// guard did not filter it — the `hook_runs` heartbeat and doctor's
// hook-activity check exist because that chain breaks often). The files
// themselves are on disk regardless. A batch that reads them directly is
// dropout-proof.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { memeshDir } from './paths.js';

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
 *
 * The scheme is LOSSY: every non-alphanumeric char collapses to '-', so
 * `/p/my-project` and `/p/my_project` map to the SAME slug directory. That
 * would let a "current project only" scan pull in a sibling project's
 * sessions and stamp them with the current project's tag. `recordedCwd` +
 * the per-session check in `scanTranscripts` closes that hole: Claude Code
 * writes the real absolute `cwd` on each conversation entry, so a session
 * whose recorded cwd does not match the scanned project is skipped.
 */
export function projectTranscriptSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The first absolute `cwd` Claude Code recorded in a transcript, or null if
 * none is present in the scanned prefix. The opening lines of a transcript are
 * session metadata (leafUuid / mode / permissionMode) with no `cwd`; it first
 * appears on the first real conversation entry, so scanning only line 1 would
 * find nothing on essentially every real file and the collision guard would
 * silently never fire. We scan a bounded prefix (the caller passes the first
 * chunk of the file it already holds) and stop at the first `cwd`.
 */
export function recordedCwd(text: string): string | null {
  let seen = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (++seen > 40) break; // bounded: metadata preamble is only a few lines
    try {
      const entry = JSON.parse(line) as { cwd?: unknown };
      if (typeof entry.cwd === 'string' && entry.cwd.length > 0) return entry.cwd;
    } catch {
      // A malformed line in the preamble must not abort the scan.
    }
  }
  return null;
}

/**
 * Do two paths point at the same project? Normalised compare first (collapses
 * `.`/`..`, doubled slashes — the common cosmetic difference, and it needs no
 * I/O). Only if that says "different" do we pay for `fs.realpathSync` on both,
 * which resolves symlinks (macOS `/tmp`→`/private/tmp`, Linux bind mounts) — so
 * a session recorded under a symlinked root is NOT falsely skipped as a sibling
 * project. realpath throws on a path that no longer exists; that failure falls
 * back to "different" (the prior fail-closed behaviour), so an unresolvable
 * recorded cwd is still skipped rather than wrongly claimed.
 */
function sameProjectPath(a: string, b: string): boolean {
  if (path.normalize(a) === path.normalize(b)) return true;
  try {
    if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
  } catch { /* one side unresolvable — cannot prove equivalence, treat as different */ }
  return false;
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

    // Open ONCE, then stat and read through that same descriptor. Doing
    // statSync(path) to decide and then readFileSync(path) to use is a
    // time-of-check-to-time-of-use race (CodeQL js/file-system-race): the
    // path could point at a different inode between the two calls. Binding
    // both to one fd means the window check and the byte count describe the
    // exact same open file, and a symlink swap after open cannot redirect us.
    let fd: number;
    try {
      fd = fs.openSync(full, 'r');
    } catch {
      continue; // vanished between readdir and open — skip
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoffMs) continue;

      // Count newlines off the same fd. readFileSync(fd) reads the already
      // open descriptor from its current offset to EOF — no second path
      // resolution, so nothing to race against.
      const buf = fs.readFileSync(fd);
      let lineCount = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lineCount++;

      // Slug-collision guard (see projectTranscriptSlug): if this session
      // recorded a cwd and it is NOT the project we are scanning, it belongs
      // to a sibling project that collapsed to the same slug dir — skip it so
      // the "current project only" promise holds. Decode only a bounded prefix
      // of the buffer we already read (no new I/O, no new path resolution).
      //
      // Compare via sameProjectPath (normalised, then symlink-resolved) so a
      // cosmetic OR a symlink difference (macOS /tmp vs /private/tmp) does not
      // cause a false skip. Still FAIL-CLOSED: a present-but-genuinely-different
      // recorded cwd is dropped so the "current project only" promise holds.
      const prefix = buf.subarray(0, Math.min(buf.length, 65536)).toString('utf8');
      const sessionCwd = recordedCwd(prefix);
      if (sessionCwd !== null && !sameProjectPath(sessionCwd, cwd)) continue;

      sessions.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        path: full,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        lineCount,
        sizeBytes: stat.size,
      });
    } catch {
      continue; // unreadable after open — skip, do not fabricate a count
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed / gone */ }
    }
  }

  // Most-recent first — the window's freshest sessions are the ones a mine
  // pass should prioritise under a max-calls budget.
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return sessions;
}

// -----------------------------------------------------------------------------
// Scheduled-mining throttle state (B4)
//
// memesh has no daemon, so `dream run --from-transcripts --if-due` is fired by a
// user cron/launchd entry and self-throttles: it records when it last mined a
// project and refuses to run again until an interval has elapsed. The timestamp
// lives in a small JSON file next to the database (like the update-check cache).
// Keyed BY PROJECT so mining one project on its schedule does not reset another.
// The path is overridable for tests so they never read/write the real ~/.memesh.
// -----------------------------------------------------------------------------

/** Where the per-project last-mined timestamps are stored. */
export function transcriptMiningStatePath(override?: string): string {
  if (override && override.trim() !== '') return override;
  return path.join(memeshDir(), 'transcript-mining.json');
}

/**
 * Epoch-ms of the last mined run for `projectKey`, or null if never (or the
 * state is missing/unreadable/corrupt — all of which mean "due", never a throw:
 * a broken throttle file must not wedge the schedule shut).
 */
export function lastTranscriptMineAt(projectKey: string, override?: string): number | null {
  try {
    const raw = fs.readFileSync(transcriptMiningStatePath(override), 'utf8');
    const parsed = JSON.parse(raw) as { projects?: Record<string, number> };
    const at = parsed?.projects?.[projectKey];
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Record that `projectKey` was mined at `atMs`. Merges into the existing file so
 * other projects' timestamps survive. Best-effort: a write failure is swallowed
 * (the next run just mines again — over-mining is recoverable, a crash is worse).
 */
export function recordTranscriptMine(projectKey: string, atMs: number, override?: string): void {
  const target = transcriptMiningStatePath(override);
  const state: { projects: Record<string, number> } = { projects: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { projects?: Record<string, number> };
    if (parsed && typeof parsed.projects === 'object' && parsed.projects) state.projects = parsed.projects;
  } catch { /* no prior file / unreadable — start fresh */ }
  state.projects[projectKey] = atMs;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

/**
 * Is a mine pass due? Pure decision so the throttle is unit-testable without
 * clocks or files. `null`/absent last-run means never mined → due. A negative or
 * NaN interval is treated as "always due" (0-floor), never as a lockout.
 */
export function transcriptMiningDue(nowMs: number, lastMs: number | null, intervalHours: number): boolean {
  if (lastMs === null) return true;
  // A last-run stamped in the FUTURE (clock moved back, NTP correction, a state
  // file copied from a machine ahead in time) is bogus. Left alone, `now - last`
  // is negative and stays below the interval until wall-clock catches up —
  // wedging the schedule shut for hours with no signal. Treat it as due and let
  // the next run re-stamp a sane time.
  if (lastMs > nowMs) return true;
  // A non-finite or negative interval floors to 0 (always due) — never a NaN
  // comparison, which is always false and would silently WEDGE the schedule shut.
  const hours = Number.isFinite(intervalHours) ? Math.max(0, intervalHours) : 0;
  return nowMs - lastMs >= hours * 3600_000;
}
