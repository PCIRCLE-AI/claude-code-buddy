import type { MemeshDatabase } from './sqlite.js';
export declare const SESSION_DEDUPE_KEY = "session_observation_dedupe";
export declare const ZERO_EDIT_RETRACT_KEY = "session_zero_edit_retract";
export declare const FUSED_LESSON_SPLIT_KEY = "fused_lesson_split";
export declare function dedupeObservations(db: MemeshDatabase): number;
export declare function bashWritesFiles(command: string): boolean;
export declare function retractZeroEditClaims(db: MemeshDatabase): number;
export declare function splitFusedLessons(db: MemeshDatabase, deps: {
    deriveTitle: (type: string, observations: string[]) => string | null;
    markReindexOwed: (conn: MemeshDatabase) => void;
}): number;
//# sourceMappingURL=graph-repairs.d.ts.map