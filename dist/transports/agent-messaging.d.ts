import { z } from 'zod';
import type { MemeshDatabase } from '../storage/sqlite.js';
import { MessageSchema } from './schemas.js';
export type AgentMessageActionInput = z.infer<typeof MessageSchema>;
export interface AgentMessageTransportContext {
    transport: 'cli' | 'http' | 'mcp';
    sourceHost: string;
    signal?: AbortSignal;
}
export declare function executeAgentMessageAction(db: MemeshDatabase, rawInput: unknown, context: AgentMessageTransportContext): Promise<unknown>;
//# sourceMappingURL=agent-messaging.d.ts.map