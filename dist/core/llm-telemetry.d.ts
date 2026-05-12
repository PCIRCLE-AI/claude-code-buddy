import type Database from 'better-sqlite3';
import type { LLMAttempt } from './llm-client.js';
export interface RecordTelemetryOpts {
    flow: string;
    project?: string;
    db?: Database.Database;
}
export declare function recordTelemetry(attempts: LLMAttempt[], opts: RecordTelemetryOpts): void;
export interface TelemetrySummary {
    flow: string;
    total_calls: number;
    total_attempts: number;
    successes: number;
    failures: number;
    fallback_used: number;
    median_latency_ms: number | null;
    by_provider: Record<string, {
        ok: number;
        fail: number;
    }>;
    by_error_class: Record<string, number>;
    window_days: number;
}
export declare function summariseTelemetry(windowDays?: number, db?: Database.Database): TelemetrySummary[];
export interface PruneOptions {
    olderThanDays?: number;
    db?: Database.Database;
}
export interface PruneResult {
    deletedRows: number;
    cutoffIso: string;
    totalRowsAfter: number;
}
export declare function pruneTelemetry(opts?: PruneOptions): PruneResult;
//# sourceMappingURL=llm-telemetry.d.ts.map