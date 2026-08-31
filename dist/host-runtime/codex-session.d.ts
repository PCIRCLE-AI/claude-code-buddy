#!/usr/bin/env node
import fs from 'node:fs';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';
export interface CodexSessionHostConfig extends Record<string, unknown> {
    router_socket: unknown;
    token_file: unknown;
    project: unknown;
    principal_id: unknown;
    workspace: unknown;
}
export interface CodexSessionStartInput {
    hook_event_name?: unknown;
    session_id?: unknown;
    cwd?: unknown;
    source?: unknown;
}
export interface CodexSessionCompanionDependencies {
    connect?: typeof connectRouterHost;
    realpath?: typeof fs.realpathSync;
}
export declare function startCodexSessionCompanion(config: CodexSessionHostConfig, hookInput: CodexSessionStartInput, environment: {
    PLUGIN_ROOT?: string;
}, dependencies?: CodexSessionCompanionDependencies): Promise<RouterHostConnection | null>;
//# sourceMappingURL=codex-session.d.ts.map