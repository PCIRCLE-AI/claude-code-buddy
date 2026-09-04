import type { MemeshDatabase } from './sqlite.js';
export declare const SESSION_DEDUPE_KEY = "session_observation_dedupe";
export declare const ZERO_EDIT_RETRACT_KEY = "session_zero_edit_retract";
export declare const FUSED_LESSON_SPLIT_KEY = "fused_lesson_split";
export declare const ARCHIVED_FTS_ROWS_KEY = "archived_fts_rows";
export declare const ARCHIVED_VECTOR_ROWS_KEY = "archived_vector_rows";
export declare function dedupeObservations(db: MemeshDatabase): number;
export declare function bashWritesFiles(command: string): boolean;
export declare function retractZeroEditClaims(db: MemeshDatabase): number;
export declare function splitFusedLessons(db: MemeshDatabase, deps: {
    deriveTitle: (type: string, observations: string[]) => string | null;
    markReindexOwed: (conn: MemeshDatabase) => void;
}): number;
export declare function dropArchivedIndexRows(db: MemeshDatabase): {
    ftsRows: number;
    vectorRows: number;
};
//# sourceMappingURL=graph-repairs.d.ts.map