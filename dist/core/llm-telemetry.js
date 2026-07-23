import { getDatabase } from '../db.js';
export function recordTelemetry(attempts, opts) {
    if (!attempts || attempts.length === 0)
        return;
    let db;
    try {
        db = opts.db ?? getDatabase();
    }
    catch {
        return;
    }
    const stmt = db.prepare(`
    INSERT INTO llm_telemetry (
      flow, provider, model, project, attempt_index, status,
      latency_ms, error_class, error_message, fallback_used
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const tx = db.transaction((rows) => {
        for (const a of rows) {
            try {
                stmt.run(opts.flow, a.provider, a.model ?? null, opts.project ?? null, a.index, a.status, a.latencyMs, a.errorClass ?? null, a.errorMessage ?? null, a.index > 0 ? 1 : 0);
            }
            catch {
            }
        }
    });
    try {
        tx(attempts);
    }
    catch { }
}
const MAX_SAMPLE_ERRORS = 5;
export function summariseTelemetry(windowDays = 30, db) {
    const conn = db ?? getDatabase();
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const rows = conn.prepare(`
    SELECT flow, provider, model, project, status, latency_ms, error_class, error_message, attempt_index, fallback_used
    FROM llm_telemetry
    WHERE ts >= ?
    ORDER BY ts ASC
  `).all(since);
    const byFlow = new Map();
    for (const r of rows) {
        let bucket = byFlow.get(r.flow);
        if (!bucket) {
            bucket = { attempts: [], primaryAttempts: 0 };
            byFlow.set(r.flow, bucket);
        }
        bucket.attempts.push(r);
        if (r.attempt_index === 0)
            bucket.primaryAttempts++;
    }
    const out = [];
    for (const [flow, bucket] of byFlow) {
        const successes = bucket.attempts.filter(a => a.status === 'ok').length;
        const failures = bucket.attempts.filter(a => a.status === 'fail').length;
        const fallbackUsed = bucket.attempts.filter(a => a.fallback_used === 1).length;
        const okLatencies = bucket.attempts.filter(a => a.status === 'ok' && a.latency_ms != null).map(a => a.latency_ms).sort((a, b) => a - b);
        const median = okLatencies.length === 0 ? null : okLatencies[Math.floor(okLatencies.length / 2)];
        const byProvider = {};
        const byModel = {};
        const byProject = {};
        for (const a of bucket.attempts) {
            const slot = a.status === 'ok' ? 'ok' : 'fail';
            byProvider[a.provider] ??= { ok: 0, fail: 0 };
            byProvider[a.provider][slot]++;
            const modelKey = a.model ?? 'unknown';
            byModel[modelKey] ??= { ok: 0, fail: 0 };
            byModel[modelKey][slot]++;
            const projectKey = a.project ?? '_unscoped';
            byProject[projectKey] ??= { ok: 0, fail: 0 };
            byProject[projectKey][slot]++;
        }
        const byErrorClass = {};
        for (const a of bucket.attempts) {
            if (a.error_class)
                byErrorClass[a.error_class] = (byErrorClass[a.error_class] ?? 0) + 1;
        }
        const sampleErrors = [];
        for (let i = bucket.attempts.length - 1; i >= 0 && sampleErrors.length < MAX_SAMPLE_ERRORS; i--) {
            const a = bucket.attempts[i];
            if (a.status === 'fail' && a.error_message) {
                sampleErrors.push({ error_class: a.error_class, message: a.error_message });
            }
        }
        out.push({
            flow,
            total_calls: bucket.primaryAttempts,
            total_attempts: bucket.attempts.length,
            successes,
            failures,
            fallback_used: fallbackUsed,
            median_latency_ms: median,
            by_provider: byProvider,
            by_model: byModel,
            by_project: byProject,
            by_error_class: byErrorClass,
            sample_errors: sampleErrors,
            window_days: windowDays,
        });
    }
    return out.sort((a, b) => b.total_attempts - a.total_attempts);
}
export function pruneTelemetry(opts = {}) {
    const olderThanDays = opts.olderThanDays ?? 180;
    const db = opts.db ?? getDatabase();
    const cutoffIso = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = db.prepare('DELETE FROM llm_telemetry WHERE ts < ?').run(cutoffIso);
    const totalRowsAfter = db.prepare('SELECT COUNT(*) AS c FROM llm_telemetry').get().c;
    return {
        deletedRows: result.changes,
        cutoffIso,
        totalRowsAfter,
    };
}
//# sourceMappingURL=llm-telemetry.js.map