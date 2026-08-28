/**
 * `autoUpdate: off` means off, including when the registry says the installed
 * version is deprecated.
 *
 * `decideAutoUpdateHook` runs from the Stop hook, unattended, and its `run:
 * true` makes `session-summary.js` dispatch a detached updater runner. It
 * carried a deprecation override that fired only for a `patch` bump — and
 * every policy above `off` already permits a patch, so `off` was the only
 * setting the override could ever change.
 *
 * Its trigger is `currentVersionDeprecation`, a string the PUBLISHER writes
 * into the npm registry. Anyone able to publish the package could therefore
 * make every user who had explicitly turned auto-update OFF run a global
 * install, with no prompt and no session in which to object. That is not a
 * security override; it is a remote switch on a refusal.
 *
 * A deprecated version is still said out loud — `memesh doctor` escalates its
 * update-status row to FAIL — and the user decides.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { decideAutoUpdateHook } = require('../../scripts/hooks/_shared.js');

/** A cache the freshness gate accepts, describing a patch bump. */
function cache(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: '4.6.1',
    latestVersion: '4.6.2',
    lastSuccessfulCheckAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('the auto-update policy is not overridable from the registry', () => {
  it('refuses a deprecated-version patch when the policy is off', () => {
    const decision = decideAutoUpdateHook(
      '4.6.1',
      cache({ currentVersionDeprecation: 'this release has a security issue' }),
      'off',
    );

    expect(decision.run, 'registry metadata overrode an explicit off').toBe(false);
  });

  it('still runs a patch when the policy permits one — the anti-vacuity half', () => {
    // A gate that refused everything would satisfy the test above and switch
    // auto-update off for every user who asked for it.
    const decision = decideAutoUpdateHook('4.6.1', cache(), 'patch');

    expect(decision.run, 'a permitted patch stopped being permitted').toBe(true);
    expect(decision.bump).toBe('patch');
    expect(decision.latest).toBe('4.6.2');
  });

  it('still refuses a minor bump under a patch policy, deprecated or not', () => {
    // The other half of the original design, unchanged: a minor or major jump
    // can carry behaviour the user did not agree to.
    const decision = decideAutoUpdateHook(
      '4.6.1',
      cache({ latestVersion: '4.7.0', currentVersionDeprecation: 'deprecated' }),
      'patch',
    );

    expect(decision.run).toBe(false);
  });

  it('refuses everything under off even without a deprecation', () => {
    expect(decideAutoUpdateHook('4.6.1', cache(), 'off').run).toBe(false);
    expect(decideAutoUpdateHook('4.6.1', cache({ latestVersion: '5.0.0' }), 'off').run).toBe(false);
  });
});
