// =============================================================================
// Skill-usage telemetry — strictly local, never uploaded
// =============================================================================
//
// Why this exists: the agentic-orchestration skill and the verify_agent_work
// MCP tool ship as part of v4.1 with the framing "an experimental
// working-model protocol". To make the framing honest we need to actually
// see whether the protocol fires in real usage. This module is the lightest
// possible local-only counter:
//
//   - Appends one JSON line per recorded event to ~/.memesh/skill-usage.jsonl
//   - Caps the file at ~10MB by truncating the head when it grows past
//     1.2x the cap (so we never lose recent activity)
//   - Failures (disk full, permission, etc.) are swallowed — telemetry must
//     never break the calling hook or core operation
//
// What is NOT in this module:
//
//   - No network call, ever. The data lives only on the user's machine. A
//     future opt-in `memesh patterns --skill-usage` reads it locally.
//   - No PII: only { ts, event } is written. There is deliberately no free-form
//     payload — an earlier one stored a hashed cwd and pass/fail metadata that
//     nothing ever read.
//
// Schema of a line:
//   { ts: ISO-8601 string, event: string }
//
// Known events emitted by the rest of the codebase:
//   "agentic_orchestration_banner_injected"  — session-start.js after the
//                                                banner is appended to the
//                                                additionalContext output
//   "verify_agent_work_invoked"               — core/verifier.ts after a
//                                                verification report is
//                                                persisted
//
// Anything else can be added later without breaking older readers — the
// schema is open-ended on `event` + `payload`.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { memeshDir } from './paths.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const TRUNCATE_KEEP = 6 * 1024 * 1024; // keep last 6 MB after truncation

function defaultLogPath(): string {
  return join(memeshDir(), 'skill-usage.jsonl');
}

function ensureParent(path: string): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore — caller will fail to write and we swallow that too */
  }
}

function rotateIfNeeded(path: string): void {
  // Single-syscall stat-via-open: the previous version did
  // existsSync → statSync → readFileSync → writeFileSync, which is a
  // four-step TOCTOU window — between any two steps another process
  // could write to the same path. CodeQL flagged this as
  // js/file-system-race. The fix replaces it with:
  //   1. open the file once for read; if it doesn't exist we abort early
  //   2. fstat that fd to get the size on the SAME inode we'll read from
  //   3. read the trailing TRUNCATE_KEEP bytes from that fd
  //   4. write the aligned tail to a sibling temp file
  //   5. atomically rename(temp → path)
  // After step 5, any concurrent appender that opened `path` after the
  // rename simply writes to the new (tail-only) inode. Lines that were
  // appended between steps 2 and 5 land in the OLD inode and are lost,
  // which is the only acceptable race window for a best-effort
  // telemetry log. Critically, the appender NEVER sees a half-truncated
  // file, which the previous read-truncate-write sequence could expose.
  let fd: number | null = null;
  let tmpPath: string | null = null;
  try {
    try {
      fd = openSync(path, 'r');
    } catch {
      return; // file gone or unreadable — nothing to rotate
    }
    const { size } = fstatSync(fd);
    if (size < MAX_BYTES * 1.2) return;

    const readLen = Math.min(TRUNCATE_KEEP, size);
    const offset = size - readLen;
    const buf = Buffer.alloc(readLen);
    let totalRead = 0;
    while (totalRead < readLen) {
      const n = readSync(fd, buf, totalRead, readLen - totalRead, offset + totalRead);
      if (n === 0) break;
      totalRead += n;
    }
    closeSync(fd);
    fd = null;

    const tail = buf.subarray(0, totalRead);
    const firstNl = tail.indexOf(0x0a); // '\n'
    const aligned = firstNl >= 0 ? tail.subarray(firstNl + 1) : tail;

    tmpPath = `${path}.rot.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, aligned, { mode: 0o600 });
    renameSync(tmpPath, path);
    tmpPath = null;
  } catch {
    /* swallow — telemetry rotation is best-effort */
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (tmpPath !== null) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

export function logSkillEvent(event: string, path?: string): void {
  const target = path ?? defaultLogPath();
  try {
    ensureParent(target);
    rotateIfNeeded(target);
    // Only { ts, event } is written. An earlier `payload` field carried
    // per-event metadata (hashed cwd, pass/fail, files_changed) that NO reader
    // ever consumed — summariseSkillUsage counts by `event` name only. Writing
    // unconsumed, privacy-adjacent data "in case we surface it later" is the
    // exact fake-working pattern this audit removed; if per-event stats are
    // wanted, add them together with their consumer.
    const line = JSON.stringify({ ts: new Date().toISOString(), event }) + '\n';
    appendFileSync(target, line);
    // Tighten mode after every append. appendFileSync's `mode` option only
    // applies on creation, but on shared systems we cannot rely on the file
    // being created via this path (the hook also writes it directly). chmod
    // is idempotent and cheap.
    try { chmodSync(target, 0o600); } catch { /* non-POSIX */ }
  } catch {
    /* never throw from telemetry */
  }
}

// -----------------------------------------------------------------------------
// Aggregation — used by `memesh patterns --skill-usage`
// -----------------------------------------------------------------------------

export interface SkillUsageSummary {
  total_events: number;
  events_by_name: Record<string, number>;
  first_event?: string;
  last_event?: string;
  log_path: string;
  log_bytes: number;
}

export function summariseSkillUsage(path?: string): SkillUsageSummary {
  const target = path ?? defaultLogPath();
  const out: SkillUsageSummary = {
    total_events: 0,
    events_by_name: {},
    log_path: target,
    log_bytes: 0,
  };
  if (!existsSync(target)) return out;
  let raw: string;
  try {
    const buf = readFileSync(target);
    out.log_bytes = buf.length;
    raw = buf.toString('utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: { ts?: string; event?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed.event || typeof parsed.event !== 'string') continue;
    out.total_events += 1;
    out.events_by_name[parsed.event] = (out.events_by_name[parsed.event] ?? 0) + 1;
    if (parsed.ts) {
      if (!out.first_event || parsed.ts < out.first_event) out.first_event = parsed.ts;
      if (!out.last_event || parsed.ts > out.last_event) out.last_event = parsed.ts;
    }
  }
  return out;
}
