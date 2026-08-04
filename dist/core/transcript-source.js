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
        let stat;
        try {
            stat = fs.statSync(full);
        }
        catch {
            continue;
        }
        if (!stat.isFile())
            continue;
        if (stat.mtimeMs < cutoffMs)
            continue;
        let lineCount = 0;
        try {
            const buf = fs.readFileSync(full);
            for (let i = 0; i < buf.length; i++)
                if (buf[i] === 0x0a)
                    lineCount++;
        }
        catch {
            continue;
        }
        sessions.push({
            sessionId: name.replace(/\.jsonl$/, ''),
            path: full,
            modifiedAt: new Date(stat.mtimeMs).toISOString(),
            lineCount,
            sizeBytes: stat.size,
        });
    }
    sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return sessions;
}
//# sourceMappingURL=transcript-source.js.map