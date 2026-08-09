import { MemeshDatabase } from './storage/sqlite.js';
export declare function openDatabase(dbPath?: string): MemeshDatabase;
export declare const FTS_SEGMENTATION_VERSION = 3;
export declare function runOnceMigration(db: MemeshDatabase, opts: {
    key: string;
    version: number;
    describe: string;
    migrate: (db: MemeshDatabase, fromVersion: number) => void;
}): boolean;
export declare function reindexFts(): {
    entities: number;
};
export declare function allowVectorIndexRebuild(dbPath: string, canRefill: () => Promise<boolean>): Promise<boolean>;
export declare function getPendingReindexInfo(): {
    from: number;
    to: number;
    droppedAt: string;
} | null;
export declare function clearPendingReindexFlag(): void;
export declare function closeDatabase(): void;
export declare function getDatabase(): MemeshDatabase;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map