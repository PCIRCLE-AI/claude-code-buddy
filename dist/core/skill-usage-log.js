import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, } from 'fs';
import { dirname, join } from 'path';
import { memeshDir } from './paths.js';
const MAX_BYTES = 10 * 1024 * 1024;
const TRUNCATE_KEEP = 6 * 1024 * 1024;
function defaultLogPath() {
    return join(memeshDir(), 'skill-usage.jsonl');
}
function ensureParent(path) {
    try {
        const dir = dirname(path);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    catch {
    }
}
function rotateIfNeeded(path) {
    let fd = null;
    let tmpPath = null;
    try {
        try {
            fd = openSync(path, 'r');
        }
        catch {
            return;
        }
        const { size } = fstatSync(fd);
        if (size < MAX_BYTES * 1.2)
            return;
        const readLen = Math.min(TRUNCATE_KEEP, size);
        const offset = size - readLen;
        const buf = Buffer.alloc(readLen);
        let totalRead = 0;
        while (totalRead < readLen) {
            const n = readSync(fd, buf, totalRead, readLen - totalRead, offset + totalRead);
            if (n === 0)
                break;
            totalRead += n;
        }
        closeSync(fd);
        fd = null;
        const tail = buf.subarray(0, totalRead);
        const firstNl = tail.indexOf(0x0a);
        const aligned = firstNl >= 0 ? tail.subarray(firstNl + 1) : tail;
        tmpPath = `${path}.rot.${process.pid}.${Date.now()}`;
        writeFileSync(tmpPath, aligned, { mode: 0o600 });
        renameSync(tmpPath, path);
        tmpPath = null;
    }
    catch {
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch { }
        }
        if (tmpPath !== null) {
            try {
                unlinkSync(tmpPath);
            }
            catch { }
        }
    }
}
export function logSkillEvent(event, payload, path) {
    const target = path ?? defaultLogPath();
    try {
        ensureParent(target);
        rotateIfNeeded(target);
        const line = JSON.stringify({ ts: new Date().toISOString(), event, payload }) + '\n';
        appendFileSync(target, line);
        try {
            chmodSync(target, 0o600);
        }
        catch { }
    }
    catch {
    }
}
export function summariseSkillUsage(path) {
    const target = path ?? defaultLogPath();
    const out = {
        total_events: 0,
        events_by_name: {},
        log_path: target,
        log_bytes: 0,
    };
    if (!existsSync(target))
        return out;
    let raw;
    try {
        const buf = readFileSync(target);
        out.log_bytes = buf.length;
        raw = buf.toString('utf8');
    }
    catch {
        return out;
    }
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!parsed.event || typeof parsed.event !== 'string')
            continue;
        out.total_events += 1;
        out.events_by_name[parsed.event] = (out.events_by_name[parsed.event] ?? 0) + 1;
        if (parsed.ts) {
            if (!out.first_event || parsed.ts < out.first_event)
                out.first_event = parsed.ts;
            if (!out.last_event || parsed.ts > out.last_event)
                out.last_event = parsed.ts;
        }
    }
    return out;
}
//# sourceMappingURL=skill-usage-log.js.map