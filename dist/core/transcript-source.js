import fs from 'fs';
import os from 'os';
import path from 'path';
export function claudeProjectsDir() {
    const override = process.env.CLAUDE_PROJECTS_DIR;
    if (override && override.trim() !== '')
        return override;
    return path.join(os.homedir(), '.claude', 'projects');
}
export function projectTranscriptSlug(cwd) {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
export function recordedCwd(text) {
    let seen = 0;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        if (++seen > 40)
            break;
        try {
            const entry = JSON.parse(line);
            if (typeof entry.cwd === 'string' && entry.cwd.length > 0)
                return entry.cwd;
        }
        catch {
        }
    }
    return null;
}
export function scanTranscripts(opts = {}) {
    const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : process.cwd();
    const windowDays = opts.windowDays ?? 3;
    const now = opts.now ?? new Date();
    const cutoffMs = now.getTime() - windowDays * 86400_000;
    const dir = path.join(claudeProjectsDir(), projectTranscriptSlug(cwd));
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const name of names) {
        if (!name.endsWith('.jsonl'))
            continue;
        const full = path.join(dir, name);
        let fd;
        try {
            fd = fs.openSync(full, 'r');
        }
        catch {
            continue;
        }
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile())
                continue;
            if (stat.mtimeMs < cutoffMs)
                continue;
            const buf = fs.readFileSync(fd);
            let lineCount = 0;
            for (let i = 0; i < buf.length; i++)
                if (buf[i] === 0x0a)
                    lineCount++;
            const prefix = buf.subarray(0, Math.min(buf.length, 65536)).toString('utf8');
            const sessionCwd = recordedCwd(prefix);
            if (sessionCwd !== null && path.normalize(sessionCwd) !== path.normalize(cwd))
                continue;
            sessions.push({
                sessionId: name.replace(/\.jsonl$/, ''),
                path: full,
                modifiedAt: new Date(stat.mtimeMs).toISOString(),
                lineCount,
                sizeBytes: stat.size,
            });
        }
        catch {
            continue;
        }
        finally {
            try {
                fs.closeSync(fd);
            }
            catch { }
        }
    }
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return sessions;
}
//# sourceMappingURL=transcript-source.js.map