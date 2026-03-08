import { describe, it, expect } from 'vitest';
import {
  isTestCommand,
  extractTestFailureContext,
  buildTestFailureQuery,
  buildErrorQuery,
} from '../post-tool-use-recall-utils.js';

describe('isTestCommand', () => {
  it('detects "npm test"', () => {
    expect(isTestCommand('npm test')).toBe(true);
  });

  it('detects "npm run test"', () => {
    expect(isTestCommand('npm run test')).toBe(true);
  });

  it('detects "npx vitest"', () => {
    expect(isTestCommand('npx vitest')).toBe(true);
  });

  it('detects "vitest run"', () => {
    expect(isTestCommand('vitest run')).toBe(true);
  });

  it('detects "vitest" alone', () => {
    expect(isTestCommand('vitest')).toBe(true);
  });

  it('detects "npx jest"', () => {
    expect(isTestCommand('npx jest')).toBe(true);
  });

  it('detects "jest" alone', () => {
    expect(isTestCommand('jest')).toBe(true);
  });

  it('detects "pytest"', () => {
    expect(isTestCommand('pytest')).toBe(true);
  });

  it('detects "bun test"', () => {
    expect(isTestCommand('bun test')).toBe(true);
  });

  it('detects "mocha"', () => {
    expect(isTestCommand('mocha')).toBe(true);
  });

  it('rejects "ls -la"', () => {
    expect(isTestCommand('ls -la')).toBe(false);
  });

  it('rejects "git commit"', () => {
    expect(isTestCommand('git commit -m "test"')).toBe(false);
  });

  it('rejects "echo test"', () => {
    expect(isTestCommand('echo test')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isTestCommand('')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isTestCommand(null)).toBe(false);
    expect(isTestCommand(undefined)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTestCommand('NPM TEST')).toBe(true);
    expect(isTestCommand('Vitest Run')).toBe(true);
  });
});

describe('extractTestFailureContext', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(extractTestFailureContext(null)).toBeNull();
    expect(extractTestFailureContext(undefined)).toBeNull();
    expect(extractTestFailureContext('')).toBeNull();
  });

  it('returns null for passing test output', () => {
    const output = `
 ✓ src/utils/helper.test.ts (3 tests) 12ms
 Test Files  1 passed (1)
 Tests  3 passed (3)
`;
    expect(extractTestFailureContext(output)).toBeNull();
  });

  it('extracts from vitest FAIL output', () => {
    const output = `
 FAIL  src/mcp/handlers/HookToolHandler.test.ts
 ✕ should process tool use (5ms)
 Error: expect(received).toBe(expected)
`;
    const ctx = extractTestFailureContext(output);
    expect(ctx).not.toBeNull();
    expect(ctx.testName).toBe('src/mcp/handlers/HookToolHandler.test.ts');
    expect(ctx.errorMessage).toMatch(/Error/);
  });

  it('extracts from jest-style FAIL output', () => {
    const output = `
FAIL src/auth/login.test.js
  ● should validate credentials
    expect(received).toBe(expected)
`;
    const ctx = extractTestFailureContext(output);
    expect(ctx).not.toBeNull();
    expect(ctx.testName).toBe('src/auth/login.test.js');
  });

  it('extracts error message from output with "failed"', () => {
    const output = `
Tests: 2 failed, 5 passed
Error: Connection refused
`;
    const ctx = extractTestFailureContext(output);
    expect(ctx).not.toBeNull();
    expect(ctx.errorMessage).toMatch(/Error.*Connection refused/);
  });

  it('handles output with ✕ marker', () => {
    const output = `
 ✕ my test case
`;
    const ctx = extractTestFailureContext(output);
    expect(ctx).not.toBeNull();
  });
});

describe('buildTestFailureQuery', () => {
  it('combines short test name + error message', () => {
    const result = buildTestFailureQuery('src/utils/helper.test.ts', 'Connection refused');
    expect(result).toBe('helper Connection refused');
  });

  it('strips directory path and test/spec suffix', () => {
    const result = buildTestFailureQuery('src/mcp/handlers/HookToolHandler.test.ts', 'error');
    expect(result).toBe('HookToolHandler error');
  });

  it('strips spec suffix', () => {
    const result = buildTestFailureQuery('auth.spec.js', 'fail');
    expect(result).toBe('auth fail');
  });

  it('handles unknown test name', () => {
    const result = buildTestFailureQuery('unknown test', 'some error');
    expect(result).toBe('unknown test some error');
  });

  it('handles empty error message', () => {
    const result = buildTestFailureQuery('src/foo.test.ts', '');
    expect(result).toBe('foo');
  });
});

describe('buildErrorQuery', () => {
  it('combines error type + first line of message', () => {
    const result = buildErrorQuery('TypeError', 'Cannot read property x of undefined');
    expect(result).toBe('TypeError Cannot read property x of undefined');
  });

  it('uses only first line of multiline message', () => {
    const result = buildErrorQuery('ReferenceError', 'x is not defined\n    at foo.js:10\n    at bar.js:20');
    expect(result).toBe('ReferenceError x is not defined');
  });

  it('handles null/undefined error type', () => {
    const result = buildErrorQuery(null, 'something broke');
    expect(result).toBe('Error something broke');
  });

  it('handles undefined error type', () => {
    const result = buildErrorQuery(undefined, 'something broke');
    expect(result).toBe('Error something broke');
  });

  it('handles null/undefined error message', () => {
    const result = buildErrorQuery('SyntaxError', null);
    expect(result).toBe('SyntaxError');
  });

  it('handles empty inputs', () => {
    const result = buildErrorQuery('', '');
    expect(result).toBe('Error');
  });
});
