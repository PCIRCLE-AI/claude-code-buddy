import { execFileSync } from 'child_process';

type ExecFileSyncLike = typeof execFileSync;

interface RunGlobalUpdateOptions {
  execFileSyncImpl?: ExecFileSyncLike;
}

interface InstalledPackageTree {
  dependencies?: Record<string, { version?: string }>;
}

/**
 * Auto-update policy. Controls how aggressive the session-start hook
 * is allowed to be when bumping the user's globally installed memesh
 * binary. Default is `'off'` — every other value is opt-in, and a
 * value of `'off'` is still overridden to `'patch'` semantics when
 * the installed version is deprecated by the maintainers (a security
 * floor we won't let a stale config sit through).
 *
 *   off    — never auto-update (manual `memesh update` only). The
 *            deprecation override may still trigger a patch upgrade.
 *   patch  — auto-apply X.Y.Z -> X.Y.Z+N
 *   minor  — auto-apply patch + X.Y.Z -> X.Y+1.0
 *   major  — auto-apply any bump (patch + minor + major)
 */
export type AutoUpdatePolicy = 'off' | 'patch' | 'minor' | 'major';

const VALID_AUTO_UPDATE_POLICIES: ReadonlySet<AutoUpdatePolicy> = new Set([
  'off',
  'patch',
  'minor',
  'major',
]);

export function parseAutoUpdatePolicy(value: unknown): AutoUpdatePolicy | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return VALID_AUTO_UPDATE_POLICIES.has(lowered as AutoUpdatePolicy)
    ? (lowered as AutoUpdatePolicy)
    : null;
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): SemverParts | null {
  // Strict-enough x.y.z[-prerelease][+build] parser. Only the major /
  // minor / patch numbers participate in the auto-update decision; the
  // prerelease/build tail is preserved by npm itself when installing.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * Compute the largest bump kind between `from` and `to`. Returns
 * `null` when either string isn't valid semver, or when `to` is not
 * strictly newer than `from`. The string ordering is enough — we
 * never auto-downgrade, even if the registry briefly serves an older
 * "latest".
 */
export function classifyBump(from: string, to: string): 'patch' | 'minor' | 'major' | null {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return null;
  if (b.major > a.major) return 'major';
  if (b.major < a.major) return null;
  if (b.minor > a.minor) return 'minor';
  if (b.minor < a.minor) return null;
  if (b.patch > a.patch) return 'patch';
  return null;
}

const POLICY_RANK: Record<AutoUpdatePolicy, number> = {
  off: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

const BUMP_RANK: Record<'patch' | 'minor' | 'major', number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

export interface AutoUpdateDecisionInput {
  currentVersion: string;
  latestVersion: string | null;
  policy: AutoUpdatePolicy;
  /** True when npm has flagged the installed version as deprecated. */
  currentVersionDeprecated: boolean;
}

export interface AutoUpdateDecision {
  /** Whether the session-start hook should kick off an upgrade. */
  shouldUpdate: boolean;
  /** The classified bump kind (null when no bump is available). */
  bump: 'patch' | 'minor' | 'major' | null;
  /** Why the decision came out the way it did, for logging. */
  reason: string;
  /**
   * True when the deprecation override fired - i.e. policy was 'off'
   * (or insufficient for the bump) but the installed version is
   * deprecated, so we elevate to a security-floor patch upgrade.
   */
  deprecationOverride: boolean;
}

/**
 * Decide whether the session-start hook should auto-upgrade. The
 * decision is *whether* to trigger; the actual `npm install -g` runs
 * in the hook so a long network call cannot block the session.
 */
export function decideAutoUpdate(input: AutoUpdateDecisionInput): AutoUpdateDecision {
  const { currentVersion, latestVersion, policy, currentVersionDeprecated } = input;

  if (!latestVersion) {
    return { shouldUpdate: false, bump: null, reason: 'no latest version available', deprecationOverride: false };
  }
  const bump = classifyBump(currentVersion, latestVersion);
  if (!bump) {
    return { shouldUpdate: false, bump: null, reason: 'already at or above latest', deprecationOverride: false };
  }

  const policyAllows = POLICY_RANK[policy] >= BUMP_RANK[bump];
  if (policyAllows) {
    return {
      shouldUpdate: true,
      bump,
      reason: `policy '${policy}' permits ${bump} bump`,
      deprecationOverride: false,
    };
  }

  // Deprecation override: maintainers flagged this version (typically a
  // security advisory), so a patch bump is elevated past a policy that would
  // otherwise refuse it — but never a minor or major jump, which can carry
  // behaviour changes the user did not agree to.
  //
  // NOT past `off`. The override fires only for a `patch` bump and every
  // policy above `off` already permits one, so `off` was the only setting it
  // could ever override — the one whose whole meaning is "never install
  // anything without me asking". Its trigger is a string the PUBLISHER writes
  // into the registry, which made it a remote switch on a user's explicit
  // refusal. `memesh doctor` reports a deprecated version as a FAIL either
  // way; the user decides.
  //
  // This function has no caller outside its own test today — the live path is
  // `decideAutoUpdateHook`, which runs unattended from the Stop hook and
  // spawns a detached `npm install -g`. Both are fixed, so wiring this one up
  // later cannot reintroduce the hazard.
  if (currentVersionDeprecated && bump === 'patch' && policy !== 'off') {
    return {
      shouldUpdate: true,
      bump,
      reason: `installed ${currentVersion} is deprecated; security override forces patch upgrade despite policy '${policy}'`,
      deprecationOverride: true,
    };
  }

  return {
    shouldUpdate: false,
    bump,
    reason: `policy '${policy}' does not permit ${bump} bump`,
    deprecationOverride: false,
  };
}

function parseInstalledGlobalVersion(raw: string): string | null {
  const parsed = JSON.parse(raw) as InstalledPackageTree;
  return parsed.dependencies?.['@pcircle/memesh']?.version ?? null;
}

export function getInstalledGlobalVersion(
  options: RunGlobalUpdateOptions = {},
): string | null {
  const { execFileSyncImpl = execFileSync } = options;

  try {
    const raw = execFileSyncImpl(
      'npm',
      ['ls', '-g', '@pcircle/memesh', '--json', '--depth=0'],
      { encoding: 'utf8' },
    );
    return parseInstalledGlobalVersion(raw);
  } catch {
    return null;
  }
}

export function runGlobalUpdate(
  latestVersion: string,
  options: RunGlobalUpdateOptions = {},
): { installedVersion: string } {
  const { execFileSyncImpl = execFileSync } = options;

  execFileSyncImpl(
    'npm',
    ['install', '-g', `@pcircle/memesh@${latestVersion}`],
    { stdio: 'inherit' },
  );

  const installedVersion = getInstalledGlobalVersion({ execFileSyncImpl });
  if (installedVersion !== latestVersion) {
    if (installedVersion) {
      throw new Error(`expected ${latestVersion}, but npm reports ${installedVersion} is installed`);
    }
    throw new Error('npm did not report a global @pcircle/memesh installation after update');
  }

  return { installedVersion };
}
