// G9 — drift detection between src/core/updater.ts (TypeScript, the
// canonical policy) and scripts/hooks/_shared.js (JavaScript copy used
// by the Stop hook). Both implement classifyBump and decideAutoUpdate;
// the audit flagged silent drift if the TS version is updated and the
// JS copy isn't.
//
// We exercise both with the same inputs and assert byte-for-byte
// equivalent output. The next time someone tightens the patch / minor /
// major rules in TS without mirroring the JS, this test fails with a
// concrete input that produces different answers.

import { describe, it, expect } from 'vitest';
import { classifyBump, decideAutoUpdate } from '../src/core/updater.js';
import { classifyBumpHook, decideAutoUpdateHook } from '../scripts/hooks/_shared.js';

describe('G9 — updater policy drift between TS and hook JS', () => {
  describe('classifyBump', () => {
    const cases: Array<[string, string, ReturnType<typeof classifyBump>]> = [
      ['1.0.0', '1.0.1', 'patch'],
      ['1.0.0', '1.1.0', 'minor'],
      ['1.0.0', '2.0.0', 'major'],
      ['1.0.0', '1.0.0', null],
      ['2.0.0', '1.0.0', null],
      ['1.5.3', '1.5.4', 'patch'],
      ['1.5.3', '1.6.0', 'minor'],
      ['1.5.3', '1.5.2', null],
      ['', '1.0.0', null],
      ['1.0.0', '', null],
      ['not-a-version', '1.0.0', null],
      ['1.0.0', 'not-a-version', null],
      ['1.0.0-rc.1', '1.0.0', null],
      ['4.1.3', '4.1.4', 'patch'],
      ['4.1.4', '4.2.0', 'minor'],
      ['4.1.4', '5.0.0', 'major'],
    ];

    for (const [from, to, expected] of cases) {
      it(`'${from}' → '${to}' must classify the same in TS and hook (expected: ${expected})`, () => {
        const ts = classifyBump(from, to);
        const js = classifyBumpHook(from, to);
        expect(ts).toBe(expected);
        expect(js).toBe(expected);
        expect(ts).toBe(js);
      });
    }
  });

  describe('decideAutoUpdate — logical equivalence (the API shapes diverge)', () => {
    // The TS API takes a flat input { currentVersion, latestVersion,
    // policy, currentVersionDeprecated } and returns { shouldUpdate,
    // bump, reason, deprecationOverride }. The JS hook takes
    // (currentVersion, cache, policy) and returns { run, latest, bump,
    // reason?, deprecationOverride }. Field names, input shapes, and
    // even the reason-string format already differ — this is the drift
    // the audit warned about.
    //
    // What CANNOT drift without breaking the actual behaviour the hook
    // dispatches on: should the upgrade run? what bump category did we
    // classify? did the deprecation path force the override? Those are
    // the invariants worth pinning. The reason string is informational
    // and freely re-worded by either side.
    //
    // Note: the JS hook also enforces a 24-hour cache freshness gate
    // that the TS function does not (TS is purely policy + deprecation;
    // freshness is handled by the caller). For drift-equivalence cases
    // we feed the JS path only fresh caches so the freshness check is
    // not a confounder.
    const NOW = Date.now();
    const recentSuccess = new Date(NOW - 60 * 60 * 1000).toISOString();

    type Fixture = {
      name: string;
      currentVersion: string;
      latestVersion: string | null;
      policy: 'off' | 'patch' | 'minor' | 'major';
      deprecated: boolean;
      expectedShouldUpdate: boolean;
      expectedBump: 'patch' | 'minor' | 'major' | null;
      expectedDeprecationOverride: boolean;
    };

    const fixtures: Fixture[] = [
      { name: 'patch policy + patch bump → update', currentVersion: '4.1.3', latestVersion: '4.1.4', policy: 'patch', deprecated: false, expectedShouldUpdate: true, expectedBump: 'patch', expectedDeprecationOverride: false },
      { name: 'off policy → skip', currentVersion: '4.1.3', latestVersion: '4.1.4', policy: 'off', deprecated: false, expectedShouldUpdate: false, expectedBump: 'patch', expectedDeprecationOverride: false },
      { name: 'patch policy + minor bump → skip', currentVersion: '4.1.3', latestVersion: '4.2.0', policy: 'patch', deprecated: false, expectedShouldUpdate: false, expectedBump: 'minor', expectedDeprecationOverride: false },
      { name: 'minor policy + minor bump → update', currentVersion: '4.1.3', latestVersion: '4.2.0', policy: 'minor', deprecated: false, expectedShouldUpdate: true, expectedBump: 'minor', expectedDeprecationOverride: false },
      { name: 'major policy + major bump → update', currentVersion: '4.1.3', latestVersion: '5.0.0', policy: 'major', deprecated: false, expectedShouldUpdate: true, expectedBump: 'major', expectedDeprecationOverride: false },
      { name: 'no latestVersion → skip', currentVersion: '4.1.3', latestVersion: null, policy: 'patch', deprecated: false, expectedShouldUpdate: false, expectedBump: null, expectedDeprecationOverride: false },
      { name: 'deprecation override: off policy + patch bump + deprecated → update with override', currentVersion: '4.1.3', latestVersion: '4.1.4', policy: 'off', deprecated: true, expectedShouldUpdate: true, expectedBump: 'patch', expectedDeprecationOverride: true },
      { name: 'deprecation override does NOT apply to minor bumps', currentVersion: '4.1.3', latestVersion: '4.2.0', policy: 'off', deprecated: true, expectedShouldUpdate: false, expectedBump: 'minor', expectedDeprecationOverride: false },
    ];

    for (const f of fixtures) {
      it(`${f.name} — TS and hook decide identically`, () => {
        const ts = decideAutoUpdate({
          currentVersion: f.currentVersion,
          latestVersion: f.latestVersion,
          policy: f.policy,
          currentVersionDeprecated: f.deprecated,
        });

        const cache = {
          currentVersion: f.currentVersion,
          latestVersion: f.latestVersion,
          checkedAt: recentSuccess,
          lastAttemptAt: recentSuccess,
          lastSuccessfulCheckAt: recentSuccess,
          lastError: null,
          updateAvailable: f.latestVersion !== null,
          checkSucceeded: true,
          source: 'fresh' as const,
          currentVersionDeprecation: f.deprecated ? 'security advisory' : null,
        };
        const js = decideAutoUpdateHook(f.currentVersion, cache, f.policy);

        // shouldUpdate ↔ run
        expect(ts.shouldUpdate).toBe(f.expectedShouldUpdate);
        expect(js.run).toBe(f.expectedShouldUpdate);
        // bump category — both implementations expose the same field name
        expect(ts.bump).toBe(f.expectedBump);
        // JS only emits bump when shouldUpdate=true
        if (f.expectedShouldUpdate) expect(js.bump).toBe(f.expectedBump);
        // deprecationOverride — same field name on both sides
        expect(ts.deprecationOverride).toBe(f.expectedDeprecationOverride);
        if (f.expectedShouldUpdate) {
          expect(js.deprecationOverride).toBe(f.expectedDeprecationOverride);
        }
      });
    }
  });

  it('JS hook adds a freshness gate the TS function does not (intentional asymmetry)', () => {
    // Documented divergence: the JS hook refuses to act on a cache
    // older than 24 hours, returning { run: false, reason: 'stale-cache' }.
    // The TS function does not implement freshness — the hook's cache
    // check is the canonical guard. This test pins the divergence so a
    // future "let's unify" attempt does not silently remove the
    // freshness gate from the actual runtime path.
    const staleCache = {
      currentVersion: '4.1.3',
      latestVersion: '4.1.4',
      checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      lastSuccessfulCheckAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      lastError: null,
      updateAvailable: true,
      checkSucceeded: true,
      source: 'cache' as const,
      currentVersionDeprecation: null,
    };
    const js = decideAutoUpdateHook('4.1.3', staleCache, 'patch');
    expect(js.run).toBe(false);
    expect(js.reason).toBe('stale-cache');
  });
});
