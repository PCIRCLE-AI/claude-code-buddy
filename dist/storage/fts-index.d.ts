import type Database from 'better-sqlite3';
export declare const UNSPACED_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]>;
export declare const UNSPACED_SCRIPT_CLASS: string;
export declare const UNSPACED_SCRIPT_GLOB_RUN3: string;
export declare function segmentUnspacedScripts(text: string): string;
export declare function toIndexForm(text: string): string;
export declare function tokenizeQuery(text: string): string[];
export declare function hasSearchableTerms(text: string): boolean;
export declare function renderMatchExpression(terms: string[]): string | null;
export declare function isLoneUnspacedChar(term: string): boolean;
export declare function removeFromFts(db: Database.Database, entityId: number, name: string, prevObsText: string): void;
export declare function insertFtsRow(db: Database.Database, entityId: number, name: string, observationsText: string): void;
//# sourceMappingURL=fts-index.d.ts.map