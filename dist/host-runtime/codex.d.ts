#!/usr/bin/env node
import { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createCodexAppServerAdapter, type CodexAppServerAdapterOptions, type CodexAppServerThread, type StartCodexAppServerThreadInput } from '../host-adapters/codex-app-server.js';
import { connectRouterHost } from './router-client.js';
type SpawnManagedCodex = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type StartManagedThread = (input: StartCodexAppServerThreadInput, options?: CodexAppServerAdapterOptions) => Promise<CodexAppServerThread>;
export interface ManagedCodexHostConfig extends Record<string, unknown> {
    router_socket: unknown;
    token_file: unknown;
    project: unknown;
    principal_id: unknown;
    session_instance_id?: unknown;
    control_socket: unknown;
    workspace: unknown;
    codex_command?: unknown;
    startup_timeout_ms?: unknown;
}
export interface ManagedCodexHost {
    readonly thread_id: string;
    readonly session_instance_id: string;
    readonly process: ChildProcess;
    close(): Promise<void>;
}
export interface ManagedCodexHostDependencies {
    spawn?: SpawnManagedCodex;
    start_thread?: StartManagedThread;
    create_adapter?: typeof createCodexAppServerAdapter;
    connect_router_host?: typeof connectRouterHost;
    wait?: (milliseconds: number) => Promise<void>;
}
export declare function startManagedCodexHost(config: ManagedCodexHostConfig, dependencies?: ManagedCodexHostDependencies): Promise<ManagedCodexHost>;
export {};
//# sourceMappingURL=codex.d.ts.map