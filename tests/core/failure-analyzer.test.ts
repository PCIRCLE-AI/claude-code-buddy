import { describe, it, expect, vi, afterEach } from 'vitest';

// Control what the LLM "returns" so we can drive the two silent paths the
// fake-working audit flagged: (1) the call throws, (2) the call succeeds but
// the reply is not usable lesson JSON. Both used to return null with no signal.
const callLLMMock = vi.fn();
vi.mock('../../src/core/llm-client.js', () => ({
  callLLM: (...args: unknown[]) => callLLMMock(...args),
}));
vi.mock('../../src/core/llm-telemetry.js', () => ({
  recordTelemetry: () => {},
}));

describe('Failure Analyzer: unusable results are traced, not silent', () => {
  let stderr: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    spy?.mockRestore();
    callLLMMock.mockReset();
  });

  function captureStderr() {
    stderr = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
      stderr.push(String(c));
      return true;
    });
  }

  it('traces when the LLM answers but the reply is not usable lesson JSON', async () => {
    callLLMMock.mockResolvedValue('Sure! Here is my analysis in prose, no JSON at all.');
    captureStderr();
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    const result = await analyzeFailure(['TypeError: x'], ['a.ts'], { provider: 'anthropic' });
    expect(result).toBeNull();
    const trace = stderr.join('');
    expect(trace).toContain('[memesh failure-analyzer]');
    expect(trace).toContain('not a usable lesson');
  });

  it('traces when every provider throws', async () => {
    callLLMMock.mockRejectedValue(new Error('401 all providers failed'));
    captureStderr();
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    const result = await analyzeFailure(['TypeError: x'], ['a.ts'], { provider: 'anthropic' });
    expect(result).toBeNull();
    const trace = stderr.join('');
    expect(trace).toContain('[memesh failure-analyzer]');
    expect(trace).toContain('401 all providers failed');
  });

  it('does NOT trace on a healthy parse (usable JSON → lesson, silence)', async () => {
    callLLMMock.mockResolvedValue(JSON.stringify({
      error: 'TypeError on undefined', rootCause: 'missing guard', fix: 'added guard',
      prevention: 'validate input', errorPattern: 'null-reference', fixPattern: 'type-guard', severity: 'major',
    }));
    captureStderr();
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    const result = await analyzeFailure(['TypeError: x'], ['a.ts'], { provider: 'anthropic' });
    expect(result).not.toBeNull();
    expect(stderr.join('')).toBe('');
  });
});

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

  it('deduplicates errors before sending them to the LLM', async () => {
    const { analyzeFailure } = await import('../../src/core/failure-analyzer.js');
    // Capture the prompt actually built, so we verify DEDUP (not just that a
    // failed call returns null — the prior version of this test asserted only
    // the latter and would have stayed green with dedup completely broken).
    callLLMMock.mockReset();
    let prompt = '';
    callLLMMock.mockImplementation((p: string) => { prompt = p; return Promise.resolve('not-json'); });

    await analyzeFailure(
      ['Error A', 'Error A', 'Error A', 'Error B'],
      ['file.ts'],
      { provider: 'anthropic' },
    );

    // 'Error A' appeared 3× in the input but must reach the prompt once.
    const occurrencesOfA = prompt.split('Error A').length - 1;
    expect(occurrencesOfA).toBe(1);
    expect(prompt).toContain('Error B');
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
