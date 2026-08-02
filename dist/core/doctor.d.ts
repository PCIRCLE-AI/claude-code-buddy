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
    informational?: boolean;
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
    getInstallChannelSupportImpl?: typeof getInstallChannelSupport;
    existsSyncImpl?: typeof fs.existsSync;
    readFileSyncImpl?: typeof fs.readFileSync;
    statSyncImpl?: typeof fs.statSync;
    fetchImpl?: typeof fetch;
    nativeBindingProbeImpl?: (packageRoot: string) => {
        ok: true;
    } | {
        ok: false;
        message: string;
    };
    resolveShellMemeshImpl?: () => string | null;
}
export declare function satisfiesMinimumNodeRange(version: string, range: string): boolean | null;
export declare function inspectNodeRuntime(packageRoot: string, existsSyncImpl: typeof fs.existsSync, readFileSyncImpl: typeof fs.readFileSync, nodeVersion?: string, moduleAbi?: string, hasNodeSqliteImpl?: () => boolean): DoctorCheck;
export declare function hasBuiltInSqlite(): boolean;
export declare function runDoctor(options: DoctorOptions): Promise<DoctorResult>;
export declare function formatDoctorReport(result: DoctorResult, packageVersion: string): string[];
export {};
//# sourceMappingURL=doctor.d.ts.map