import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logSkillEvent, summariseSkillUsage } from '../../src/core/skill-usage-log.js';

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-skill-log-'));
  logPath = path.join(tmpDir, 'skill-usage.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('skill-usage-log: logSkillEvent', () => {
  it('appends a JSONL line with ts + event only (no payload)', () => {
    logSkillEvent('test_event', logPath);
    const raw = fs.readFileSync(logPath, 'utf8');
    const line = raw.trim();
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('test_event');
    // payload was removed — it was write-only, privacy-adjacent data.
    expect(parsed.payload).toBeUndefined();
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple events on separate lines', () => {
    logSkillEvent('a', logPath);
    logSkillEvent('b', logPath);
    logSkillEvent('a', logPath);
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe('a');
    expect(JSON.parse(lines[1]).event).toBe('b');
  });

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'log.jsonl');
    logSkillEvent('mkdir_test', nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('never throws on a write failure (read-only path)', () => {
    // Pointing at a directory should fail to append, but logSkillEvent must
    // swallow it — telemetry can never break the calling code path.
    expect(() => logSkillEvent('wont_write', tmpDir)).not.toThrow();
  });

  it('writes the log file with mode 0o600 (POSIX)', () => {
    // F6 fix: the log contains timestamps + event names and can profile
    // user activity. On shared systems other local users must not be able
    // to read it. Skip on Windows where chmod semantics differ.
    if (process.platform === 'win32') return;
    logSkillEvent('mode_check', logPath);
    const mode = fs.statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('truncates the head of the log when it grows past the cap', () => {
    // Pre-seed a 12 MB file with one-line records so rotation kicks in.
    // Single read after rotation captures both the new size and the new
    // content from one snapshot — avoids the file-system-race CodeQL
    // pattern (statSync + readFileSync between writes is a TOCTOU
    // window even in single-process tests).
    const oneLine = JSON.stringify({ ts: 'old', event: 'old_event' }) + '\n';
    const buf = Buffer.alloc(12 * 1024 * 1024, oneLine);
    fs.writeFileSync(logPath, buf);
    expect(buf.length).toBeGreaterThan(10 * 1024 * 1024);

    logSkillEvent('new_event_after_truncate', logPath);

    const after = fs.readFileSync(logPath);
    expect(after.length).toBeLessThan(8 * 1024 * 1024);
    expect(after.toString('utf8')).toContain('new_event_after_truncate');
  });
});

describe('skill-usage-log: summariseSkillUsage', () => {
  it('returns zero counters when no log file exists', () => {
    const s = summariseSkillUsage(logPath);
    expect(s.total_events).toBe(0);
    expect(s.events_by_name).toEqual({});
    expect(s.log_bytes).toBe(0);
  });

  it('aggregates event counts and ts range', () => {
    logSkillEvent('a', logPath);
    logSkillEvent('b', logPath);
    logSkillEvent('a', logPath);
    logSkillEvent('a', logPath);
    const s = summariseSkillUsage(logPath);
    expect(s.total_events).toBe(4);
    expect(s.events_by_name).toEqual({ a: 3, b: 1 });
    expect(s.first_event).toBeDefined();
    expect(s.last_event).toBeDefined();
    expect(s.first_event! <= s.last_event!).toBe(true);
  });

  it('skips malformed lines without throwing', () => {
    fs.writeFileSync(logPath, [
      '{"ts":"2026-01-01T00:00:00Z","event":"good"}',
      'not-json',
      '{"event":"another"}',
      '',
    ].join('\n'));
    const s = summariseSkillUsage(logPath);
    expect(s.total_events).toBe(2);
    expect(s.events_by_name.good).toBe(1);
    expect(s.events_by_name.another).toBe(1);
  });
});
