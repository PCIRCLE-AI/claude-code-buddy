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
  it('appends a JSONL line with ts + event + payload', () => {
    logSkillEvent('test_event', { count: 1 }, logPath);
    const raw = fs.readFileSync(logPath, 'utf8');
    const line = raw.trim();
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('test_event');
    expect(parsed.payload).toEqual({ count: 1 });
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple events on separate lines', () => {
    logSkillEvent('a', {}, logPath);
    logSkillEvent('b', { x: 2 }, logPath);
    logSkillEvent('a', {}, logPath);
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event).toBe('a');
    expect(JSON.parse(lines[1]).payload).toEqual({ x: 2 });
  });

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'log.jsonl');
    logSkillEvent('mkdir_test', {}, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('never throws on a write failure (read-only path)', () => {
    // Pointing at a directory should fail to append, but logSkillEvent must
    // swallow it — telemetry can never break the calling code path.
    expect(() => logSkillEvent('wont_write', {}, tmpDir)).not.toThrow();
  });

  it('truncates the head of the log when it grows past the cap', () => {
    // Pre-seed a 12 MB file with one-line records so rotation kicks in.
    const oneLine = JSON.stringify({ ts: 'old', event: 'old_event' }) + '\n';
    const buf = Buffer.alloc(12 * 1024 * 1024, oneLine);
    fs.writeFileSync(logPath, buf);
    expect(fs.statSync(logPath).size).toBeGreaterThan(10 * 1024 * 1024);

    logSkillEvent('new_event_after_truncate', { keep: true }, logPath);

    const after = fs.statSync(logPath).size;
    expect(after).toBeLessThan(8 * 1024 * 1024);

    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).toContain('new_event_after_truncate');
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
    logSkillEvent('a', {}, logPath);
    logSkillEvent('b', {}, logPath);
    logSkillEvent('a', {}, logPath);
    logSkillEvent('a', {}, logPath);
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
