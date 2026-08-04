// =============================================================================
// Agent Work Verifier — records verification reports as memesh entities
// =============================================================================
//
// Architecture choice: this module persists pre-computed verification reports
// rather than running tsc/vitest itself. The reasoning is:
//
// 1. memesh is a memory layer; running test suites is workflow concern that
//    belongs in the user's local hooks (~/.claude/hooks/agent-verification-gate.js).
// 2. MCP tool calls are expected to return promptly; tsc + full test suite
//    can take minutes and would block the LLM session.
// 3. The valuable persistence story is the *report*, not the running of it.
//
// What this module DOES do at call time:
//   - Reality check: git diff --stat <base>..HEAD on the workdir (cheap, deterministic)
//   - Optional: validate caller-provided report shape
//   - Persist report as an entity of type "verification_record"
//   - Tag pass/fail so future agents can recall via FTS

import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { readConfig } from './config.js';
import { remember } from './operations.js';
import { logSkillEvent } from './skill-usage-log.js';

/**
 * Resolve the agentic-orchestration opt-in flag.
 * Precedence: env > config > default(false). Mirrors the helper in
 * scripts/hooks/_shared.js so core and hooks treat this flag identically.
 */
function isAgenticOrchestrationEnabled(): boolean {
  const envVal = process.env.MEMESH_ENABLE_AGENTIC_ORCHESTRATION;
  if (envVal !== undefined) return envVal === '1';
  try {
    const cfg = readConfig();
    return cfg.enableAgenticOrchestration === true;
  } catch {
    return false;
  }
}

export interface ExternalCheck {
  pass: boolean;
  summary?: string;
}

export interface VerifyAgentWorkInput {
  agent_id: string;
  workdir: string;
  base?: string;
  claim?: {
    expected_files?: number;
  };
  report?: {
    pass: boolean;
    typecheck?: ExternalCheck;
    tests?: ExternalCheck;
    lint?: ExternalCheck;
    build?: ExternalCheck;
    summary?: string;
  };
}

/**
 * Three outcomes, because there are three.
 *
 * `unverified` is the one that used to be missing, and its absence was the
 * defect: a call with no `claim` and no `report` has nothing to check, and
 * this file reported that as `pass: true`. It also stored a memory reading
 * "verification: PASS" tagged `verification:pass`, and `memesh verify` printed
 * PASS and exited 0 — so a CI gate written as `memesh verify … && deploy`
 * proceeded on the strength of a check that never ran.
 *
 * Recording a snapshot without a claim is a legitimate mode and still works.
 * What changes is that it stops calling itself a pass. Absence of evidence is
 * not evidence: it gets its own verdict, and every surface says so.
 *
 * A single tri-state rather than `pass` plus a `verified` flag — two fields
 * describing one fact is how the `recall_hits` double-writer happened.
 */
export type Verdict = 'pass' | 'fail' | 'unverified';

export interface RealityCheckResult {
  files_changed: number;
  expected_files: number | null;
  match: boolean | null;  // null when no claim to check against
  base: string | null;
  verdict: Verdict;
  /**
   * @deprecated Use `verdict`. Same alias and same removal cycle as
   * `VerifyAgentWorkResult.pass`.
   *
   * 4.2.10 shipped BOTH booleans and `c9672791` removed BOTH, in one commit, in
   * favour of the tri-state. That is a breaking change for any 4.2.10 consumer
   * reading either one, in a patch release — `undefined` is falsy, so
   * `if (rc.pass)` quietly becomes "never passing" and `if (!rc.pass)` becomes
   * "always failing", and neither reports why. So both come back here as
   * aliases of `verdict === 'pass'`, which keeps those callers working AND does
   * not reinstate the original defect: an unverified run now reads `false`,
   * where the pre-4.2.11 boolean read `true`.
   *
   * (An earlier version of this comment described an asymmetry in which the
   * top-level field had been kept and this one dropped. There was none —
   * `git show c9672791 -- src/core/verifier.ts` deletes `pass: boolean` twice.)
   */
  pass: boolean;
  summary: string;
}

export interface VerifyAgentWorkResult {
  entity_name: string;
  verdict: Verdict;
  /**
   * @deprecated Use `verdict`. Kept for one minor cycle so upgrading from
   * 4.2.10 is not a breaking change.
   *
   * `verdict` exists because a boolean cannot say "nothing was checked", which
   * is the whole point of the fix — `true` meant both "verified and correct"
   * and "had nothing to verify". This alias is `verdict === 'pass'`, so an
   * existing `result.pass` caller keeps working AND stops seeing `true` for an
   * unverified run: the old bug does not come back with the field.
   *
   * Removing it outright would have made a patch release break every consumer
   * reading `result.pass`. Read `verdict` in new code — it is the only one of
   * the two that can tell you which kind of not-a-pass you have.
   */
  pass: boolean;
  reality_check: RealityCheckResult;
  external_report: VerifyAgentWorkInput['report'] | null;
  timestamp: string;
}

/**
 * Validate `workdir` and return its fully canonical path.
 *
 * Two regressions caught by 2026-05-05 codex review/challenge are
 * closed here:
 *
 *   1. Subdirectory rejection. The previous version checked for a
 *      `.git` entry directly inside `workdir`, which rejected valid
 *      monorepo paths like `/repo/packages/app`. We now ask git itself
 *      via `rev-parse --is-inside-work-tree`, which correctly accepts
 *      any path inside a working tree (handles `.git` directories,
 *      `.git` files for worktrees/submodules, and any nested
 *      subdirectory).
 *
 *   2. Symlink bypass. `path.resolve()` only normalises `.`/`..` —
 *      it does NOT follow symlinks. A symlink pointing at a different
 *      git repo would pass the old check pointing at one path while
 *      git operations actually ran against another. `realpathSync`
 *      collapses symlinks, so the path we validate is the path git
 *      will operate on.
 */
function validateWorkdir(workdir: string): string {
  if (!isAbsolute(workdir)) {
    throw new Error(`workdir must be an absolute path, got "${workdir}"`);
  }

  let canonical: string;
  try {
    canonical = realpathSync(workdir);
  } catch (err) {
    throw new Error(
      `workdir does not exist or is not accessible: "${workdir}" (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }

  let stat;
  try { stat = statSync(canonical); }
  catch (err) { throw new Error(`workdir not stat-able: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); }
  if (!stat.isDirectory()) {
    throw new Error(`workdir is not a directory: "${canonical}"`);
  }

  // Ask git itself whether this path is inside a working tree. This
  // correctly accepts subdirectories of a repo (the previous `.git`
  // existence check rejected them) and naturally handles `.git` files
  // for worktrees/submodules.
  try {
    const inside = execFileSync('git', ['-C', canonical, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') {
      throw new Error('not inside work tree');
    }
  } catch {
    throw new Error(
      `workdir is not a git working tree: "${canonical}"`
    );
  }

  return canonical;
}

function resolveBase(workdir: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const candidates = ['origin/main', 'main', 'origin/develop', 'develop'];
  for (const ref of candidates) {
    try {
      const sha = execFileSync('git', ['-C', workdir, 'merge-base', 'HEAD', ref], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sha) return sha;
    } catch { /* try next */ }
  }
  try {
    return execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD~1'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Attach the deprecated `pass` alias.
 *
 * One place, not four. Setting it at each `return` is how the two booleans
 * drifted apart to begin with: it is only correct if every author of every
 * future early return remembers, and the reality-check has four of them.
 */
function withPassAlias(rc: Omit<RealityCheckResult, 'pass'>): RealityCheckResult {
  return { ...rc, pass: rc.verdict === 'pass' };
}

function realityCheck(workdir: string, base: string | null, expectedFiles?: number): RealityCheckResult {
  return withPassAlias(computeRealityCheck(workdir, base, expectedFiles));
}

function computeRealityCheck(
  workdir: string,
  base: string | null,
  expectedFiles?: number,
): Omit<RealityCheckResult, 'pass'> {
  // Could not check, as opposed to checked and found wrong. These used to
  // return `pass: false`, which reads as "the agent's work failed" when what
  // actually happened is that this tool could not run.
  if (!base) {
    return {
      files_changed: 0,
      expected_files: expectedFiles ?? null,
      match: null,
      base: null,
      verdict: 'unverified',
      summary: 'no git base discoverable; cannot reality-check',
    };
  }

  let stat: string;
  try {
    stat = execFileSync('git', ['-C', workdir, 'diff', '--stat', `${base}..HEAD`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      files_changed: 0,
      expected_files: expectedFiles ?? null,
      match: null,
      base,
      verdict: 'unverified',
      summary: `git diff failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  const fileLines = stat
    .split('\n')
    .filter((l) => l.includes('|') && !l.includes('files changed'));
  const filesChanged = fileLines.length;

  // The original defect. Counting files is not checking them against
  // anything, so there is nothing here that can pass.
  if (expectedFiles == null) {
    return {
      files_changed: filesChanged,
      expected_files: null,
      match: null,
      base,
      verdict: 'unverified',
      summary: `${filesChanged} files changed (no claim to check against)`,
    };
  }

  const match = filesChanged === expectedFiles;
  return {
    files_changed: filesChanged,
    expected_files: expectedFiles,
    match,
    base,
    verdict: match ? 'pass' : 'fail',
    summary: match
      ? `reality OK: ${filesChanged}/${expectedFiles} files`
      : `reality MISMATCH: agent claimed ${expectedFiles}, actual ${filesChanged} (only committed changes count — uncommitted work reads as 0; commit before verifying)`,
  };
}

function buildObservations(
  input: VerifyAgentWorkInput,
  rc: RealityCheckResult,
  verdict: Verdict,
  canonicalWorkdir: string,
): string[] {
  const obs: string[] = [];
  // This line is what a future agent recalls and acts on, so it has to be
  // able to say "nobody checked" — it used to read PASS in that case.
  obs.push(`Agent ${input.agent_id} verification: ${verdict.toUpperCase()}`);
  // Record both the input path AND the canonical (realpath'd) path so
  // a future reader can spot symlink-induced surprises.
  obs.push(`Workdir: ${canonicalWorkdir}`);
  if (canonicalWorkdir !== input.workdir) {
    obs.push(`Workdir input (pre-realpath): ${input.workdir}`);
  }
  if (rc.base) obs.push(`Base: ${rc.base}`);
  obs.push(`Reality check: ${rc.summary}`);

  const r = input.report;
  if (r) {
    if (r.typecheck) obs.push(`Typecheck: ${r.typecheck.pass ? 'PASS' : 'FAIL'}${r.typecheck.summary ? ' — ' + r.typecheck.summary : ''}`);
    if (r.tests) obs.push(`Tests: ${r.tests.pass ? 'PASS' : 'FAIL'}${r.tests.summary ? ' — ' + r.tests.summary : ''}`);
    if (r.lint) obs.push(`Lint: ${r.lint.pass ? 'PASS' : 'FAIL'}${r.lint.summary ? ' — ' + r.lint.summary : ''}`);
    if (r.build) obs.push(`Build: ${r.build.pass ? 'PASS' : 'FAIL'}${r.build.summary ? ' — ' + r.build.summary : ''}`);
    if (r.summary) obs.push(`Hook summary: ${r.summary}`);
  } else {
    obs.push('External report: not provided (reality-check only)');
  }

  return obs;
}

/**
 * Combine the git reality-check with the externally-computed report.
 *
 * Three rules, in order:
 *
 *   1. Any `fail` wins. A failed claim cross-check or a failing test report is
 *      a failure regardless of what the other half says.
 *   2. Otherwise, a `pass` needs at least one thing to have actually been
 *      checked. A matched file claim counts; a supplied external report counts.
 *   3. If nothing was checked, the verdict is `unverified`.
 *
 * Rule 2 is the fix. The previous expression was
 * `rc.pass && (input.report?.pass ?? true)`, which defaulted a missing report
 * to `true` and combined it with a reality-check that also returned `true`
 * when there was no claim — so two absences multiplied into a pass.
 */
function combineVerdict(
  realityVerdict: Verdict,
  reportPass: boolean | undefined,
  claimWentUnevaluated: boolean
): Verdict {
  if (realityVerdict === 'fail' || reportPass === false) return 'fail';

  // A claim the caller supplied but that could not be evaluated is not
  // something the other half can vouch for. `realityCheck` returns early when
  // no git base is discoverable, before `expected_files` is ever compared, so
  // `memesh verify … --expected-files 5 --report tests.json` used to report an
  // unqualified pass on the strength of the report alone — while the file
  // claim silently went unchecked. Same shape as the bug this whole release is
  // about: one absence plus one presence read as success.
  //
  // Measured before the fix: expected_files 99 against a repo with one commit
  // and no discoverable base gave match: null, base: null, verdict: "pass".
  if (claimWentUnevaluated) return 'unverified';

  if (realityVerdict === 'pass' || reportPass === true) return 'pass';
  return 'unverified';
}

export function verifyAgentWork(input: VerifyAgentWorkInput): VerifyAgentWorkResult {
  // F8: validate workdir before shelling out to git. Reject non-existent
  // paths, non-directories, non-absolute paths, and paths that are not
  // git working trees. Without this, a caller (especially a
  // prompt-injected LLM) could trigger git operations against arbitrary
  // filesystem locations and observe the diff-stat output.
  // Returns the realpath-canonicalised path so all subsequent git
  // operations and the recorded report agree on the exact directory
  // git ran against (closes a symlink-confusion class).
  const canonicalWorkdir = validateWorkdir(input.workdir);

  const base = resolveBase(canonicalWorkdir, input.base);
  const rc = realityCheck(canonicalWorkdir, base, input.claim?.expected_files);

  // The caller asked for a file claim to be checked and it was not: `match`
  // is null only when the comparison never ran.
  const claimWentUnevaluated = input.claim?.expected_files != null && rc.match === null;
  const verdict = combineVerdict(rc.verdict, input.report?.pass, claimWentUnevaluated);
  const timestamp = new Date().toISOString();
  const safeAgentId = input.agent_id.replace(/[^a-zA-Z0-9_-]/g, '-');
  // 6-char random suffix prevents same-millisecond collisions (two parallel
  // agents calling at 12:00:00.123 would otherwise merge into one entity
  // because remember() appends observations on duplicate-name).
  const suffix = randomBytes(3).toString('hex');
  const entityName = `verification:${safeAgentId}:${timestamp.replace(/[:.]/g, '-')}:${suffix}`;

  const tags = [
    'verification',
    `agent:${safeAgentId}`,
    `verification:${verdict}`,
  ];

  remember({
    name: entityName,
    type: 'verification_record',
    observations: buildObservations(input, rc, verdict, canonicalWorkdir),
    tags,
  });

  // Local-only telemetry — counts how often the verification gate fires in
  // real usage so we can later validate the agentic-orchestration skill's
  // effectiveness with evidence rather than design claims. Never networked.
  // Payload is metadata only (no agent text or workdir contents).
  //
  // Opt-in only: the tool itself remains callable (it's a useful primitive),
  // but telemetry is gated by the same MEMESH_ENABLE_AGENTIC_ORCHESTRATION
  // flag that gates the banner and Bash nudge — opt-in to the experiment is
  // the user's consent to local usage logging.
  if (isAgenticOrchestrationEnabled()) {
    logSkillEvent('verify_agent_work_invoked');
  }

  return {
    entity_name: entityName,
    verdict,
    // Deprecated alias — see VerifyAgentWorkResult. Derived, never stored, so
    // it cannot drift from the verdict it mirrors.
    pass: verdict === 'pass',
    reality_check: rc,
    external_report: input.report ?? null,
    timestamp,
  };
}
