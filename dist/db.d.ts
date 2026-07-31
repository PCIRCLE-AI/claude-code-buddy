import Database from 'better-sqlite3';
export declare function openDatabase(dbPath?: string): Database.Database;
export declare const FTS_SEGMENTATION_VERSION = 2;
export declare function runOnceMigration(db: Database.Database, opts: {
    key: string;
    version: number;
    describe: string;
    migrate: (db: Database.Database) => void;
}): boolean;
export declare function reindexFts(): {
    entities: number;
};
export declare function getPendingReindexInfo(): {
    from: number;
    to: number;
    droppedAt: string;
} | null;
export declare function clearPendingReindexFlag(): void;
export declare function closeDatabase(): void;
export declare function getDatabase(): Database.Database;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map