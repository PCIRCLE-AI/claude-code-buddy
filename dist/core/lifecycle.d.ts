import Database from 'better-sqlite3';
export declare function runAutoDecay(db: Database.Database): {
    decayed: number;
};
export declare function getDecayStatus(db: Database.Database): {
    lastDecayAt: string | null;
    entitiesBelowThreshold: number;
};
declare const PRESERVED_TYPES: Set<string>;
declare const NOISE_TYPES: Set<string>;
export declare function compressWeeklyNoise(db: Database.Database): {
    compressed: number;
    weeksProcessed: number;
};
export { PRESERVED_TYPES, NOISE_TYPES };
//# sourceMappingURL=lifecycle.d.ts.map