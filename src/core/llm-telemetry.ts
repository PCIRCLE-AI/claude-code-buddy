// =============================================================================
// LLM telemetry — persistence layer for callLLM attempts
// =============================================================================
//
// `callLLM` already exposes a per-attempt `onAttempt` callback (see
// llm-client.ts). This module is the storage adapter every Smart-Mode
// flow plugs into so the resulting trace lands in the `llm_telemetry`
// table. Once persisted, the dashboard's Insights / Analytics tabs
// can answer "what did memesh's LLM pipeline actually do this week"
// without hand-rolled stderr scraping.
//
// Why we record per attempt, not per call:
//
//   A primary->fallback chain (anthropic 401 -> ollama success) is
//   ONE high-level success but TWO distinct provider events. The
//   user needs both visible: anthropic's auth failure surfaces the
//   "rotate your key" reminder, ollama's success confirms the
//   fallback is doing its job. Collapsing to one row hides the
//   thing the failover system was built to surface.
//
// What is NOT recorded:
//
//   - Prompt body. The schema has no column for it — we'd take on a
//     privacy boundary the rest of memesh doesn't carry, and a
//     leaked telemetry DB would expose every secret that ever
//     transited through autotagger / dreamer prompts.
//   - Response body. Same reason; plus we'd duplicate dream_proposals
//     (which IS the structured response store).
//   - Token counts. Most providers expose them but not all, and the
//     formats diverge. Optional columns left NULL until a future
//     extension wires them.

import type Database from 'better-sqlite3';
import type { LLMAttempt } from './llm-client.js';
import { getDatabase } from '../db.js';

export interface RecordTelemetryOpts {
  /** Logical pipeline that ran the call. One of: dreamer | pattern_detector | consolidator | auto_tagger | failure_analyzer | <future>. */
  flow: string;
  /** Optional project scope (taken from cluster.project / entity tag / hook context). */
  project?: string;
  /** Pass an explicit DB if the caller already opened one (e.g. inside a hook). Default: getDatabase() singleton. */
  db?: Database.Database;
}

/**
 * Persist an array of attempts (the second argument to `onAttempt`)
 * to the `llm_telemetry` table. Designed to be the ENTIRE body of an
 * onAttempt callback at every callsite — failure-analyzer.ts,
 * auto-tagger.ts, consolidator.ts, dreamer.ts (×2). Each row records
 * one provider attempt; a chain of N attempts produces N rows tied
 * by their `flow` value but otherwise independent.
 *
 * Errors during persistence are swallowed — telemetry must NEVER
 * crash an LLM call. The contract callLLM relies on (`try {
 * onAttempt() } catch {}`) is preserved here defensively.
 */
export function recordTelemetry(attempts: LLMAttempt[], opts: RecordTelemetryOpts): void {
  if (!attempts || attempts.length === 0) return;
  let db: Database.Database;
  try {
    db = opts.db ?? getDatabase();
  } catch {
    // No DB available (e.g. hook process before openDatabase): telemetry is
    // best-effort and must never block the LLM flow it observes. Drop silently.
    return;
  }
  // Mark every attempt as fallback_used=1 except the primary (index 0).
  // Lets dashboard count "% of LLM calls that needed a fallback to
  // succeed" without re-deriving from the index column.
  const stmt = db.prepare(`
    INSERT INTO llm_telemetry (
      flow, provider, model, project, attempt_index, status,
      latency_ms, error_class, error_message, fallback_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Single transaction so a chain of N attempts either lands fully
  // or not at all; partial telemetry is worse than missing telemetry
  // because it makes failover ratios look wrong.
  const tx = db.transaction((rows: LLMAttempt[]) => {
    for (const a of rows) {
      try {
        stmt.run(
          opts.flow,
          a.provider,
          a.model ?? null,
          opts.project ?? null,
          a.index,
          a.status,
          a.latencyMs,
          a.errorClass ?? null,
          a.errorMessage ?? null,
          a.index > 0 ? 1 : 0,
        );
      } catch {
        /* per-row failure swallowed; outer try silences if needed */
      }
    }
  });
  try { tx(attempts); } catch { /* whole-transaction failure swallowed */ }
}

export interface TelemetrySummary {
  flow: string;
  total_calls: number;
  total_attempts: number;
  successes: number;
  failures: number;
  fallback_used: number;
  median_latency_ms: number | null;
  by_provider: Record<string, { ok: number; fail: number }>;
  /**
   * Per-model ok/fail counts. The `model` column was written on every attempt
   * but never read until this — "which model is failing" was unanswerable.
   */
  by_model: Record<string, { ok: number; fail: number }>;
  /**
   * Per-project ok/fail counts. Same story as `by_model`: `project` was a
   * write-only column. Rows with no project are bucketed under '_unscoped'.
   */
  by_project: Record<string, { ok: number; fail: number }>;
  by_error_class: Record<string, number>;
  /**
   * A few most-recent failure messages (redacted at write time). The
   * `error_message` column was write-only; this surfaces it so a failure can
   * be diagnosed beyond its error_class. Capped to keep the summary small.
   */
  sample_errors: Array<{ error_class: string | null; message: string }>;
  window_days: number;
}

/** Max failure messages surfaced per flow in `sample_errors`. */
const MAX_SAMPLE_ERRORS = 5;

/**
 * Aggregate telemetry over the last `windowDays` days. Returns one
 * summary per `flow` (dreamer / consolidator / etc.) so the
 * dashboard / CLI can render a per-flow scorecard. Median latency is
 * computed in JS (SQLite has no MEDIAN) — fine at this row count.
 */
export function summariseTelemetry(windowDays = 30, db?: Database.Database): TelemetrySummary[] {
  const conn = db ?? getDatabase();
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const rows = conn.prepare(`
    SELECT flow, provider, model, project, status, latency_ms, error_class, error_message, attempt_index, fallback_used
    FROM llm_telemetry
    WHERE ts >= ?
    ORDER BY ts ASC
  `).all(since) as Array<{
    flow: string;
    provider: string;
    model: string | null;
    project: string | null;
    status: string;
    latency_ms: number | null;
    error_class: string | null;
    error_message: string | null;
    attempt_index: number;
    fallback_used: number;
  }>;

  const byFlow = new Map<string, {
    attempts: typeof rows;
    primaryAttempts: number; // count of attempt_index === 0
  }>();
  for (const r of rows) {
    let bucket = byFlow.get(r.flow);
    if (!bucket) {
      bucket = { attempts: [], primaryAttempts: 0 };
      byFlow.set(r.flow, bucket);
    }
    bucket.attempts.push(r);
    if (r.attempt_index === 0) bucket.primaryAttempts++;
  }

  const out: TelemetrySummary[] = [];
  for (const [flow, bucket] of byFlow) {
    const successes = bucket.attempts.filter(a => a.status === 'ok').length;
    const failures = bucket.attempts.filter(a => a.status === 'fail').length;
    const fallbackUsed = bucket.attempts.filter(a => a.fallback_used === 1).length;
    const okLatencies = bucket.attempts.filter(a => a.status === 'ok' && a.latency_ms != null).map(a => a.latency_ms!).sort((a, b) => a - b);
    const median = okLatencies.length === 0 ? null : okLatencies[Math.floor(okLatencies.length / 2)];

    const byProvider: Record<string, { ok: number; fail: number }> = {};
    const byModel: Record<string, { ok: number; fail: number }> = {};
    const byProject: Record<string, { ok: number; fail: number }> = {};
    const bump = (rec: Record<string, { ok: number; fail: number }>, key: string, slot: 'ok' | 'fail') => {
      (rec[key] ??= { ok: 0, fail: 0 })[slot]++;
    };
    for (const a of bucket.attempts) {
      const slot = a.status === 'ok' ? 'ok' : 'fail';
      bump(byProvider, a.provider, slot);
      bump(byModel, a.model ?? 'unknown', slot);
      bump(byProject, a.project ?? '_unscoped', slot);
    }

    const byErrorClass: Record<string, number> = {};
    for (const a of bucket.attempts) {
      if (a.error_class) byErrorClass[a.error_class] = (byErrorClass[a.error_class] ?? 0) + 1;
    }

    // Most-recent failure messages (rows are ASC by ts, so take from the end).
    const sampleErrors: Array<{ error_class: string | null; message: string }> = [];
    for (let i = bucket.attempts.length - 1; i >= 0 && sampleErrors.length < MAX_SAMPLE_ERRORS; i--) {
      const a = bucket.attempts[i];
      if (a.status === 'fail' && a.error_message) {
        sampleErrors.push({ error_class: a.error_class, message: a.error_message });
      }
    }

    out.push({
      flow,
      total_calls: bucket.primaryAttempts,
      total_attempts: bucket.attempts.length,
      successes,
      failures,
      fallback_used: fallbackUsed,
      median_latency_ms: median,
      by_provider: byProvider,
      by_model: byModel,
      by_project: byProject,
      by_error_class: byErrorClass,
      sample_errors: sampleErrors,
      window_days: windowDays,
    });
  }

  return out.sort((a, b) => b.total_attempts - a.total_attempts);
}

export interface PruneOptions {
  /** Rows older than this many days are deleted. Default 180. */
  olderThanDays?: number;
  /** Optional db handle; defaults to the singleton. */
  db?: Database.Database;
}

export interface PruneResult {
  deletedRows: number;
  cutoffIso: string;
  totalRowsAfter: number;
}

/**
 * Delete `llm_telemetry` rows older than `olderThanDays` (default
 * 180 — matches the manual-purge example in the v4.2.0 CHANGELOG
 * known-limitations note). Returns the deleted count, the ISO
 * cutoff used, and the surviving row count so callers can render
 * "Pruned X rows older than N days." without a follow-up SELECT.
 *
 * Single indexed DELETE — no transaction needed (atomic by default
 * in SQLite for one statement). Cost is milliseconds even at 100k
 * rows because `idx_llm_telemetry_ts` covers the WHERE clause.
 */
export function pruneTelemetry(opts: PruneOptions = {}): PruneResult {
  const olderThanDays = opts.olderThanDays ?? 180;
  const db = opts.db ?? getDatabase();
  const cutoffIso = new Date(Date.now() - olderThanDays * 86400000).toISOString();

  const result = db.prepare(
    'DELETE FROM llm_telemetry WHERE ts < ?'
  ).run(cutoffIso);

  const totalRowsAfter = (
    db.prepare('SELECT COUNT(*) AS c FROM llm_telemetry').get() as { c: number }
  ).c;

  return {
    deletedRows: result.changes,
    cutoffIso,
    totalRowsAfter,
  };
}
