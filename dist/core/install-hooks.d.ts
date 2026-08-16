export declare function settingsHaveMemeshHooks(settingsPath: string): boolean;
export interface InstallOptions {
    pluginRoot: string;
    pluginVersion: string;
    scope: 'user' | 'project';
    cwd?: string;
    dryRun?: boolean;
    forceOverPlugin?: boolean;
    installedPluginsPathImpl?: string;
}
export interface InstallResult {
    settingsPath: string;
    backupPath: string | null;
    scope: 'user' | 'project';
    added: number;
    skipped: number;
    pruned: number;
    conflicts: Array<{
        event: string;
        matcher: string;
        existingCount: number;
    }>;
    markerPath: string;
    pluginRuntimeDetected?: {
        installPath: string;
        version: string;
    } | null;
}
export interface UninstallResult {
    settingsPath: string;
    backupPath: string | null;
    removed: number;
}
export declare function detectPluginRuntime(installedPluginsPathImpl?: string): {
    installPath: string;
    version: string;
} | null;
export declare function installHooks(opts: InstallOptions): InstallResult;
export interface UninstallOptions {
    scope: 'user' | 'project';
    cwd?: string;
    dryRun?: boolean;
}
export declare function uninstallHooks(opts: UninstallOptions): UninstallResult;
export interface InstallMarker {
    installed_at: string;
    version: string;
    plugin_root: string;
    scope: 'user' | 'project';
    settings_path: string;
}
export declare function readInstallMarker(): InstallMarker | null;
//# sourceMappingURL=install-hooks.d.ts.map