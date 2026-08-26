import { type RawData } from 'ws';
export interface CodexQueueRoutingMetadata {
    project: string;
    sender: string;
    recipient: string;
    message_id: string;
    delivery_id?: string;
    correlation_id?: string | null;
}
export interface QueueCodexAppServerMessageInput {
    control_socket_path: string;
    thread_id: string;
    routing: CodexQueueRoutingMetadata;
    envelope: unknown;
    timeout_ms?: number;
}
export interface StartCodexAppServerThreadInput {
    control_socket_path: string;
    workspace: string;
    timeout_ms?: number;
}
export interface CodexAppServerThread {
    thread_id: string;
}
export interface CodexQueueReceipt {
    host: 'codex-app-server';
    status: 'queued';
    thread_id: string;
    client_user_message_id: string;
    queued_submission_id: string;
}
export declare class CodexAppServerAdapterError extends Error {
    constructor(message: string);
}
export declare class CodexAppServerThreadUnavailableError extends CodexAppServerAdapterError {
    constructor();
}
export declare class CodexAppServerTimeoutError extends CodexAppServerAdapterError {
    constructor();
}
export declare class CodexAppServerDisconnectedError extends CodexAppServerAdapterError {
    constructor();
}
export declare class CodexAppServerPayloadTooLargeError extends CodexAppServerAdapterError {
    constructor();
}
export declare class CodexAppServerProtocolError extends CodexAppServerAdapterError {
    constructor();
}
export declare class CodexAppServerRejectedError extends CodexAppServerAdapterError {
    readonly code: number | string | null;
    constructor(code: number | string | null);
}
export interface CodexAppServerAdapterOptions {
    websocket_factory?: CodexWebSocketFactory;
    request_id?: () => string;
    timeout_ms?: number;
    client_info?: {
        name: string;
        version: string;
    };
}
export interface CodexWebSocketLike {
    readonly readyState: number;
    on(event: 'open', listener: () => void): this;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    off(event: 'open', listener: () => void): this;
    off(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    off(event: 'error', listener: (error: Error) => void): this;
    off(event: 'close', listener: () => void): this;
    send(data: string, callback?: (error?: Error) => void): void;
    close(): void;
    terminate(): void;
}
export type CodexWebSocketFactory = (socketPath: string, handshakeTimeoutMs: number) => CodexWebSocketLike;
export declare function createCodexAppServerAdapter(options?: CodexAppServerAdapterOptions): {
    queue(input: QueueCodexAppServerMessageInput): Promise<CodexQueueReceipt>;
};
export declare function queueCodexAppServerMessage(input: QueueCodexAppServerMessageInput, options?: CodexAppServerAdapterOptions): Promise<CodexQueueReceipt>;
export declare function startCodexAppServerThread(input: StartCodexAppServerThreadInput, options?: CodexAppServerAdapterOptions): Promise<CodexAppServerThread>;
//# sourceMappingURL=codex-app-server.d.ts.map