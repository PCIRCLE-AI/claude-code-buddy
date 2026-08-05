export declare function claudeProjectsDir(): string;
export declare function projectTranscriptSlug(cwd: string): string;
export declare function recordedCwd(text: string): string | null;
export interface TranscriptSession {
    sessionId: string;
    path: string;
    modifiedAt: string;
    lineCount: number;
    sizeBytes: number;
}
export interface ScanOptions {
    cwd?: string;
    windowDays?: number;
    now?: Date;
}
export declare function scanTranscripts(opts?: ScanOptions): TranscriptSession[];
export declare function transcriptMiningStatePath(override?: string): string;
export declare function lastTranscriptMineAt(projectKey: string, override?: string): number | null;
export declare function recordTranscriptMine(projectKey: string, atMs: number, override?: string): void;
export declare function transcriptMiningDue(nowMs: number, lastMs: number | null, intervalHours: number): boolean;
//# sourceMappingURL=transcript-source.d.ts.map