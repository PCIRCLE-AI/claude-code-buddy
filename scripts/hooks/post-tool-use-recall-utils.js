/**
 * Post-Tool-Use Recall Utilities
 *
 * Pure functions for detecting test failures and errors in tool output,
 * used by the proactive recall system in post-tool-use.js.
 */

const TEST_PATTERNS = [
  /vitest\s*(run|watch)?/i,
  /jest\b/i,
  /npm\s+test/i,
  /npm\s+run\s+test/i,
  /npx\s+vitest/i,
  /npx\s+jest/i,
  /pytest\b/i,
  /bun\s+test/i,
  /mocha\b/i,
];

/**
 * Check if a command string is a test runner invocation.
 * @param {string} command - Shell command to check
 * @returns {boolean}
 */
export function isTestCommand(command) {
  if (!command) return false;
  return TEST_PATTERNS.some(p => p.test(command));
}

/**
 * Extract test failure context (test name + error message) from test output.
 * Returns null if no failure is detected.
 * @param {string} output - Test runner stdout/stderr
 * @returns {{ testName: string, errorMessage: string } | null}
 */
export function extractTestFailureContext(output) {
  if (!output) return null;
  const hasFailure = /FAIL|failed|failing|\u2715|\u2717|error/i.test(output);
  if (!hasFailure) return null;

  const fileMatch = output.match(/FAIL\s+(\S+\.(?:test|spec)\.\S+)/i)
    || output.match(/(\S+\.(?:test|spec)\.\S+)/i);
  const testName = fileMatch ? fileMatch[1] : 'unknown test';

  const errorMatch = output.match(/(?:Error|AssertionError|AssertError|expect).*$/m)
    || output.match(/(?:\u2715|\u2717)\s*(.+)$/m);
  const errorMessage = errorMatch ? errorMatch[0].trim() : 'test failed';

  return { testName, errorMessage };
}

/**
 * Build a search query from a test failure context.
 * Strips path and test/spec suffix from the test file name.
 * @param {string} testName - Test file name or path
 * @param {string} errorMessage - Error message
 * @returns {string}
 */
export function buildTestFailureQuery(testName, errorMessage) {
  const shortName = testName.replace(/^.*[/\\]/, '').replace(/\.(test|spec)\.\w+$/, '');
  return `${shortName} ${errorMessage}`.trim();
}

/**
 * Build a search query from an error type and message.
 * Uses only the first line of the error message.
 * @param {string} errorType - Error class name (e.g. "TypeError")
 * @param {string} errorMessage - Error message (may be multiline)
 * @returns {string}
 */
export function buildErrorQuery(errorType, errorMessage) {
  const firstLine = (errorMessage || '').split('\n')[0].trim();
  return `${errorType || 'Error'} ${firstLine}`.trim();
}
