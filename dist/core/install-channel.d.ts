import fs from 'fs';
import { execFileSync } from 'child_process';
export type InstallChannel = 'npm-global' | 'npm-local' | 'source-checkout' | 'plugin-marketplace' | 'unknown';
type ExistsSyncLike = typeof fs.existsSync;
type ExecFileSyncLike = typeof execFileSync;
interface DetectInstallChannelOptions {
    packageRoot: string;
    globalNpmRoot?: string | null | (() => string | null);
    existsSyncImpl?: ExistsSyncLike;
}
interface GetCurrentInstallChannelOptions {
    packageRoot: string;
    existsSyncImpl?: ExistsSyncLike;
    execFileSyncImpl?: ExecFileSyncLike;
}
export interface InstallChannelSupport {
    channel: InstallChannel;
    label: string;
    canSelfUpdate: boolean;
    recommendedCommand: string | null;
    guidance: string;
}
export type PluginHost = 'claude-code' | 'codex';
export declare const PLUGIN_REFRESH_COMMANDS: Readonly<Record<PluginHost, string>>;
export declare function pluginHostConfigRoot(host: PluginHost): string;
export declare function versionedPluginCacheRoots(root: string): string[];
export declare function detectPluginHost(packageRoot: string, options?: {
    env?: NodeJS.ProcessEnv;
}): PluginHost | null;
export declare function getGlobalNpmRoot(options?: {
    execFileSyncImpl?: ExecFileSyncLike;
    execPathImpl?: string;
}): string;
export declare function detectInstallChannel(options: DetectInstallChannelOptions): InstallChannel;
export declare function getCurrentInstallChannel(options: GetCurrentInstallChannelOptions): InstallChannel;
export declare function getInstallChannelSupport(channel: InstallChannel, packageRoot: string): InstallChannelSupport;
export {};
//# sourceMappingURL=install-channel.d.ts.map