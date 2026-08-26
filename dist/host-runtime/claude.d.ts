#!/usr/bin/env node
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type ConnectRouterHostInput, type RouterHostConnection } from './router-client.js';
type ClaudeChannelServer = Pick<Server, 'connect' | 'close' | 'notification'> & {
    oninitialized?: () => void;
    onclose?: () => void;
};
type SessionPhase = 'starting' | 'registering' | 'registered' | 'closing' | 'closed';
type SignalName = 'SIGINT' | 'SIGTERM';
interface LifecycleBindings {
    addSignal(signal: SignalName, listener: () => void): void;
    removeSignal(signal: SignalName, listener: () => void): void;
    addInputClose(event: 'end' | 'close', listener: () => void): void;
    removeInputClose(event: 'end' | 'close', listener: () => void): void;
}
export interface ClaudeManagedSessionConfig {
    server_name: string;
    router_socket: string;
    auth_token: string;
    project: string;
    principal_id: string;
    session_instance_id?: string;
}
export interface ClaudeManagedSessionDependencies {
    server?: ClaudeChannelServer;
    transport?: Transport;
    connect_router?: (input: ConnectRouterHostInput) => Promise<RouterHostConnection>;
    generate_session_id?: () => string;
    lifecycle?: LifecycleBindings;
    on_fatal_error?: (error: unknown) => void;
}
export interface ClaudeManagedSession {
    readonly session_instance_id: string;
    readonly phase: SessionPhase;
    readonly registered: Promise<RouterHostConnection>;
    close(): Promise<void>;
}
export declare function startClaudeManagedSession(config: ClaudeManagedSessionConfig, dependencies?: ClaudeManagedSessionDependencies): Promise<ClaudeManagedSession>;
export {};
//# sourceMappingURL=claude.d.ts.map