import type { MemeshDatabase } from '../storage/sqlite.js';
import type { LLMAttempt } from './llm-client.js';
export interface RecordTelemetryOpts {
    flow: string;
    project?: string;
    db?: MemeshDatabase;
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
    by_model: Record<string, {
        ok: number;
        fail: number;
    }>;
    by_project: Record<string, {
        ok: number;
        fail: number;
    }>;
    by_error_class: Record<string, number>;
    sample_errors: Array<{
        error_class: string | null;
        message: string;
    }>;
    window_days: number;
}
export declare function summariseTelemetry(windowDays?: number, db?: MemeshDatabase): TelemetrySummary[];
export interface PruneOptions {
    olderThanDays?: number;
    db?: MemeshDatabase;
}
export interface PruneResult {
    deletedRows: number;
    cutoffIso: string;
    totalRowsAfter: number;
}
export declare function pruneTelemetry(opts?: PruneOptions): PruneResult;
//# sourceMappingURL=llm-telemetry.d.ts.map