export interface SessionContext {
    sessionId: string;
    transcriptPath?: string;
    cwd: string;
    stopReason: string;
    wasAgenticLoop: boolean;
}
export interface ExtractedMemory {
    name: string;
    type: string;
    observations: string[];
    tags: string[];
}
export interface Extractor {
    extract(context: SessionContext): ExtractedMemory[];
}
export declare function parseTranscript(transcriptPath: string): {
    filesEdited: string[];
    bashCommands: string[];
    errorsEncountered: string[];
    toolCallCount: number;
};
export declare class RuleBasedExtractor implements Extractor {
    extract(context: SessionContext): ExtractedMemory[];
}
//# sourceMappingURL=extractor.d.ts.map