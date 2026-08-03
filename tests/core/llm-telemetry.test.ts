import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { recordTelemetry, summariseTelemetry, pruneTelemetry } from '../../src/core/llm-telemetry.js';
import type { LLMAttempt } from '../../src/core/llm-client.js';

const require = createRequire(import.meta.url);

// Persistence + summary aggregation contract for the LLM telemetry
// table. callLLM-driven onAttempt hooks already pin the recording
// shape (see tests/core/llm-client.test.ts); these tests focus on
// what happens AFTER the hook fires — does the row land in SQLite,
// does the summary aggregator slice it correctly per flow, does the
// fallback_used flag catch chain success.

describe('llm-telemetry persistence + summarise', () => {
  let testDir: string;
  let dbPath: string;
  let prevDbPath: string | undefined;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-llm-telemetry-test-'));
    dbPath = path.join(testDir, 'test.db');
    // Force the singleton to use a clean DB for this test.
    prevDbPath = process.env.MEMESH_DB_PATH;
    process.env.MEMESH_DB_PATH = dbPath;
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* nothing open */ }
    openDatabase();
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    if (prevDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = prevDbPath;
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('records a single successful primary attempt — fallback_used = 0', () => {
    const attempts: LLMAttempt[] = [
      { provider: 'anthropic', model: 'claude-haiku-4-5', status: 'ok', latencyMs: 412, index: 0 },
    ];
    recordTelemetry(attempts, { flow: 'dreamer', project: 'memesh-llm-memory' });

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM llm_telemetry').all() as Array<Record<string, unknown>>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flow: 'dreamer',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      project: 'memesh-llm-memory',
      attempt_index: 0,
      status: 'ok',
      latency_ms: 412,
      fallback_used: 0,
    });
  });

  it('records a 401 -> ollama-fallback chain — both rows, fallback_used flips on attempt 1', () => {
    const attempts: LLMAttempt[] = [
      { provider: 'anthropic', status: 'fail', latencyMs: 110, errorClass: 'auth', errorMessage: 'Anthropic API error: 401', index: 0 },
      { provider: 'ollama', model: 'gemma4:e4b', status: 'ok', latencyMs: 9421, index: 1 },
    ];
    recordTelemetry(attempts, { flow: 'consolidator' });

    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT provider, status, fallback_used, attempt_index FROM llm_telemetry ORDER BY attempt_index').all() as Array<Record<string, unknown>>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: 'anthropic', status: 'fail', fallback_used: 0, attempt_index: 0 });
    expect(rows[1]).toMatchObject({ provider: 'ollama', status: 'ok', fallback_used: 1, attempt_index: 1 });
  });

  it('summariseTelemetry aggregates per-flow with provider + error-class breakdown', () => {
    // Seed three calls across two flows with varying outcomes
    recordTelemetry([
      { provider: 'anthropic', model: 'claude-haiku', status: 'ok', latencyMs: 500, index: 0 },
    ], { flow: 'dreamer', project: 'memesh' });
    recordTelemetry([
      { provider: 'anthropic', model: 'claude-haiku', status: 'fail', latencyMs: 90, errorClass: 'auth', errorMessage: '401 invalid key', index: 0 },
      { provider: 'ollama', model: 'llama3.2', status: 'ok', latencyMs: 8000, index: 1 },
    ], { flow: 'dreamer', project: 'memesh' });
    recordTelemetry([
      { provider: 'anthropic', model: 'claude-haiku', status: 'fail', latencyMs: 80, errorClass: 'auth', errorMessage: '401 again', index: 0 },
    ], { flow: 'auto_tagger', project: 'other-proj' });

    const summaries = summariseTelemetry(30);
    expect(summaries).toHaveLength(2);

    const dreamer = summaries.find(s => s.flow === 'dreamer')!;
    expect(dreamer.total_calls).toBe(2);
    expect(dreamer.total_attempts).toBe(3);
    expect(dreamer.successes).toBe(2);
    expect(dreamer.failures).toBe(1);
    expect(dreamer.fallback_used).toBe(1);
    expect(dreamer.by_provider.anthropic).toEqual({ ok: 1, fail: 1 });
    expect(dreamer.by_provider.ollama).toEqual({ ok: 1, fail: 0 });
    expect(dreamer.by_error_class.auth).toBe(1);
    // by_model / by_project / sample_errors surface the previously write-only columns.
    expect(dreamer.by_model['claude-haiku']).toEqual({ ok: 1, fail: 1 });
    expect(dreamer.by_model['llama3.2']).toEqual({ ok: 1, fail: 0 });
    expect(dreamer.by_project.memesh).toEqual({ ok: 2, fail: 1 });
    expect(dreamer.sample_errors).toHaveLength(1);
    expect(dreamer.sample_errors[0]).toEqual({ error_class: 'auth', message: '401 invalid key' });

    const tagger = summaries.find(s => s.flow === 'auto_tagger')!;
    expect(tagger.total_calls).toBe(1);
    expect(tagger.failures).toBe(1);
    expect(tagger.fallback_used).toBe(0);
  });

  it('empty attempts array is a no-op (no rows)', () => {
    recordTelemetry([], { flow: 'dreamer' });
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const count = (db.prepare('SELECT COUNT(*) AS c FROM llm_telemetry').get() as { c: number }).c;
    db.close();
    expect(count).toBe(0);
  });

  // --- pruneTelemetry retention helper ---
  //
  // Closes the v4.2.0 "no automatic retention" known limitation. The
  // CLI exposes this via `memesh telemetry --prune <days>`; the
  // openDatabase auto-prune (180-day default, 24h-throttled) keeps
  // the table bounded without user intervention. These tests pin
  // both surfaces.

  it('pruneTelemetry on an empty table returns deletedRows=0', () => {
    const result = pruneTelemetry();
    expect(result.deletedRows).toBe(0);
    expect(result.totalRowsAfter).toBe(0);
    expect(typeof result.cutoffIso).toBe('string');
  });

  it('pruneTelemetry with default 180d removes only old rows', () => {
    // Seed 5 rows: 2 are 200 days old (older than the 180d default),
    // 3 are recent. Use direct INSERTs because recordTelemetry stamps
    // ts via DEFAULT CURRENT_TIMESTAMP — we need to forge `ts` for
    // the retention test.
    const Database = require('better-sqlite3');
    const writer = new Database(dbPath);
    const oldTs = new Date(Date.now() - 200 * 86400000).toISOString();
    const newTs = new Date(Date.now() - 10 * 86400000).toISOString();
    const ins = writer.prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, attempt_index, status, latency_ms, fallback_used)
       VALUES (?, 'dreamer', 'anthropic', 0, 'ok', 100, 0)`
    );
    ins.run(oldTs);
    ins.run(oldTs);
    ins.run(newTs);
    ins.run(newTs);
    ins.run(newTs);
    writer.close();

    const result = pruneTelemetry();
    expect(result.deletedRows).toBe(2);
    expect(result.totalRowsAfter).toBe(3);

    const reader = new Database(dbPath, { readonly: true });
    const remaining = (reader.prepare('SELECT COUNT(*) AS c FROM llm_telemetry').get() as { c: number }).c;
    reader.close();
    expect(remaining).toBe(3);
  });

  it('pruneTelemetry honours custom olderThanDays', () => {
    const Database = require('better-sqlite3');
    const writer = new Database(dbPath);
    const t60 = new Date(Date.now() - 60 * 86400000).toISOString(); // older than 30d
    const t10 = new Date(Date.now() - 10 * 86400000).toISOString(); // newer than 30d
    const ins = writer.prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, attempt_index, status, latency_ms, fallback_used)
       VALUES (?, 'dreamer', 'anthropic', 0, 'ok', 100, 0)`
    );
    ins.run(t60);
    ins.run(t60);
    ins.run(t10);
    writer.close();

    const result = pruneTelemetry({ olderThanDays: 30 });
    expect(result.deletedRows).toBe(2);
    expect(result.totalRowsAfter).toBe(1);
  });

  it('pruneTelemetry is idempotent — second run deletes 0', () => {
    const Database = require('better-sqlite3');
    const writer = new Database(dbPath);
    const oldTs = new Date(Date.now() - 365 * 86400000).toISOString();
    writer.prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, attempt_index, status, latency_ms, fallback_used)
       VALUES (?, 'dreamer', 'anthropic', 0, 'ok', 100, 0)`
    ).run(oldTs);
    writer.close();

    const first = pruneTelemetry({ olderThanDays: 180 });
    expect(first.deletedRows).toBe(1);
    const second = pruneTelemetry({ olderThanDays: 180 });
    expect(second.deletedRows).toBe(0);
    expect(second.totalRowsAfter).toBe(0);
  });

  it('openDatabase auto-prune is throttled — does not re-run within 24h', async () => {
    // The beforeEach already ran openDatabase once, which writes the
    // 'last_telemetry_prune_at' marker. Forge a marker 1h ago, seed
    // an old row, and re-open the DB — the auto-prune should be a
    // no-op so the seeded old row survives.
    const { closeDatabase, openDatabase } = await import('../../src/db.js');
    closeDatabase();

    const Database = require('better-sqlite3');
    const writer = new Database(dbPath);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writer.prepare(
      `INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_telemetry_prune_at', ?)`
    ).run(oneHourAgo);
    const oldTs = new Date(Date.now() - 365 * 86400000).toISOString();
    writer.prepare(
      `INSERT INTO llm_telemetry (ts, flow, provider, attempt_index, status, latency_ms, fallback_used)
       VALUES (?, 'dreamer', 'anthropic', 0, 'ok', 100, 0)`
    ).run(oldTs);
    writer.close();

    openDatabase();

    const reader = new Database(dbPath, { readonly: true });
    const count = (reader.prepare('SELECT COUNT(*) AS c FROM llm_telemetry').get() as { c: number }).c;
    reader.close();
    expect(count).toBe(1);
  });
});
