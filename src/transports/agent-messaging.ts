import { z } from 'zod';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  fetchAgentMessage,
  pollAgentEvents,
  readAgentMessageReceipts,
  recordAgentReceipt,
  sendAgentMessage,
  waitForAgentEvents,
  type AgentJsonObject,
  type AgentMessagePostCommitNotifier,
} from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import { createAgentRouterNotifier } from '../core/agent-router.js';
import { getMemeshDirFromDbPath } from '../core/paths.js';
import path from 'node:path';

export type AgentMessageActionInput = z.infer<typeof MessageSchema>;

export interface AgentMessageTransportContext {
  transport: 'cli' | 'http' | 'mcp';
  sourceHost: string;
  signal?: AbortSignal;
}

const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';

function configuredAgentMessageStorageQuotaBytes(): number | undefined {
  const raw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
  if (raw === undefined || raw === '') return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} must be a non-negative integer byte count.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${AGENT_MESSAGE_STORAGE_QUOTA_ENV} exceeds the safe integer range.`);
  }
  return parsed;
}

function optionalRouterNotifier(): AgentMessagePostCommitNotifier | undefined {
  try {
    return createAgentRouterNotifier(
      process.env.MEMESH_ROUTER_SOCKET
        ?? path.join(getMemeshDirFromDbPath(), 'agent-router.sock'),
    );
  } catch {
    // The message transaction is the source of truth. An unusable optional
    // hint path (including an overlong Unix-domain socket path in a nested
    // temporary HOME) must not prevent durable send; a running router also
    // drains committed deliveries when a host registers or reconnects.
    return undefined;
  }
}

function receiptDetail(
  note: string | undefined,
  context: AgentMessageTransportContext,
): AgentJsonObject {
  return {
    transport: context.transport,
    source_host: context.sourceHost,
    ...(note ? { note } : {}),
  };
}

/**
 * One transport-neutral dispatcher for the public message lifecycle.
 *
 * The Zod union owns conditional fields for MCP, HTTP, and CLI alike.  Host
 * provenance and receipt actors are derived at the trusted adapter boundary;
 * model-provided payload data cannot spoof them.  Read actions deliberately
 * do not write intake or acknowledgement receipts.
 */
export async function executeAgentMessageAction(
  db: MemeshDatabase,
  rawInput: unknown,
  context: AgentMessageTransportContext,
): Promise<unknown> {
  const input = MessageSchema.parse(rawInput);

  switch (input.action) {
    case 'send':
      return sendAgentMessage(db, {
        project: input.project,
        sender: input.sender,
        sender_host: context.sourceHost,
        recipient: input.recipient,
        target_kind: input.target_kind,
        idempotency_key: input.idempotency_key,
        payload: input.payload,
        content_type: input.content_type,
        privacy: input.privacy,
        correlation_id: input.correlation_id,
        reply_to: input.reply_to,
        provenance: {
          transport: context.transport,
          source_host: context.sourceHost,
        },
      }, {
        notifier: optionalRouterNotifier(),
        storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
      });
    case 'poll': {
      const query = {
        project: input.project,
        recipient: input.recipient,
        cursor: input.cursor,
        limit: input.limit,
      };
      return input.wait_ms > 0
        ? waitForAgentEvents(db, { ...query, wait_ms: input.wait_ms }, context.signal)
        : pollAgentEvents(db, query);
    }
    case 'fetch':
      return fetchAgentMessage(db, input);
    case 'intake':
      return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'intake',
        intake_state: input.intake_state,
        detail: receiptDetail(undefined, context),
      });
    case 'ack':
      return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'ack',
        detail: receiptDetail(undefined, context),
      });
    case 'disposition':
      return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'disposition',
        disposition: input.disposition,
        detail: receiptDetail(input.detail, context),
      });
    case 'activation':
      return recordAgentReceipt(db, {
        project: input.project,
        recipient: input.recipient,
        message_id: input.message_id,
        actor: input.recipient,
        idempotency_key: input.idempotency_key,
        receipt_kind: 'host_activation',
        host_activation: input.activation,
        detail: receiptDetail(input.detail, context),
      });
    case 'receipts':
      return readAgentMessageReceipts(db, input);
  }
}
