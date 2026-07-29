import type Database from 'better-sqlite3';
export declare function findConflicts(db: Database.Database, entityNames: string[]): string[];
export declare function trackAccess(db: Database.Database, entityIds: number[]): void;
//# sourceMappingURL=conflicts.d.ts.map