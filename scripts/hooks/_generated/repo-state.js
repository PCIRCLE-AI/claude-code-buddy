// ============================================================================
// AUTO-GENERATED from src/core/repo-state.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const GIT_TIMEOUT_MS = 5000;
function tryGit(cwd, args) {
    try {
        return execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            timeout: GIT_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    }
    catch {
        return null;
    }
}
function declaredVersionOf(repoRoot) {
    try {
        const raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
        const version = JSON.parse(raw).version;
        return typeof version === 'string' && version.length > 0 ? version : null;
    }
    catch {
        return null;
    }
}
export function readRepoState(cwdInput) {
    const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
    const repoRoot = tryGit(cwd, ['rev-parse', '--show-toplevel']);
    if (!repoRoot)
        return null;
    const branchRaw = tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
    const statusOut = tryGit(cwd, ['status', '--porcelain']);
    const uncommitted = statusOut ? statusOut.split('\n').filter(l => l.trim() !== '').length : 0;
    const lastTag = tryGit(cwd, ['describe', '--tags', '--abbrev=0']);
    let commitsSinceTag = null;
    if (lastTag) {
        const count = tryGit(cwd, ['rev-list', '--count', `${lastTag}..HEAD`]);
        const parsed = count === null ? Number.NaN : Number.parseInt(count, 10);
        commitsSinceTag = Number.isFinite(parsed) ? parsed : null;
    }
    const declaredVersion = declaredVersionOf(repoRoot);
    let declaredVersionIsTagged = null;
    if (declaredVersion) {
        const hit = tryGit(cwd, ['tag', '--list', `v${declaredVersion}`]);
        declaredVersionIsTagged = hit === null ? null : hit.length > 0;
    }
    return { branch, uncommitted, lastTag, commitsSinceTag, declaredVersion, declaredVersionIsTagged };
}
export function repoStateLines(state) {
    if (!state)
        return [];
    const first = [];
    if (state.branch)
        first.push(`branch ${state.branch}`);
    first.push(state.uncommitted === 0 ? 'working tree clean' : `${state.uncommitted} uncommitted`);
    const lines = ['Where the repository actually stands (read just now):', `- ${first.join(' · ')}`];
    if (state.lastTag) {
        const since = state.commitsSinceTag;
        lines.push(since === null ? `- last tag ${state.lastTag}`
            : since === 0 ? `- at tag ${state.lastTag}`
                : `- ${since} commit${since === 1 ? '' : 's'} since ${state.lastTag}`);
    }
    if (state.declaredVersion && state.declaredVersionIsTagged === false) {
        lines.push(`- package.json declares ${state.declaredVersion}, which has no tag yet`);
    }
    return lines;
}
