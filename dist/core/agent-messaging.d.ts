import type { MemeshDatabase } from '../storage/sqlite.js';
export type AgentJsonPrimitive = boolean | null | number | string;
export type AgentJsonValue = AgentJsonPrimitive | AgentJsonValue[] | {
    [key: string]: AgentJsonValue;
};
export type AgentJsonObject = {
    [key: string]: AgentJsonValue;
};
export type AgentMessagePrivacy = 'private' | 'team';
export type AgentContentType = 'text/plain' | 'application/json';
export type AgentTargetKind = 'principal' | 'session';
export type AgentReceiptKind = 'intake' | 'ack' | 'disposition' | 'host_activation';
export type AgentIntakeState = 'fetched' | 'ingested';
export type AgentDisposition = 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'deferred';
export type AgentHostActivation = 'woken' | 'manual_resume_required' | 'unsupported' | 'failed';
export interface SendAgentMessageInput {
    project: string;
    sender: string;
    recipient: string;
    target_kind?: AgentTargetKind;
    idempotency_key: string;
    payload: AgentJsonValue;
    content_type: AgentContentType;
    sender_host?: string | null;
    correlation_id?: string | null;
    reply_to?: string | null;
    privacy?: AgentMessagePrivacy;
    provenance?: AgentJsonObject;
}
export interface SentAgentMessage {
    message_id: string;
    delivery_id: string;
    event_id: string;
    project: string;
    sender: string;
    sender_host: string | null;
    recipient: string;
    target_kind: AgentTargetKind;
    content_type: AgentContentType;
    correlation_id: string | null;
    reply_to: string | null;
    privacy: AgentMessagePrivacy;
    created_at: string;
    provenance: AgentJsonObject;
}
export interface AgentMessagePostCommitHint {
    delivery_id: string;
    event_id: string;
    project: string;
    target_kind: AgentTargetKind;
    target_id: string;
}
export interface AgentMessagePostCommitNotifier {
    notify(hint: AgentMessagePostCommitHint): void | Promise<void>;
}
export interface SendAgentMessageOptions {
    notifier?: AgentMessagePostCommitNotifier;
    storage_quota_bytes?: number;
}
export interface PollAgentEventsInput {
    project: string;
    recipient: string;
    cursor?: string | null;
    limit?: number;
}
export interface AgentMessageEventHeader {
    event_id: string;
    message_id: string;
    sender: string;
    sender_host: string | null;
    recipient: string;
    target_kind: AgentTargetKind;
    content_type: AgentContentType;
    correlation_id: string | null;
    reply_to: string | null;
    privacy: AgentMessagePrivacy;
    created_at: string;
}
export interface PollAgentEventsResult {
    events: AgentMessageEventHeader[];
    next_cursor: string;
}
export interface WaitForAgentEventsInput extends PollAgentEventsInput {
    wait_ms?: number;
    poll_interval_ms?: number;
}
export interface FetchAgentMessageInput {
    project: string;
    recipient: string;
    message_id: string;
    target_kind?: AgentTargetKind;
}
export interface AgentMessagePayload {
    message_id: string;
    project: string;
    sender: string;
    sender_host: string | null;
    recipient: string;
    target_kind: AgentTargetKind;
    content_type: AgentContentType;
    correlation_id: string | null;
    reply_to: string | null;
    privacy: AgentMessagePrivacy;
    created_at: string;
    payload: AgentJsonValue;
    provenance: AgentJsonObject;
}
interface AgentReceiptBase {
    project: string;
    recipient: string;
    message_id: string;
    actor: string;
    idempotency_key: string;
    detail?: AgentJsonObject;
}
export type RecordAgentReceiptInput = (AgentReceiptBase & {
    receipt_kind: 'intake';
    intake_state: AgentIntakeState;
}) | (AgentReceiptBase & {
    receipt_kind: 'ack';
}) | (AgentReceiptBase & {
    receipt_kind: 'disposition';
    disposition: AgentDisposition;
}) | (AgentReceiptBase & {
    receipt_kind: 'host_activation';
    host_activation: AgentHostActivation;
});
interface AgentReceiptRowBase {
    receipt_id: string;
    message_id: string;
    project: string;
    recipient: string;
    actor: string;
    idempotency_key: string;
    created_at: string;
}
export type AgentMessageReceipt = (AgentReceiptRowBase & {
    receipt_kind: 'intake';
    intake_state: AgentIntakeState;
    detail: AgentJsonObject;
}) | (AgentReceiptRowBase & {
    receipt_kind: 'ack';
    detail: AgentJsonObject;
}) | (AgentReceiptRowBase & {
    receipt_kind: 'disposition';
    disposition: AgentDisposition;
    detail: AgentJsonObject;
}) | (AgentReceiptRowBase & {
    receipt_kind: 'host_activation';
    host_activation: AgentHostActivation;
    detail: AgentJsonObject;
});
export interface ReadAgentMessageReceiptsInput {
    project: string;
    recipient: string;
    message_id: string;
}
export interface RecordAgentAckFactInput {
    delivery_id: string;
    host_accept_id: string;
    actor: string;
    idempotency_key: string;
    detail?: AgentJsonObject;
}
export interface AgentAckFact {
    ack_fact_id: string;
    delivery_id: string;
    host_accept_id: string;
    actor: string;
    idempotency_key: string;
    detail: AgentJsonObject;
    created_at: string;
}
export interface RecordAgentWorkflowFactInput {
    delivery_id: string;
    actor: string;
    workflow_state: string;
    idempotency_key: string;
    detail?: AgentJsonObject;
}
export interface AgentWorkflowFact {
    workflow_fact_id: string;
    delivery_id: string;
    actor: string;
    workflow_state: string;
    idempotency_key: string;
    detail: AgentJsonObject;
    created_at: string;
}
export interface RecordAgentRetentionFactInput {
    message_id: string;
    actor: string;
    retention_state: string;
    idempotency_key: string;
    detail?: AgentJsonObject;
}
export interface AgentRetentionFact {
    retention_fact_id: string;
    message_id: string;
    actor: string;
    retention_state: string;
    idempotency_key: string;
    detail: AgentJsonObject;
    created_at: string;
}
export declare class AgentMessagingError extends Error {
}
export declare class AgentIdempotencyConflictError extends AgentMessagingError {
}
export declare class AgentMessageAccessError extends AgentMessagingError {
}
export declare class AgentWaitAbortedError extends AgentMessagingError {
}
export declare function sendAgentMessage(db: MemeshDatabase, input: SendAgentMessageInput, options?: SendAgentMessageOptions): SentAgentMessage;
export declare function pollAgentEvents(db: MemeshDatabase, input: PollAgentEventsInput): PollAgentEventsResult;
export declare function waitForAgentEvents(db: MemeshDatabase, input: WaitForAgentEventsInput, signal?: AbortSignal): Promise<PollAgentEventsResult>;
export declare function fetchAgentMessage(db: MemeshDatabase, input: FetchAgentMessageInput): AgentMessagePayload;
export declare function recordAgentReceipt(db: MemeshDatabase, input: RecordAgentReceiptInput): AgentMessageReceipt;
export declare function readAgentMessageReceipts(db: MemeshDatabase, input: ReadAgentMessageReceiptsInput): AgentMessageReceipt[];
export declare function recordAgentAckFact(db: MemeshDatabase, input: RecordAgentAckFactInput): AgentAckFact;
export declare function recordAgentWorkflowFact(db: MemeshDatabase, input: RecordAgentWorkflowFactInput): AgentWorkflowFact;
export declare function recordAgentRetentionFact(db: MemeshDatabase, input: RecordAgentRetentionFactInput): AgentRetentionFact;
export {};
//# sourceMappingURL=agent-messaging.d.ts.map