import type { MemeshDatabase } from './sqlite.js';
export declare const UNSPACED_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]>;
export declare const UNSPACED_SCRIPT_CLASS: string;
export declare const UNSPACED_SCRIPT_GLOB_RUN3: string;
export declare function segmentUnspacedScripts(text: string): string;
export declare function toIndexForm(text: string): string;
export declare function tokenizeQuery(text: string): string[];
export declare const SQL_NFC_FUNCTION = "memesh_nfc";
export declare function registerNfcFunction(db: MemeshDatabase): void;
export declare function hasSearchableTerms(text: string): boolean;
export declare function renderMatchExpression(terms: string[]): string | null;
export declare function isLoneUnspacedChar(term: string): boolean;
export declare function removeFromFts(db: MemeshDatabase, entityId: number, name: string, prevObsText: string, prevTitle?: string | null): void;
export declare function joinIndexedObservations(contents: string[]): string;
export declare function indexedObservationText(db: MemeshDatabase, entityId: number): string;
export declare function insertFtsRow(db: MemeshDatabase, entityId: number, name: string, observationsText: string, title?: string | null): void;
//# sourceMappingURL=fts-index.d.ts.map