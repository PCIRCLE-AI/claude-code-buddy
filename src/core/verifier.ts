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
import { remember } from './operations.js';
import { logSkillEvent } from './skill-usage-log.js';

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

  let stat = '';
  try {
    stat = execFileSync('git', ['-C', workdir, 'diff', '--stat', `${base}..HEAD`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    return {
      files_changed: 0,
      expected_files: expectedFiles ?? null,
      match: null,
      base,
      pass: false,
      summary: `git diff failed: ${err?.message ?? 'unknown'}`,
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

function buildObservations(input: VerifyAgentWorkInput, rc: RealityCheckResult, pass: boolean): string[] {
  const obs: string[] = [];
  obs.push(`Agent ${input.agent_id} verification: ${pass ? 'PASS' : 'FAIL'}`);
  obs.push(`Workdir: ${input.workdir}`);
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
  const base = resolveBase(input.workdir, input.base);
  const rc = realityCheck(input.workdir, base, input.claim?.expected_files);

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
    observations: buildObservations(input, rc, pass),
    tags,
  });

  // Local-only telemetry — counts how often the verification gate fires in
  // real usage so we can later validate the agentic-orchestration skill's
  // effectiveness with evidence rather than design claims. Never networked.
  // Payload is metadata only (no agent text or workdir contents).
  logSkillEvent('verify_agent_work_invoked', {
    agent_id_hashed: safeAgentId.slice(0, 8),
    pass,
    files_changed: rc.files_changed,
    has_external_report: Boolean(input.report),
  });

  return {
    entity_name: entityName,
    pass,
    reality_check: rc,
    external_report: input.report ?? null,
    timestamp,
  };
}
