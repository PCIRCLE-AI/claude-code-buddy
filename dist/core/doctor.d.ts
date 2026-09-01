import fs from 'fs';
import { detectCapabilities, getConfigPath } from './config.js';
import { probeProvider } from './llm-validator.js';
import { openDatabase, closeDatabase, isDatabaseOpen } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';
export type DoctorOverallStatus = 'PASS' | 'PASS_WITH_CONCERNS' | 'FAIL';
export interface DoctorCheck {
    id: string;
    label: string;
    status: DoctorCheckStatus;
    summary: string;
    fix?: string;
    fixId?: 'install-hooks' | 'fts-rebuild' | 'chmod-db';
    informational?: boolean;
    code?: string;
    params?: Record<string, string | number>;
}
export interface DoctorResult {
    status: DoctorOverallStatus;
    checks: DoctorCheck[];
}
interface DoctorOptions {
    packageRoot: string;
    packageVersion: string;
    probeHttp?: boolean;
    probeCapabilities?: boolean;
    embedTextImpl?: (text: string) => Promise<Float32Array | null>;
    probeProviderImpl?: typeof probeProvider;
    httpBaseUrl?: string;
    platform?: NodeJS.Platform;
    openDatabaseImpl?: typeof openDatabase;
    closeDatabaseImpl?: typeof closeDatabase;
    isDatabaseOpenImpl?: typeof isDatabaseOpen;
    detectCapabilitiesImpl?: typeof detectCapabilities;
    getConfigPathImpl?: typeof getConfigPath;
    getUpdateCheckImpl?: typeof getUpdateCheck;
    getCurrentInstallChannelImpl?: typeof getCurrentInstallChannel;
    installedPluginsPathImpl?: string;
    marketplaceHeadShaImpl?: (host: import('./install-channel.js').PluginHost) => string | null;
    pluginCacheDiscoveryImpl?: () => PluginCacheDiscovery[];
    getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
    existsSyncImpl?: typeof fs.existsSync;
    readFileSyncImpl?: typeof fs.readFileSync;
    statSyncImpl?: typeof fs.statSync;
    fetchImpl?: typeof fetch;
    agentMessageStoragePolicy?: {
        storage_quota_bytes?: number;
        retention_cutoff?: Date | string;
    };
    nativeBindingProbeImpl?: (packageRoot: string) => {
        ok: true;
    } | {
        ok: false;
        message: string;
    };
    resolveShellMemeshImpl?: () => string | null;
    probeMessageCapability?: boolean;
    messageCapabilityProbeImpl?: (packageRoot: string) => {
        ok: true;
    } | {
        ok: false;
        message: string;
    };
    probeMessageRouterStatus?: boolean;
    messageRouterStatusProbeImpl?: () => Promise<MessageRouterStatusProbe>;
}
interface PluginCacheDiscovery {
    host: import('./install-channel.js').PluginHost;
    packageRoot: string;
    installedPluginsPath?: string;
    unverifiableReason?: string;
}
type MessageRouterStatusProbe = {
    socket_path: string;
    socket: 'reachable' | 'missing' | 'insecure' | 'unreachable';
    active_registrations?: number;
    detail?: string;
};
export declare function hoursSince(sqliteTimestamp: string): number | null;
export declare function satisfiesMinimumNodeRange(version: string, range: string): boolean | null;
export declare function inspectNodeRuntime(packageRoot: string, existsSyncImpl: typeof fs.existsSync, readFileSyncImpl: typeof fs.readFileSync, nodeVersion?: string, moduleAbi?: string, hasNodeSqliteImpl?: () => boolean): DoctorCheck;
export declare function hasBuiltInSqlite(): boolean;
export declare function runDoctor(options: DoctorOptions): Promise<DoctorResult>;
export declare function formatDoctorReport(result: DoctorResult, packageVersion: string): string[];
export {};
//# sourceMappingURL=doctor.d.ts.map