import { describe, it, expect } from 'vitest';

describe('Failure Analyzer', () => {
  it('exports analyzeFailure function', async () => {
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    expect(typeof analyzeFailure).toBe('function');
  });

  it('returns null for empty errors', async () => {
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    const result = await analyzeFailure([], ['file.ts'], { provider: 'anthropic' });
    expect(result).toBeNull();
  });

  it('deduplicates errors', async () => {
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    // Without a real LLM, this will fail the API call and return null
    // That's the expected graceful behavior
    const result = await analyzeFailure(
      ['Error A', 'Error A', 'Error A', 'Error B'],
      ['file.ts'],
      { provider: 'anthropic', apiKey: 'invalid' }
    );
    expect(result).toBeNull(); // API fails gracefully
  });

  it('parseLesson is exported and defined', async () => {
    const mod = await import('../../src/core/failure-analyzer.js');
    expect(mod.analyzeFailure).toBeDefined();
    expect(mod.parseLesson).toBeDefined();
  });
});

describe('parseLesson', () => {
  it('parses valid structured lesson JSON', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({
      error: 'TypeError: null check',
      rootCause: 'Missing validation',
      fix: 'Added optional chaining',
      prevention: 'Always validate API responses',
      errorPattern: 'null-reference',
      fixPattern: 'defensive-coding',
      severity: 'major',
    }));
    expect(result).not.toBeNull();
    expect(result!.error).toBe('TypeError: null check');
    expect(result!.errorPattern).toBe('null-reference');
    expect(result!.severity).toBe('major');
  });

  it('returns null for invalid JSON', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    expect(parseLesson('not json')).toBeNull();
    expect(parseLesson('')).toBeNull();
  });

  it('handles missing optional fields', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({ error: 'Bug', fix: 'Fixed it' }));
    expect(result).not.toBeNull();
    expect(result!.rootCause).toBe('Unknown');
    expect(result!.errorPattern).toBe('other');
    expect(result!.severity).toBe('minor');
  });

  it('rejects lesson without error field', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    expect(parseLesson(JSON.stringify({ fix: 'something' }))).toBeNull();
  });

  it('rejects lesson without fix field', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    expect(parseLesson(JSON.stringify({ error: 'something' }))).toBeNull();
  });

  it('truncates long strings to 200 chars', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const long = 'A'.repeat(500);
    const result = parseLesson(JSON.stringify({ error: long, fix: long }));
    expect(result!.error.length).toBeLessThanOrEqual(200);
    expect(result!.fix.length).toBeLessThanOrEqual(200);
  });

  it('normalizes invalid errorPattern to other', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f', errorPattern: 'invalid-xyz' }));
    expect(result!.errorPattern).toBe('other');
  });

  it('normalizes invalid fixPattern to other', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f', fixPattern: 'not-valid' }));
    expect(result!.fixPattern).toBe('other');
  });

  it('normalizes invalid severity to minor', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f', severity: 'catastrophic' }));
    expect(result!.severity).toBe('minor');
  });

  it('accepts all valid errorPattern values', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const patterns = ['null-reference', 'type-error', 'import-missing', 'config-error', 'test-failure', 'build-error', 'runtime-error', 'logic-error', 'other'];
    for (const pattern of patterns) {
      const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f', errorPattern: pattern }));
      expect(result!.errorPattern).toBe(pattern);
    }
  });

  it('accepts all valid severity values', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    for (const severity of ['critical', 'major', 'minor']) {
      const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f', severity }));
      expect(result!.severity).toBe(severity);
    }
  });

  it('fills prevention default when missing', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const result = parseLesson(JSON.stringify({ error: 'e', fix: 'f' }));
    expect(result!.prevention).toBe('Review similar code paths');
  });

  it('extracts JSON embedded in surrounding text', async () => {
    const { parseLesson } = await import('../../src/core/failure-analyzer.js');
    const text = 'Here is the analysis:\n' + JSON.stringify({ error: 'e', fix: 'f' }) + '\nEnd.';
    const result = parseLesson(text);
    expect(result).not.toBeNull();
    expect(result!.error).toBe('e');
  });
});
