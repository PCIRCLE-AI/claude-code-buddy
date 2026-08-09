import type { MemeshDatabase } from '../storage/sqlite.js';
export interface SeedResult {
    inserted: number;
    removed: number;
}
export declare const DEMO_RELATIONS: Array<[from: string, type: string, to: string]>;
export declare function seedDemo(db: MemeshDatabase, opts?: {
    reset?: boolean;
}): SeedResult;
//# sourceMappingURL=demo.d.ts.map