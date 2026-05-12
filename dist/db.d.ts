import Database from 'better-sqlite3';
export declare function openDatabase(dbPath?: string): Database.Database;
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