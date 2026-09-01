import { Server, type ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

/** The only Claude Code experimental capability this one-way host needs. */
export const CLAUDE_CHANNEL_CAPABILITIES = {
  experimental: { 'claude/channel': {} },
} as const;

export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel' as const;

export interface ClaudeChannelNotification {
  method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
  params: {
    content: string;
    meta: Record<string, string>;
  };
}

/** Build the one-way Claude channel server used by the managed host runtime. */
export function createClaudeChannelServer(
  serverInfo: Implementation,
  instructions: string,
): Server {
  const options: ServerOptions = {
    capabilities: CLAUDE_CHANNEL_CAPABILITIES,
    instructions,
  };
  return new Server(serverInfo, options);
}
