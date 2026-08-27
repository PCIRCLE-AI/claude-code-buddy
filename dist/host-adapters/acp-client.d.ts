export type AcpJsonPrimitive = boolean | null | number | string;
export type AcpJsonValue = AcpJsonPrimitive | AcpJsonValue[] | {
    [key: string]: AcpJsonValue;
};
export type AcpGeneration = number | string;
export interface AcpHostIdentity {
    principal_id: string;
    session_instance_id: string;
    generation: AcpGeneration;
    workspace: string;
}
export interface AcpRouterDelivery {
    envelope: AcpJsonValue;
    generation: AcpGeneration;
    signal?: AbortSignal;
}
export interface AcpDeliveryResult {
    host: 'acp';
    acp_session_id: string;
    accepted: boolean;
    stop_reason: AcpStopReason;
}
export interface AcpRouterRegistration extends AcpHostIdentity {
    host: 'acp';
    acp_session_id: string;
    deliver: (delivery: AcpRouterDelivery) => Promise<AcpDeliveryResult>;
    cancel: () => void;
}
export interface AcpRouterRegistrar {
    register(registration: AcpRouterRegistration): Promise<void | (() => void | Promise<void>) | AcpRouterConnection> | void | (() => void | Promise<void>) | AcpRouterConnection;
}
export interface AcpRouterConnection {
    generation: AcpGeneration;
    unregister?: () => void | Promise<void>;
}
export type AcpSessionSelection = {
    kind: 'new';
} | {
    kind: 'load';
    acp_session_id: string;
};
export interface AcpAgentCapabilities {
    load_session: boolean;
    prompt: {
        audio: boolean;
        embedded_context: boolean;
        image: boolean;
        text: true;
    };
}
export interface AcpAgentInfo {
    name: string;
    title: string | null;
    version: string;
}
export interface AcpSessionUpdate {
    sessionId: string;
    update: Record<string, unknown>;
}
export interface AcpClientOptions extends AcpHostIdentity {
    command: string;
    args?: readonly string[];
    session?: AcpSessionSelection;
    router: AcpRouterRegistrar;
    onSessionUpdate?: (update: AcpSessionUpdate) => void;
    initialize_timeout_ms?: number;
    session_timeout_ms?: number;
    prompt_timeout_ms?: number;
    cancel_grace_ms?: number;
    shutdown_grace_ms?: number;
    max_envelope_bytes?: number;
    max_frame_bytes?: number;
    max_queue_depth?: number;
}
export type AcpStopReason = 'cancelled' | 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal';
export declare class AcpHostAdapterError extends Error {
}
export declare class AcpProtocolError extends AcpHostAdapterError {
}
export declare class AcpUnsupportedCapabilityError extends AcpHostAdapterError {
}
export declare class AcpStaleGenerationError extends AcpHostAdapterError {
}
export declare class AcpBusyError extends AcpHostAdapterError {
}
export declare class AcpCancelledError extends AcpHostAdapterError {
}
export declare class AcpTimeoutError extends AcpHostAdapterError {
}
export declare class AcpProcessExitError extends AcpHostAdapterError {
}
export declare class AcpRemoteError extends AcpHostAdapterError {
    readonly method: string;
    readonly code: number;
    constructor(method: string, code: number);
}
export declare class AcpClientHostAdapter {
    readonly identity: Readonly<AcpHostIdentity>;
    readonly capabilities: Readonly<AcpAgentCapabilities>;
    readonly agent_info: Readonly<AcpAgentInfo> | null;
    readonly acp_session_id: string;
    private readonly child;
    private readonly router;
    private readonly onSessionUpdate?;
    private readonly maxEnvelopeBytes;
    private readonly maxFrameBytes;
    private readonly maxQueueDepth;
    private readonly promptTimeoutMs;
    private readonly cancelGraceMs;
    private readonly shutdownGraceMs;
    private readonly pending;
    private readonly queue;
    private stdoutBuffer;
    private nextRequestId;
    private active;
    private terminalError;
    private unregister;
    private routerGeneration;
    private unregisterStarted;
    private closing;
    private exited;
    private constructor();
    static connect(input: AcpClientOptions): Promise<AcpClientHostAdapter>;
    deliver(delivery: AcpRouterDelivery): Promise<AcpDeliveryResult>;
    cancel(): void;
    close(): Promise<void>;
    private registerWithRouter;
    private unregisterFromRouter;
    private abortDelivery;
    private pumpQueue;
    private runDelivery;
    private request;
    private sendNotification;
    private writeFrame;
    private acceptStdout;
    private handleMessage;
    private handleResponse;
    private handleAgentRequest;
    private handleAgentNotification;
    private handleExit;
    private fail;
    private rejectPending;
    private rejectQueued;
    private removeAbortListener;
    private attachProcess;
}
//# sourceMappingURL=acp-client.d.ts.map