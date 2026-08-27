import { execFileSync } from 'child_process';
type ExecFileSyncLike = typeof execFileSync;
interface RunGlobalUpdateOptions {
    execFileSyncImpl?: ExecFileSyncLike;
    installTimeoutMs?: number;
    readbackTimeoutMs?: number;
}
export type AutoUpdatePolicy = 'off' | 'patch' | 'minor' | 'major';
export declare function parseAutoUpdatePolicy(value: unknown): AutoUpdatePolicy | null;
export declare function classifyBump(from: string, to: string): 'patch' | 'minor' | 'major' | null;
export interface AutoUpdateDecisionInput {
    currentVersion: string;
    latestVersion: string | null;
    policy: AutoUpdatePolicy;
    currentVersionDeprecated: boolean;
}
export interface AutoUpdateDecision {
    shouldUpdate: boolean;
    bump: 'patch' | 'minor' | 'major' | null;
    reason: string;
    deprecationOverride: boolean;
}
export declare function decideAutoUpdate(input: AutoUpdateDecisionInput): AutoUpdateDecision;
export declare function getInstalledGlobalVersion(options?: RunGlobalUpdateOptions): string | null;
export declare function runGlobalUpdate(latestVersion: string, options?: RunGlobalUpdateOptions): {
    installedVersion: string;
};
export {};
//# sourceMappingURL=updater.d.ts.map