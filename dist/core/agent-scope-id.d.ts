export declare const AGENT_SCOPE_ID_MAX_LENGTH = 200;
export declare function canonicalAgentScopeId(value: string): string;
export declare function isFilesystemPathScopeId(value: string): boolean;
export declare function lastPathSegment(value: string): string | null;
export declare function agentScopeIdRejection(field: string, value: string): string | null;
export declare const AGENT_MESSAGE_SCOPE_COLUMNS: ReadonlyArray<{
    readonly table: string;
    readonly columns: readonly string[];
}>;
export declare const AGENT_MESSAGE_PROJECT_TABLES: readonly string[];
//# sourceMappingURL=agent-scope-id.d.ts.map