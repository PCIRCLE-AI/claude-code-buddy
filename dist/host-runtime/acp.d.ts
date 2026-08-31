#!/usr/bin/env node
import { type AcpClientOptions, type AcpSessionSelection, type AcpSessionUpdate } from '../host-adapters/acp-client.js';
export declare const ACP_SESSION_UPDATE_MAX_RECORD_BYTES: number;
export declare const ACP_SESSION_UPDATE_MAX_FILE_BYTES: number;
export declare const ACP_SESSION_UPDATE_MAX_RECORDS = 1024;
export interface AcpSessionUpdateSink {
    write: (update: AcpSessionUpdate) => void;
    close: () => void;
}
export interface RouterHostConnection {
    generation: string | number;
    close: () => void | Promise<void>;
}
export interface RouterDelivery {
    envelope: Record<string, unknown>;
    generation: string | number;
}
export type ConnectRouterHost = (options: {
    socket_path: string;
    auth_token: string;
    identity: {
        project: string;
        principal_id: string;
        session_instance_id: string;
        adapter_kind: 'acp';
        model?: string;
        work_summary?: string;
    };
    deliver: (delivery: RouterDelivery) => Promise<Record<string, unknown>>;
}) => Promise<RouterHostConnection>;
interface AcpHostAdapterHandle {
    readonly acp_session_id: string;
    close: () => Promise<void>;
}
type ConnectAcpHost = (options: AcpClientOptions) => Promise<AcpHostAdapterHandle>;
export interface ManagedAcpHostDependencies {
    connect_router_host: ConnectRouterHost;
    connect_acp_host?: ConnectAcpHost;
    create_session_instance_id?: () => string;
}
export interface ManagedAcpHostRuntime {
    readonly principal_id: string;
    readonly session_instance_id: string;
    readonly acp_session_id: string;
    close: () => Promise<void>;
}
export interface ManagedAcpLaunch {
    readonly command: string;
    readonly args: readonly string[];
    readonly principal_id: string;
    readonly session_instance_id: string;
    readonly workspace: string;
    readonly session: AcpSessionSelection;
}
export declare function createAcpSessionUpdateSink(configuredPath: unknown): AcpSessionUpdateSink | undefined;
export declare function resolveManagedAcpLaunch(config: Record<string, unknown>, createSessionInstanceId?: () => string): ManagedAcpLaunch;
export declare function startManagedAcpHost(config: Record<string, unknown>, dependencies: ManagedAcpHostDependencies): Promise<ManagedAcpHostRuntime>;
export {};
//# sourceMappingURL=acp.d.ts.map