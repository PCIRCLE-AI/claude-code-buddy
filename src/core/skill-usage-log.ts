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
//   - No PII other than what the caller passes in `payload`. Callers must
//     keep payloads metadata-only (counters, durations, pass/fail flags) —
//     never user content.
//
// Schema of a line:
//   { ts: ISO-8601 string, event: string, payload?: object }
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const TRUNCATE_KEEP = 6 * 1024 * 1024; // keep last 6 MB after truncation

function defaultLogPath(): string {
  return join(homedir(), '.memesh', 'skill-usage.jsonl');
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
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    // Rotate when the log reaches 1.2x the cap. Strict-less-than guards
    // against the edge case where the file is exactly at the threshold —
    // that should still trigger rotation.
    if (stat.size < MAX_BYTES * 1.2) return;
    // Read the tail (TRUNCATE_KEEP bytes) and rewrite the file with just
    // that tail, on a line boundary so we don't slice a JSON record.
    const buf = readFileSync(path);
    const sliceFrom = Math.max(0, buf.length - TRUNCATE_KEEP);
    const tail = buf.subarray(sliceFrom);
    const firstNl = tail.indexOf(0x0a); // '\n'
    const aligned = firstNl >= 0 ? tail.subarray(firstNl + 1) : tail;
    writeFileSync(path, aligned);
  } catch {
    /* swallow */
  }
}

export function logSkillEvent(event: string, payload?: Record<string, unknown>, path?: string): void {
  const target = path ?? defaultLogPath();
  try {
    ensureParent(target);
    rotateIfNeeded(target);
    const line = JSON.stringify({ ts: new Date().toISOString(), event, payload }) + '\n';
    appendFileSync(target, line);
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
