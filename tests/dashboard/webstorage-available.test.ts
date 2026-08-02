// @vitest-environment happy-dom
//
// The DOM half of the Web Storage setup contract — see
// `tests/setup/webstorage.ts` for the Node 26 behaviour it repairs.
//
// Pinned separately from the component tests that depend on it: when
// `OnboardingBanner` went red on the first Node 26 CI leg, five failures all
// read `Cannot read properties of undefined (reading 'clear')`, which points
// at the component. It was the environment. One test that says so directly
// costs nothing and saves that hunt next time.
import { describe, it, expect } from 'vitest';

describe('DOM tests get a working localStorage on every supported Node', () => {
  it('stores, reads back, and clears', () => {
    expect(typeof localStorage, 'no localStorage in a happy-dom test').toBe('object');

    localStorage.clear();
    expect(localStorage.getItem('memesh-probe')).toBeNull();

    localStorage.setItem('memesh-probe', 'value');
    expect(localStorage.getItem('memesh-probe')).toBe('value');

    localStorage.clear();
    expect(localStorage.getItem('memesh-probe')).toBeNull();
  });

  it('is happy-dom\'s Storage, not a hand-written stand-in', () => {
    // The repair borrows happy-dom's own implementation rather than
    // polyfilling one, so tests on Node 26 exercise the same object they
    // exercise everywhere else. A bespoke shim would let them pass against
    // behaviour that exists only in the test harness.
    expect(localStorage.constructor.name).toBe('Storage');
  });
});
