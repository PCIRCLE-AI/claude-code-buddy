/**
 * The `node` half of the Web Storage setup contract.
 *
 * `tests/setup/webstorage.ts` repairs `localStorage` for DOM tests on Node 26,
 * where Node's own Web Storage global shadows happy-dom's with an `undefined`
 * one. It must not repair anything for the `environment: 'node'` suite, which
 * is nearly the whole test base: giving those tests a `localStorage` would
 * hand them a capability the real runtime does not have, and a test that only
 * passes because the harness invented a global is worse than no test.
 *
 * Honest about coverage: on Node 20 / 22 / 24 this assertion is vacuous —
 * there is no such global either way. It bites on Node 26, which is why that
 * leg is in the CI matrix.
 */
import { describe, it, expect } from 'vitest';

describe('the Web Storage repair is scoped to DOM environments', () => {
  it('leaves the node environment without a localStorage', () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(
      (globalThis as Record<string, unknown>).localStorage,
      'the setup file installed storage into a node-environment test'
    ).toBeUndefined();
  });
});
