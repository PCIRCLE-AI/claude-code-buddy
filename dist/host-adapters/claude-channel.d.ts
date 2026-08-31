import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
export declare const CLAUDE_CHANNEL_CAPABILITIES: {
    readonly experimental: {
        readonly 'claude/channel': {};
    };
};
export declare const CLAUDE_CHANNEL_NOTIFICATION_METHOD: "notifications/claude/channel";
export interface ClaudeChannelNotification {
    method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
    params: {
        content: string;
        meta: Record<string, string>;
    };
}
export declare function createClaudeChannelServer(serverInfo: Implementation, instructions: string): Server;
//# sourceMappingURL=claude-channel.d.ts.map