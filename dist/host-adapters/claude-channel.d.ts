import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
export declare const CLAUDE_CHANNEL_CAPABILITIES: {
    readonly experimental: {
        readonly 'claude/channel': {};
    };
};
export declare const CLAUDE_CHANNEL_NOTIFICATION_METHOD: "notifications/claude/channel";
export interface ClaudeChannelIdentity {
    principal: string;
    sessionInstance: string;
    generation: string;
    workspace: string;
}
export interface ClaudeChannelNotification {
    method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
    params: {
        content: string;
        meta: Record<string, string>;
    };
}
export interface ClaudeChannelNotifier {
    notification(notification: ClaudeChannelNotification): Promise<void>;
}
export interface ClaudeChannelRouterSocket {
    write(data: string): boolean;
    on(event: 'data', listener: (chunk: Buffer | string) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    destroy(): void;
}
export interface ClaudeChannelRouterConnector {
    connect(socketPath: string): Promise<ClaudeChannelRouterSocket>;
}
export interface ClaudeChannelDelivery {
    type: 'deliver';
    sender: string;
    target: ClaudeChannelIdentity;
    content: string;
    meta?: Record<string, unknown>;
}
export interface ClaudeChannelAdapterOptions {
    routerSocketPath: string;
    trustedRouterPrincipal: string;
    identity: ClaudeChannelIdentity;
    notifier: ClaudeChannelNotifier;
    connector?: ClaudeChannelRouterConnector;
    maxFrameBytes?: number;
    maxContentBytes?: number;
    maxMetaEntries?: number;
    maxMetaValueBytes?: number;
    maxQueueItems?: number;
    maxQueueBytes?: number;
}
export interface ClaudeChannelAdapter {
    connect(): Promise<void>;
    disconnect(): void;
    setBusy(busy: boolean): Promise<void>;
    acceptRouterFrame(frame: unknown): Promise<boolean>;
    readonly active: boolean;
}
interface Limits {
    frameBytes: number;
    contentBytes: number;
    metaEntries: number;
    metaValueBytes: number;
    queueItems: number;
    queueBytes: number;
}
export declare function createClaudeChannelServer(serverInfo: Implementation, instructions: string): Server;
export declare function createClaudeChannelAdapter(options: ClaudeChannelAdapterOptions): ClaudeChannelAdapter;
export declare function sanitizeClaudeChannelMeta(meta: Record<string, unknown> | undefined, limits?: Pick<Limits, 'metaEntries' | 'metaValueBytes'>): Record<string, string>;
export declare function assertPrivateLocalRouterSocket(socketPath: string): void;
export {};
//# sourceMappingURL=claude-channel.d.ts.map