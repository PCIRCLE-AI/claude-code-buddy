export declare function readHostConfig<T extends Record<string, unknown>>(): T;
export declare function readHostConfigFile<T extends Record<string, unknown>>(configuredPath: string): T;
export declare function readTokenFile(tokenFile: unknown): string;
export declare function ensureRouterTokenFile(tokenFile: string): string;
export declare function requiredString(value: unknown, field: string): string;
export declare function optionalStringArray(value: unknown, field: string): string[];
//# sourceMappingURL=config.d.ts.map