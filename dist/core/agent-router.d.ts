import type { MemeshDatabase } from '../storage/sqlite.js';
import { type AgentJsonObject, type AgentMessagePayload, type AgentMessagePostCommitNotifier } from './agent-messaging.js';
export declare const AGENT_ROUTER_PROTOCOL_VERSION = 1;
export declare const AGENT_ROUTER_MAX_FRAME_BYTES: number;
export declare const AGENT_ROUTER_MAX_HOPS = 4;
export interface AgentHostRegistration {
    project: string;
    principal_id: string;
    session_instance_id: string;
    adapter_kind: string;
    auth_token?: string;
}
export interface AgentHostDispatchInput {
    dispatch_id: string;
    attempt_id: string;
    project: string;
    principal_id: string;
    session_instance_id: string;
    connection_id: string;
    generation: number;
    hops: number;
    untrusted_payload: true;
    envelope: AgentMessagePayload;
}
export interface AgentHostDispatchResult {
    accepted: boolean;
    receipt?: AgentJsonObject;
}
export interface AgentHostAdapter {
    readonly kind: string;
    authenticate(registration: AgentHostRegistration): boolean | Promise<boolean>;
    dispatch?(input: AgentHostDispatchInput): AgentHostDispatchResult | Promise<AgentHostDispatchResult>;
}
export interface AgentRouterLimits {
    max_frame_bytes?: number;
    max_hops?: number;
    max_frames_per_window?: number;
    rate_window_ms?: number;
    lease_ms?: number;
    drain_limit?: number;
    delivery_timeout_ms?: number;
}
export interface AgentRouterOptions {
    db: MemeshDatabase;
    socket_path: string;
    adapters: readonly AgentHostAdapter[];
    router_instance_id?: string;
    limits?: AgentRouterLimits;
}
export interface AgentRouterRegisterRequest {
    version: 1;
    type: 'register';
    request_id: string;
    project: string;
    principal_id: string;
    session_instance_id: string;
    adapter_kind: string;
    auth_token?: string;
    hops: number;
}
export interface AgentRouterNotifyRequest {
    version: 1;
    type: 'notify';
    request_id: string;
    project: string;
    delivery_id: string;
    hops: number;
}
export interface AgentRouterHeartbeatRequest {
    version: 1;
    type: 'heartbeat';
    request_id: string;
    project: string;
    session_instance_id: string;
    connection_id: string;
    generation: number;
    hops: number;
}
export interface AgentRouterDisconnectRequest {
    version: 1;
    type: 'disconnect';
    request_id: string;
    project: string;
    session_instance_id: string;
    connection_id: string;
    generation: number;
    hops: number;
}
export interface AgentRouterHostAcceptRequest {
    version: 1;
    type: 'host_accept';
    request_id: string;
    attempt_id: string;
    delivery_id: string;
    connection_id: string;
    generation: number;
    receipt: AgentJsonObject;
    hops: number;
}
export interface AgentRouterHostRejectRequest {
    version: 1;
    type: 'host_reject';
    request_id: string;
    attempt_id: string;
    delivery_id: string;
    connection_id: string;
    generation: number;
    failure_code: string;
    hops: number;
}
export type AgentRouterRequest = AgentRouterRegisterRequest | AgentRouterNotifyRequest | AgentRouterHeartbeatRequest | AgentRouterDisconnectRequest | AgentRouterHostAcceptRequest | AgentRouterHostRejectRequest;
export type AgentRouterSuccessResponse = {
    version: 1;
    request_id: string;
    ok: true;
    result: AgentJsonObject;
};
export type AgentRouterErrorResponse = {
    version: 1;
    request_id: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export type AgentRouterResponse = AgentRouterSuccessResponse | AgentRouterErrorResponse;
export declare class AgentRouterError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class AgentRouterStaleGenerationError extends AgentRouterError {
    constructor();
}
export declare class AgentRouterProtocolError extends AgentRouterError {
}
export declare class AgentRouter {
    readonly router_instance_id: string;
    readonly socket_path: string;
    private readonly db;
    private readonly adapters;
    private readonly limits;
    private server;
    private socketIdentity;
    private readonly sockets;
    private readonly externalConnections;
    private readonly inFlightDeliveries;
    private readonly pendingExternal;
    constructor(options: AgentRouterOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    private acceptSocket;
    private handleFrame;
    private handleRequest;
    private register;
    private bindExternalConnection;
    private disconnectSocket;
    private handleHostOutcome;
    private registerConnection;
    private requireCurrentConnection;
    private insertPresenceFact;
    private drainConnection;
    private dispatchDelivery;
    private dispatchDeliveryOnce;
    private dispatchExternal;
    private loadDelivery;
    private resolveConnection;
    private connectionMatchesDelivery;
    private beginDispatchAttempt;
    private finishAttempt;
    private writeError;
    private writeResponse;
}
export declare function createAgentRouterNotifier(socketPath: string): AgentMessagePostCommitNotifier;
export declare function sendAgentRouterRequest(socketPath: string, request: AgentRouterRequest, timeoutMs?: number): Promise<AgentJsonObject>;
//# sourceMappingURL=agent-router.d.ts.map