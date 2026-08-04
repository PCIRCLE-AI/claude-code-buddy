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
//# sourceMappingURL=transcript-source.d.ts.map