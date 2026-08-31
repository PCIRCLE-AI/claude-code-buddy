import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MemeshDatabase } from '../storage/sqlite.js';
import {
  AgentMessageAccessError,
  AgentMessagingError,
  fetchAgentMessage,
  pollAgentEvents,
  readAgentMessageReceipts,
  recordAgentReceipt,
  sendAgentMessage,
  waitForAgentEvents,
  type AgentAckFact,
  type AgentJsonObject,
  type AgentMessagePostCommitNotifier,
  type AgentWorkflowFact,
} from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
import {
  createAgentRouterNotifier,
  sendAgentRouterRequest,
  type AgentRouterNotifyRequest,
  type AgentRouterDiscoverRequest,
} from '../core/agent-router.js';
import { getMemeshDirFromDbPath } from '../core/paths.js';

export type AgentMessageActionInput = z.infer<typeof MessageSchema>;

export interface AgentMessageTransportContext {
  transport: 'cli' | 'http' | 'mcp';
  sourceHost: string;
  signal?: AbortSignal;
}

export interface AgentMessageTransportDependencies {
  sendRouterRequest?: typeof sendAgentRouterRequest;
}

export class AgentRecipientUnavailableError extends AgentMessagingError {
  readonly code = 'recipient_unavailable';

  constructor() {
    super('recipient_unavailable: the exact active session did not accept the native message.');
  }
}

const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';
const EXACT_SESSION_NATIVE_TIMEOUT_MS = 12_000;
const PUBLIC_DISPOSITIONS = new Set(['accepted', 'rejected', 'completed', 'cancelled', 'deferred']);

type CanonicalDeliveryScope = {
  delivery_id: string;
  message_id: string;
  project: string;
  recipient: string;
};

type HostAcceptRow = {
  fact_order: number;
  host_accept_id: string;
  attempt_id: string;
  delivery_id: string;
  adapter_kind: string;
  receipt_json: string;
  created_at: string;
};

type AckFactRow = {
  fact_order: number;
  ack_fact_id: string;
  delivery_id: string;
  host_accept_id: string;
  actor: string;
  idempotency_key: string;
  detail_json: string;
  created_at: string;
};

type WorkflowFactRow = {
  fact_order: number;
  workflow_fact_id: string;
  delivery_id: string;
  actor: string;
  workflow_state: string;
  idempotency_key: string;
  detail_json: string;
  created_at: string;
};

type ProjectedFact = Record<string, unknown> & { created_at: string };

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

function routerSocketPath(): string {
  return process.env.MEMESH_ROUTER_SOCKET
    ?? path.join(getMemeshDirFromDbPath(), 'agent-router.sock');
}

function optionalRouterNotifier(): AgentMessagePostCommitNotifier | undefined {
  try {
    return createAgentRouterNotifier(routerSocketPath());
  } catch {
    // The message transaction is the source of truth. An unusable optional
    // hint path (including an overlong Unix-domain socket path in a nested
    // temporary HOME) must not prevent durable send; a running router also
    // drains committed deliveries when a host registers or reconnects.
    return undefined;
  }
}

function nativeAcceptance(row: HostAcceptRow): AgentJsonObject {
  return {
    status: 'native_accepted',
    delivery_id: row.delivery_id,
    adapter_kind: row.adapter_kind,
    receipt: parseStoredObject(row.receipt_json, 'agent_host_accepts.receipt_json'),
    accepted_at: row.created_at,
  };
}

async function requireExactSessionNativeAcceptance(
  db: MemeshDatabase,
  sent: { delivery_id: string; project: string },
  dependencies: AgentMessageTransportDependencies,
): Promise<AgentJsonObject> {
  const existing = readHostAccept(db, sent.delivery_id);
  if (existing) return nativeAcceptance(existing);

  const request: AgentRouterNotifyRequest = {
    version: 1,
    type: 'notify',
    request_id: randomUUID(),
    project: sent.project,
    delivery_id: sent.delivery_id,
    hops: 0,
  };
  try {
    const result = await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(
      routerSocketPath(),
      request,
      EXACT_SESSION_NATIVE_TIMEOUT_MS,
    );
    if (result.delivered !== true) {
      const accepted = readHostAccept(db, sent.delivery_id);
      if (accepted) return nativeAcceptance(accepted);
      throw new AgentRecipientUnavailableError();
    }
  } catch (error) {
    if (error instanceof AgentRecipientUnavailableError) throw error;
    throw new AgentRecipientUnavailableError();
  }

  const accepted = readHostAccept(db, sent.delivery_id);
  if (!accepted) throw new AgentRecipientUnavailableError();
  return nativeAcceptance(accepted);
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

function resolveCanonicalDelivery(
  db: MemeshDatabase,
  project: string,
  recipient: string,
  messageId: string,
): CanonicalDeliveryScope {
  const delivery = db.prepare(`
    SELECT delivery_id, message_id, project, recipient
    FROM agent_message_deliveries
    WHERE project = ? AND recipient = ? AND message_id = ?
  `).get(project, recipient, messageId) as CanonicalDeliveryScope | undefined;
  if (!delivery) {
    throw new AgentMessageAccessError(
      `Agent message ${messageId} is not available to recipient ${recipient} in project ${project}.`,
    );
  }
  return delivery;
}

function readHostAccept(db: MemeshDatabase, deliveryId: string): HostAcceptRow | undefined {
  return db.prepare(`
    SELECT rowid AS fact_order, host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json, created_at
    FROM agent_host_accepts
    WHERE delivery_id = ?
  `).get(deliveryId) as HostAcceptRow | undefined;
}

function recordPublicAck(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'ack' }>,
  context: AgentMessageTransportContext,
) {
  return recordAgentReceipt(db, {
    project: input.project,
    recipient: input.recipient,
    message_id: input.message_id,
    actor: input.recipient,
    idempotency_key: input.idempotency_key,
    receipt_kind: 'ack',
    detail: receiptDetail(undefined, context),
  });
}

function recordPublicWorkflow(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'disposition' }>,
  context: AgentMessageTransportContext,
) {
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
}

function readPublicReceipts(
  db: MemeshDatabase,
  input: Extract<AgentMessageActionInput, { action: 'receipts' }>,
): ProjectedFact[] {
  const delivery = resolveCanonicalDelivery(db, input.project, input.recipient, input.message_id);
  const projected: Array<{ fact: ProjectedFact; rank: number; order: number }> = [];

  const legacy = readAgentMessageReceipts(db, input);
  legacy.forEach((receipt, order) => projected.push({
    fact: { ...receipt, fact_source: 'agent_message_receipt' },
    rank: 1,
    order,
  }));

  const hostAccept = readHostAccept(db, delivery.delivery_id);
  if (hostAccept) {
    projected.push({ fact: projectHostAccept(delivery, hostAccept), rank: 0, order: hostAccept.fact_order });
  }

  const ackFacts = db.prepare(`
    SELECT rowid AS fact_order, ack_fact_id, delivery_id, host_accept_id, actor,
           idempotency_key, detail_json, created_at
    FROM agent_ack_facts
    WHERE delivery_id = ?
    ORDER BY rowid ASC
  `).all(delivery.delivery_id) as AckFactRow[];
  for (const row of ackFacts) {
    projected.push({
      fact: projectAckFact(delivery, {
        ack_fact_id: row.ack_fact_id,
        delivery_id: row.delivery_id,
        host_accept_id: row.host_accept_id,
        actor: row.actor,
        idempotency_key: row.idempotency_key,
        detail: parseStoredObject(row.detail_json, 'agent_ack_facts.detail_json'),
        created_at: row.created_at,
      }),
      rank: 2,
      order: row.fact_order,
    });
  }

  const workflowFacts = db.prepare(`
    SELECT rowid AS fact_order, workflow_fact_id, delivery_id, actor,
           workflow_state, idempotency_key, detail_json, created_at
    FROM agent_workflow_facts
    WHERE delivery_id = ?
    ORDER BY rowid ASC
  `).all(delivery.delivery_id) as WorkflowFactRow[];
  for (const row of workflowFacts) {
    projected.push({
      fact: projectWorkflowFact(delivery, {
        workflow_fact_id: row.workflow_fact_id,
        delivery_id: row.delivery_id,
        actor: row.actor,
        workflow_state: row.workflow_state,
        idempotency_key: row.idempotency_key,
        detail: parseStoredObject(row.detail_json, 'agent_workflow_facts.detail_json'),
        created_at: row.created_at,
      }),
      rank: 3,
      order: row.fact_order,
    });
  }

  return projected
    .sort((left, right) => left.fact.created_at.localeCompare(right.fact.created_at)
      || left.rank - right.rank
      || left.order - right.order)
    .map(({ fact }) => fact);
}

function projectHostAccept(delivery: CanonicalDeliveryScope, fact: HostAcceptRow): ProjectedFact {
  return {
    receipt_id: fact.host_accept_id,
    receipt_kind: 'host_accept',
    fact_source: 'agent_host_accept',
    message_id: delivery.message_id,
    project: delivery.project,
    recipient: delivery.recipient,
    delivery_id: fact.delivery_id,
    host_accept_id: fact.host_accept_id,
    attempt_id: fact.attempt_id,
    adapter_kind: fact.adapter_kind,
    receipt: parseStoredObject(fact.receipt_json, 'agent_host_accepts.receipt_json'),
    created_at: fact.created_at,
  };
}

function projectAckFact(delivery: CanonicalDeliveryScope, fact: AgentAckFact): ProjectedFact {
  return {
    receipt_id: fact.ack_fact_id,
    receipt_kind: 'ack',
    fact_source: 'agent_ack_fact',
    ack_fact_id: fact.ack_fact_id,
    message_id: delivery.message_id,
    project: delivery.project,
    recipient: delivery.recipient,
    delivery_id: fact.delivery_id,
    host_accept_id: fact.host_accept_id,
    actor: fact.actor,
    idempotency_key: fact.idempotency_key,
    detail: { acknowledged: true, detail: fact.detail },
    created_at: fact.created_at,
  };
}

function projectWorkflowFact(delivery: CanonicalDeliveryScope, fact: AgentWorkflowFact): ProjectedFact {
  const disposition = PUBLIC_DISPOSITIONS.has(fact.workflow_state) ? fact.workflow_state : undefined;
  return {
    receipt_id: fact.workflow_fact_id,
    receipt_kind: disposition ? 'disposition' : 'workflow',
    fact_source: 'agent_workflow_fact',
    workflow_fact_id: fact.workflow_fact_id,
    message_id: delivery.message_id,
    project: delivery.project,
    recipient: delivery.recipient,
    delivery_id: fact.delivery_id,
    actor: fact.actor,
    idempotency_key: fact.idempotency_key,
    workflow_state: fact.workflow_state,
    ...(disposition ? { disposition } : {}),
    detail: disposition
      ? { disposition, detail: fact.detail }
      : { workflow_state: fact.workflow_state, detail: fact.detail },
    created_at: fact.created_at,
  };
}

function parseStoredObject(raw: string, label: string): AgentJsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AgentJsonObject;
    }
  } catch {
    // Fall through to one stable storage-corruption error below.
  }
  throw new AgentMessagingError(`Invalid stored JSON object in ${label}.`);
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
  dependencies: AgentMessageTransportDependencies = {},
): Promise<unknown> {
  const input = MessageSchema.parse(rawInput);

  switch (input.action) {
    case 'send': {
      const sent = sendAgentMessage(db, {
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
        notifier: input.target_kind === 'session' ? undefined : optionalRouterNotifier(),
        storage_quota_bytes: configuredAgentMessageStorageQuotaBytes(),
      });
      if (sent.target_kind !== 'session') return sent;
      return {
        ...sent,
        native_delivery: await requireExactSessionNativeAcceptance(db, sent, dependencies),
      };
    }
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
    case 'discover': {
      const request: AgentRouterDiscoverRequest = {
        version: 1,
        type: 'discover',
        request_id: randomUUID(),
        project: input.project,
        limit: input.limit,
        hops: 0,
      };
      // Discovery is deliberately router-only: it neither reads nor writes
      // durable message state, and router failures remain explicit errors.
      return await (dependencies.sendRouterRequest ?? sendAgentRouterRequest)(
        routerSocketPath(),
        request,
      );
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
      return recordPublicAck(db, input, context);
    case 'disposition':
      return recordPublicWorkflow(db, input, context);
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
      return readPublicReceipts(db, input);
  }
}
