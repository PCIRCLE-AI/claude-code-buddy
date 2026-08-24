/**
 * Where the work stands RIGHT NOW, derived from local git every time it is
 * asked. Never stored.
 *
 * Why this module exists. `task_state` records what the user said — a goal, a
 * next step — and the session-start block presented it as the project's
 * current status. Those are different things, and the difference is not
 * cosmetic: a memory is true forever once written (v4.6.0 really was released),
 * while status changes without anyone saying so. On 2026-08-24 the injected
 * block opened with "Just finished: v4.6.0" while 38 PRs had merged since and
 * npm was serving 4.7.3. Nothing was corrupted. The world had simply moved and
 * nothing had told the store.
 *
 * So status is derived here instead. Every field below is read from git at the
 * moment of the call, which makes it authoritative and makes staleness
 * impossible by construction rather than by discipline.
 *
 * LOCAL GIT ONLY — no network, no `gh`. Open-PR state would need auth, would
 * add latency to a hook with a budget measured in seconds, and would fail
 * offline. Local git answers "where am I" completely enough, in milliseconds.
 *
 * BEST-EFFORT, like every other read on the session-start path. A directory
 * that is not a repository, a machine without git, a timeout: all return null
 * and the block simply does not appear. This is the one design principle
 * status shares with memory — never break the session over context that is
 * nice to have.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * A LEAF module by requirement, not by preference.
 *
 * `scripts/generate-hook-core.mjs` mirrors compiled core modules into
 * `scripts/hooks/_generated/` so the hooks run the identical code, and it
 * flattens the paths as it copies — a mirrored module can only import other
 * mirrored ones. `why.ts` has the same five-second git wrapper and was the
 * obvious place to borrow from, but borrowing would have made this module
 * un-mirrorable and left the hook and the CLI deriving status differently,
 * which is the exact divergence `briefing.test.ts`'s parity case exists to
 * forbid. Eight lines duplicated is the cheaper half of that trade.
 */
const GIT_TIMEOUT_MS = 5000;

export interface RepoState {
  /** Current branch, or null on a detached HEAD. */
  branch: string | null;
  /** Files with uncommitted changes, staged or not, including untracked. */
  uncommitted: number;
  /** Most recent reachable tag, or null when the repository has none. */
  lastTag: string | null;
  /** Commits between `lastTag` and HEAD. Null when there is no tag. */
  commitsSinceTag: number | null;
  /** `version` from the nearest package.json, or null when there is none. */
  declaredVersion: string | null;
  /**
   * Whether a `v<declaredVersion>` tag exists.
   *
   * False is the interesting value: it means the repository declares a version
   * nobody can install yet — the window between merging a release PR and
   * cutting the tag. Null when there is no declared version to check.
   */
  declaredVersionIsTagged: boolean | null;
}

/** Run git; a failure is an answer here, not an exception. */
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** The `version` field of the repository root's package.json, if any. */
function declaredVersionOf(repoRoot: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Read the repository state at `cwd`, or null when there isn't one.
 *
 * Deliberately NOT cached, unlike `getProjectName` next door. A project's
 * identity cannot change mid-process; its branch and working tree can, and a
 * cached "0 uncommitted" would reintroduce exactly the staleness this module
 * exists to remove.
 */
export function readRepoState(cwdInput?: string | null): RepoState | null {
  const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();

  // One probe decides whether anything else is worth spawning: it fails for a
  // non-repository, a missing git, and an unreadable path alike.
  const repoRoot = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) return null;

  // A detached HEAD answers "HEAD" here, which is not a branch name.
  const branchRaw = tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;

  const statusOut = tryGit(cwd, ['status', '--porcelain']);
  const uncommitted = statusOut ? statusOut.split('\n').filter(l => l.trim() !== '').length : 0;

  // `describe --tags --abbrev=0` fails rather than answering when no tag is
  // reachable, which is why the null is meaningful and not an error to report.
  const lastTag = tryGit(cwd, ['describe', '--tags', '--abbrev=0']);
  let commitsSinceTag: number | null = null;
  if (lastTag) {
    const count = tryGit(cwd, ['rev-list', '--count', `${lastTag}..HEAD`]);
    const parsed = count === null ? Number.NaN : Number.parseInt(count, 10);
    commitsSinceTag = Number.isFinite(parsed) ? parsed : null;
  }

  const declaredVersion = declaredVersionOf(repoRoot);
  let declaredVersionIsTagged: boolean | null = null;
  if (declaredVersion) {
    // `tag --list <exact>` prints the tag or nothing; it does not fail on a
    // miss, so an empty answer is the miss and null stays reserved for "git
    // could not tell us".
    const hit = tryGit(cwd, ['tag', '--list', `v${declaredVersion}`]);
    declaredVersionIsTagged = hit === null ? null : hit.length > 0;
  }

  return { branch, uncommitted, lastTag, commitsSinceTag, declaredVersion, declaredVersionIsTagged };
}

/**
 * The injected "where things actually stand" lines, or [] when there is no
 * repository to describe.
 *
 * Reads as facts because they are facts, and carries no timestamp because
 * there is nothing to be stale about — it was read on the way to being shown.
 */
export function repoStateLines(state: RepoState | null): string[] {
  if (!state) return [];

  const first: string[] = [];
  if (state.branch) first.push(`branch ${state.branch}`);
  first.push(state.uncommitted === 0 ? 'working tree clean' : `${state.uncommitted} uncommitted`);

  const lines = ['Where the repository actually stands (read just now):', `- ${first.join(' · ')}`];

  if (state.lastTag) {
    const since = state.commitsSinceTag;
    lines.push(
      since === null ? `- last tag ${state.lastTag}`
        : since === 0 ? `- at tag ${state.lastTag}`
          : `- ${since} commit${since === 1 ? '' : 's'} since ${state.lastTag}`,
    );
  }

  // Only worth a line when it is NOT the quiet case. "declared and tagged" is
  // the normal state and saying so every session is noise; declared-but-untagged
  // is the window where main claims a version npm cannot serve.
  if (state.declaredVersion && state.declaredVersionIsTagged === false) {
    lines.push(`- package.json declares ${state.declaredVersion}, which has no tag yet`);
  }

  return lines;
}
