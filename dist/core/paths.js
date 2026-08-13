import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
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
    let real;
    try {
        real = fs.realpathSync.native(cwd);
    }
    catch {
        real = path.resolve(cwd);
    }
    const suffix = createHash('sha256').update(real).digest('hex').slice(0, 8);
    return `${path.basename(real)}-${suffix}`;
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
export const SECRET_PATTERN_SOURCES = [
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END[A-Z ]*PRIVATE KEY-----',
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?=\\n[ \\t]*\\n|$)',
    '(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^\\s:@/]+:[^\\s:@/]+@',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '[srp]k_(?:live|test)_[A-Za-z0-9]{16,}',
    'npm_[A-Za-z0-9]{36}',
    'sk-ant-[A-Za-z0-9_-]{16,}',
    'sk-[A-Za-z0-9_-]{16,}',
    'sk_[A-Za-z0-9]{16,}',
    'ghp_[A-Za-z0-9]{30,}',
    'gho_[A-Za-z0-9]{30,}',
    'gh[sur]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'A(?:KIA|SIA)[A-Z0-9]{16}',
    'AIza[A-Za-z0-9_-]{30,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'Bearer(?:\\s|\\\\[nrt])+[A-Za-z0-9_.\\-]{16,}',
];
export function redactSecrets(input) {
    let out = input;
    for (const s of SECRET_PATTERN_SOURCES)
        out = out.replace(new RegExp(s, 'gi'), '***REDACTED***');
    return out;
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
        out = out.replace(new RegExp(`(?<![\\w~](?:[\\\\/]{1,2})?)${body}(?=[\\\\/]|$)`, flags), '~');
    }
    return out;
}
//# sourceMappingURL=paths.js.map