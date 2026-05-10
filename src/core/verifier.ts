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

export interface RealityCheckResult {
  files_changed: number;
  expected_files: number | null;
  match: boolean | null;  // null when no claim to check against
  base: string | null;
  pass: boolean;
  summary: string;
}

export interface VerifyAgentWorkResult {
  entity_name: string;
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

function realityCheck(workdir: string, base: string | null, expectedFiles?: number): RealityCheckResult {
  if (!base) {
    return {
      files_changed: 0,
      expected_files: expectedFiles ?? null,
      match: null,
      base: null,
      pass: false,
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
      pass: false,
      summary: `git diff failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  const fileLines = stat
    .split('\n')
    .filter((l) => l.includes('|') && !l.includes('files changed'));
  const filesChanged = fileLines.length;

  if (expectedFiles == null) {
    return {
      files_changed: filesChanged,
      expected_files: null,
      match: null,
      base,
      pass: true,
      summary: `${filesChanged} files changed (no claim to check against)`,
    };
  }

  const match = filesChanged === expectedFiles;
  return {
    files_changed: filesChanged,
    expected_files: expectedFiles,
    match,
    base,
    pass: match,
    summary: match
      ? `reality OK: ${filesChanged}/${expectedFiles} files`
      : `reality MISMATCH: agent claimed ${expectedFiles}, actual ${filesChanged}`,
  };
}

function buildObservations(
  input: VerifyAgentWorkInput,
  rc: RealityCheckResult,
  pass: boolean,
  canonicalWorkdir: string,
): string[] {
  const obs: string[] = [];
  obs.push(`Agent ${input.agent_id} verification: ${pass ? 'PASS' : 'FAIL'}`);
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

  const reportPass = input.report?.pass ?? true;
  const pass = rc.pass && reportPass;
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
    pass ? 'verification:pass' : 'verification:fail',
  ];

  remember({
    name: entityName,
    type: 'verification_record',
    observations: buildObservations(input, rc, pass, canonicalWorkdir),
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
    logSkillEvent('verify_agent_work_invoked', {
      agent_id_hashed: safeAgentId.slice(0, 8),
      pass,
      files_changed: rc.files_changed,
      has_external_report: Boolean(input.report),
    });
  }

  return {
    entity_name: entityName,
    pass,
    reality_check: rc,
    external_report: input.report ?? null,
    timestamp,
  };
}
