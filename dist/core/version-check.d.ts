import { execFile } from 'child_process';
export type UpdateCheckSource = 'fresh' | 'cache';
export type UpdateCheckFreshness = 'fresh' | 'cached' | 'stale' | 'unavailable';
export interface UpdateCheck {
    currentVersion: string;
    latestVersion: string | null;
    checkedAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessfulCheckAt: string | null;
    lastError: string | null;
    updateAvailable: boolean;
    checkSucceeded: boolean;
    source: UpdateCheckSource;
    freshness: UpdateCheckFreshness;
    currentVersionDeprecated: boolean;
    deprecationMessage: string | null;
}
interface CheckForUpdateOptions {
    execFileImpl?: typeof execFile;
    now?: Date;
    timeoutMs?: number;
    updateCheckPath?: string;
}
interface GetUpdateCheckOptions extends CheckForUpdateOptions {
    preferFresh?: boolean;
}
export declare const MAX_UPDATE_CHECK_FILES = 5;
export declare function checkForUpdate(currentVersion: string, options?: CheckForUpdateOptions): Promise<UpdateCheck>;
export declare function getLastUpdateCheck(currentVersion: string, options?: {
    updateCheckPath?: string;
    now?: Date;
}): UpdateCheck | null;
export declare function getUpdateCheck(currentVersion: string, options?: GetUpdateCheckOptions): Promise<UpdateCheck | null>;
export declare function formatUpdateCheckStatus(update: UpdateCheck | null): string[];
export {};
//# sourceMappingURL=version-check.d.ts.map