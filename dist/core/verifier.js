import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';
import { readConfig } from './config.js';
import { remember } from './operations.js';
import { logSkillEvent } from './skill-usage-log.js';
function isAgenticOrchestrationEnabled() {
    const envVal = process.env.MEMESH_ENABLE_AGENTIC_ORCHESTRATION;
    if (envVal !== undefined)
        return envVal === '1';
    try {
        const cfg = readConfig();
        return cfg.enableAgenticOrchestration === true;
    }
    catch {
        return false;
    }
}
function validateWorkdir(workdir) {
    if (!isAbsolute(workdir)) {
        throw new Error(`workdir must be an absolute path, got "${workdir}"`);
    }
    let canonical;
    try {
        canonical = realpathSync(workdir);
    }
    catch (err) {
        throw new Error(`workdir does not exist or is not accessible: "${workdir}" (${err instanceof Error ? err.message : String(err)})`, { cause: err });
    }
    let stat;
    try {
        stat = statSync(canonical);
    }
    catch (err) {
        throw new Error(`workdir not stat-able: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!stat.isDirectory()) {
        throw new Error(`workdir is not a directory: "${canonical}"`);
    }
    try {
        const inside = execFileSync('git', ['-C', canonical, 'rev-parse', '--is-inside-work-tree'], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (inside !== 'true') {
            throw new Error('not inside work tree');
        }
    }
    catch {
        throw new Error(`workdir is not a git working tree: "${canonical}"`);
    }
    return canonical;
}
function resolveBase(workdir, explicit) {
    if (explicit)
        return explicit;
    const candidates = ['origin/main', 'main', 'origin/develop', 'develop'];
    for (const ref of candidates) {
        try {
            const sha = execFileSync('git', ['-C', workdir, 'merge-base', 'HEAD', ref], {
                encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            if (sha)
                return sha;
        }
        catch { }
    }
    try {
        return execFileSync('git', ['-C', workdir, 'rev-parse', 'HEAD~1'], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return null;
    }
}
function realityCheck(workdir, base, expectedFiles) {
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
    let stat;
    try {
        stat = execFileSync('git', ['-C', workdir, 'diff', '--stat', `${base}..HEAD`], {
            encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch (err) {
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
            : `reality MISMATCH: agent claimed ${expectedFiles}, actual ${filesChanged}`,
    };
}
function buildObservations(input, rc, verdict, canonicalWorkdir) {
    const obs = [];
    obs.push(`Agent ${input.agent_id} verification: ${verdict.toUpperCase()}`);
    obs.push(`Workdir: ${canonicalWorkdir}`);
    if (canonicalWorkdir !== input.workdir) {
        obs.push(`Workdir input (pre-realpath): ${input.workdir}`);
    }
    if (rc.base)
        obs.push(`Base: ${rc.base}`);
    obs.push(`Reality check: ${rc.summary}`);
    const r = input.report;
    if (r) {
        if (r.typecheck)
            obs.push(`Typecheck: ${r.typecheck.pass ? 'PASS' : 'FAIL'}${r.typecheck.summary ? ' — ' + r.typecheck.summary : ''}`);
        if (r.tests)
            obs.push(`Tests: ${r.tests.pass ? 'PASS' : 'FAIL'}${r.tests.summary ? ' — ' + r.tests.summary : ''}`);
        if (r.lint)
            obs.push(`Lint: ${r.lint.pass ? 'PASS' : 'FAIL'}${r.lint.summary ? ' — ' + r.lint.summary : ''}`);
        if (r.build)
            obs.push(`Build: ${r.build.pass ? 'PASS' : 'FAIL'}${r.build.summary ? ' — ' + r.build.summary : ''}`);
        if (r.summary)
            obs.push(`Hook summary: ${r.summary}`);
    }
    else {
        obs.push('External report: not provided (reality-check only)');
    }
    return obs;
}
function combineVerdict(realityVerdict, reportPass, claimWentUnevaluated) {
    if (realityVerdict === 'fail' || reportPass === false)
        return 'fail';
    if (claimWentUnevaluated)
        return 'unverified';
    if (realityVerdict === 'pass' || reportPass === true)
        return 'pass';
    return 'unverified';
}
export function verifyAgentWork(input) {
    const canonicalWorkdir = validateWorkdir(input.workdir);
    const base = resolveBase(canonicalWorkdir, input.base);
    const rc = realityCheck(canonicalWorkdir, base, input.claim?.expected_files);
    const claimWentUnevaluated = input.claim?.expected_files != null && rc.match === null;
    const verdict = combineVerdict(rc.verdict, input.report?.pass, claimWentUnevaluated);
    const timestamp = new Date().toISOString();
    const safeAgentId = input.agent_id.replace(/[^a-zA-Z0-9_-]/g, '-');
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
    if (isAgenticOrchestrationEnabled()) {
        logSkillEvent('verify_agent_work_invoked');
    }
    return {
        entity_name: entityName,
        verdict,
        pass: verdict === 'pass',
        reality_check: rc,
        external_report: input.report ?? null,
        timestamp,
    };
}
//# sourceMappingURL=verifier.js.map