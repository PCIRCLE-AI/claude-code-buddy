import { Server } from '@modelcontextprotocol/sdk/server/index.js';
export const CLAUDE_CHANNEL_CAPABILITIES = {
    experimental: { 'claude/channel': {} },
};
export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
export function createClaudeChannelServer(serverInfo, instructions) {
    const options = {
        capabilities: CLAUDE_CHANNEL_CAPABILITIES,
        instructions,
    };
    return new Server(serverInfo, options);
}
//# sourceMappingURL=claude-channel.js.map