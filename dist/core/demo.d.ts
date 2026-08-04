import type Database from 'better-sqlite3';
export interface SeedResult {
    inserted: number;
    removed: number;
}
export declare const DEMO_RELATIONS: Array<[from: string, type: string, to: string]>;
export declare function seedDemo(db: Database.Database, opts?: {
    reset?: boolean;
}): SeedResult;
//# sourceMappingURL=demo.d.ts.map