import type Database from 'better-sqlite3';
export declare function removeFromFts(db: Database.Database, entityId: number, name: string, prevObsText: string): void;
export declare function insertFtsRow(db: Database.Database, entityId: number, name: string, observationsText: string): void;
//# sourceMappingURL=fts-index.d.ts.map