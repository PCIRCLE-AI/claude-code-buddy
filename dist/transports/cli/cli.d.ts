#!/usr/bin/env node
export declare function createHostConfigAtomically(host: string, configPath: string, config: Record<string, unknown>): void;
export declare function feedbackBrowserOpenCommand(platform: NodeJS.Platform, url: string): {
    command: string;
    args: [string];
};
export declare function runCli(argv?: readonly string[]): Promise<void>;
//# sourceMappingURL=cli.d.ts.map