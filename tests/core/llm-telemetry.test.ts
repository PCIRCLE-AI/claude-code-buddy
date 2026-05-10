import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { recordTelemetry, summariseTelemetry } from '../../src/core/llm-telemetry.js';
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
    fs.rmSync(testDir, { recursive: true, force: true });
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
      { provider: 'anthropic', status: 'ok', latencyMs: 500, index: 0 },
    ], { flow: 'dreamer' });
    recordTelemetry([
      { provider: 'anthropic', status: 'fail', latencyMs: 90, errorClass: 'auth', index: 0 },
      { provider: 'ollama', status: 'ok', latencyMs: 8000, index: 1 },
    ], { flow: 'dreamer' });
    recordTelemetry([
      { provider: 'anthropic', status: 'fail', latencyMs: 80, errorClass: 'auth', index: 0 },
    ], { flow: 'auto_tagger' });

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
});
