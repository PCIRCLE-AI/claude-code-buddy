// ============================================================================
// AUTO-GENERATED from src/core/paths.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
export function homeDir() {
    const home = process.env.HOME;
    if (home && home.length > 0)
        return home;
    const fromOs = os.homedir();
    if (fromOs && fromOs.length > 0)
        return fromOs;
    return os.userInfo().homedir;
}
export function memeshDir() {
    return process.env.MEMESH_DIR ?? path.join(homeDir(), '.memesh');
}
export function getDbPath() {
    return process.env.MEMESH_DB_PATH ?? path.join(memeshDir(), 'knowledge-graph.db');
}
export function getMemeshDirFromDbPath() {
    return process.env.MEMESH_DB_PATH
        ? path.dirname(process.env.MEMESH_DB_PATH)
        : memeshDir();
}
export function getProjectName(cwdInput) {
    const cwd = cwdInput && cwdInput.length > 0 ? cwdInput : process.cwd();
    const cached = projectNameCache.get(cwd);
    if (cached !== undefined)
        return cached;
    const resolved = resolveProjectIdentity(cwd);
    projectNameCache.set(cwd, resolved);
    return resolved;
}
const projectNameCache = new Map();
function resolveProjectIdentity(cwd) {
    const remote = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
    if (remote) {
        const slug = slugFromRemoteUrl(remote);
        if (slug)
            return slug;
    }
    const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
    if (root)
        return path.basename(root);
    return path.basename(cwd);
}
function tryGit(cwd, args) {
    try {
        const out = execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    catch {
        return null;
    }
}
export function slugFromRemoteUrl(url) {
    const cleaned = url.trim().replace(/\.git$/i, '').replace(/[/\\]+$/, '');
    if (!cleaned)
        return null;
    const seg = cleaned.split(/[/:\\]/).filter(Boolean).pop();
    return seg && seg.length > 0 ? seg : null;
}
export function _clearProjectNameCache() {
    projectNameCache.clear();
}
export function redactUserPaths(text) {
    const home = homeDir();
    const roots = new Set();
    const add = (root) => {
        if (!root || !path.isAbsolute(root))
            return;
        roots.add(root);
        try {
            roots.add(fs.realpathSync(root));
        }
        catch { }
    };
    add(home);
    const isInside = (child) => {
        const rel = path.relative(home, child);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    for (const dir of [memeshDir(), path.dirname(getDbPath())]) {
        if (dir && !isInside(dir))
            add(dir);
    }
    const flags = process.platform === 'linux' ? 'g' : 'gi';
    let out = text;
    for (const root of [...roots].sort((a, b) => b.length - a.length)) {
        const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const body = escaped.replace(/\\\\|\//g, '[\\\\/]{1,2}');
        out = out.replace(new RegExp(`(?<![\\w.~\\-\\\\/])${body}(?=[\\\\/]|$)`, flags), '~');
    }
    return out;
}
