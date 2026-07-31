import type Database from 'better-sqlite3';
export declare const UNSPACED_SCRIPT_CLASS = "\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF";
export declare function segmentUnspacedScripts(text: string): string;
export declare function toIndexForm(text: string): string;
export declare function tokenizeQuery(text: string): string[];
export declare function renderMatchExpression(terms: string[]): string | null;
export declare function isLoneUnspacedChar(term: string): boolean;
export declare function removeFromFts(db: Database.Database, entityId: number, name: string, prevObsText: string): void;
export declare function insertFtsRow(db: Database.Database, entityId: number, name: string, observationsText: string): void;
//# sourceMappingURL=fts-index.d.ts.map