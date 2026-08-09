declare const DatabaseSync: typeof import("node:sqlite").DatabaseSync;
export type SqliteStatement = import('node:sqlite').StatementSync;
export type SqlOutputValue = import('node:sqlite').SQLOutputValue;
export type SqlInputValue = import('node:sqlite').SQLInputValue;
export interface OpenOptions {
    readOnly?: boolean;
    allowExtension?: boolean;
}
export interface TransactionFunction<A extends unknown[], R> {
    (...args: A): R;
    immediate(...args: A): R;
}
export declare class MemeshDatabase extends DatabaseSync {
    #private;
    constructor(path: string, options?: OpenOptions);
    pragma(statement: string): void;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R>;
}
export {};
//# sourceMappingURL=sqlite.d.ts.map