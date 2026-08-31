import { z } from 'zod';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { AgentMessagingError } from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import { sendAgentRouterRequest } from '../core/agent-router.js';
export type AgentMessageActionInput = z.infer<typeof MessageSchema>;
export interface AgentMessageTransportContext {
    transport: 'cli' | 'http' | 'mcp';
    sourceHost: string;
    signal?: AbortSignal;
}
export interface AgentMessageTransportDependencies {
    sendRouterRequest?: typeof sendAgentRouterRequest;
}
export declare class AgentRecipientUnavailableError extends AgentMessagingError {
    readonly code = "recipient_unavailable";
    constructor();
}
export declare function executeAgentMessageAction(db: MemeshDatabase, rawInput: unknown, context: AgentMessageTransportContext, dependencies?: AgentMessageTransportDependencies): Promise<unknown>;
//# sourceMappingURL=agent-messaging.d.ts.map