import { createHash, randomBytes, randomUUID } from 'node:crypto';
const MAX_SCOPE_FIELD = 200;
const MAX_IDEMPOTENCY_KEY = 200;
const MAX_CURSOR_TOKEN = 160;
const MAX_JSON_BYTES = 64 * 1024;
const DEFAULT_POLL_LIMIT = 50;
const MAX_POLL_LIMIT = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 100;
const MIN_WAIT_INTERVAL_MS = 10;
export class AgentMessagingError extends Error {
}
export class AgentIdempotencyConflictError extends AgentMessagingError {
}
export class AgentMessageAccessError extends AgentMessagingError {
}
export class AgentWaitAbortedError extends AgentMessagingError {
}
export function sendAgentMessage(db, input, options = {}) {
    const normalized = normalizeSendInput(input);
    const requestHash = hashCanonical({
        project: normalized.project,
        sender: normalized.sender,
        recipient: normalized.recipient,
        target_kind: normalized.target_kind,
        idempotency_key: normalized.idempotency_key,
        content_type: normalized.content_type,
        sender_host: normalized.sender_host,
        correlation_id: normalized.correlation_id,
        reply_to: normalized.reply_to,
        privacy: normalized.privacy,
        payload: normalized.payload,
        provenance: normalized.provenance,
    });
    const existing = lookupExistingMessage(db, normalized.project, normalized.sender, normalized.idempotency_key);
    if (existing) {
        if (existing.request_hash !== requestHash) {
            throw new AgentIdempotencyConflictError(`Agent message idempotency conflict for sender ${normalized.sender} in project ${normalized.project}.`);
        }
        return finishSentMessage(existing, options);
    }
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const tx = db.transaction(() => {
        db.prepare(`
      INSERT INTO agent_messages (
        message_id, project, sender, sender_host, recipient, content_type,
        correlation_id, reply_to_message_id, privacy, payload_json, provenance_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, normalized.project, normalized.sender, normalized.sender_host, normalized.recipient, normalized.content_type, normalized.correlation_id, normalized.reply_to, normalized.privacy, stableStringify(normalized.payload), stableStringify(normalized.provenance));
        db.prepare(`
      INSERT INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind)
      VALUES (?, ?, ?, ?, ?)
    `).run(deliveryId, messageId, normalized.project, normalized.recipient, normalized.target_kind);
        db.prepare(`
      INSERT INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind)
      VALUES (?, ?, ?, ?, ?, 'message_available')
    `).run(eventId, messageId, deliveryId, normalized.project, normalized.recipient);
        db.prepare(`
      INSERT INTO agent_message_idempotency (project, sender, idempotency_key, request_hash, message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(normalized.project, normalized.sender, normalized.idempotency_key, requestHash, messageId);
    });
    try {
        tx.immediate();
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = lookupExistingMessage(db, normalized.project, normalized.sender, normalized.idempotency_key);
        if (raced && raced.request_hash === requestHash)
            return finishSentMessage(raced, options);
        if (raced) {
            throw new AgentIdempotencyConflictError(`Agent message idempotency conflict for sender ${normalized.sender} in project ${normalized.project}.`);
        }
        throw error;
    }
    const stored = loadSentMessage(db, normalized.project, normalized.recipient, messageId);
    if (!stored)
        throw new AgentMessagingError(`Sent agent message ${messageId} could not be read back.`);
    return finishSentMessage(stored, options);
}
export function pollAgentEvents(db, input) {
    const project = requireText('project', input.project, MAX_SCOPE_FIELD);
    const recipient = requireText('recipient', input.recipient, MAX_SCOPE_FIELD);
    const limit = normalizeLimit(input.limit);
    const cursor = resolveCursor(db, project, recipient, input.cursor ?? null);
    const rows = db.prepare(`
    SELECT
      e.event_sequence,
      e.event_id,
      e.message_id,
      m.sender,
      m.sender_host,
      e.recipient,
      d.target_kind,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      e.created_at
    FROM agent_message_events e
    JOIN agent_messages m ON m.message_id = e.message_id
    JOIN agent_message_deliveries d ON d.delivery_id = e.delivery_id
    WHERE e.project = ? AND e.recipient = ? AND e.event_sequence > ?
    ORDER BY e.event_sequence ASC
    LIMIT ?
  `).all(project, recipient, cursor.event_sequence, limit);
    if (rows.length === 0) {
        if (cursor.cursor_token)
            return { events: [], next_cursor: cursor.cursor_token };
        return { events: [], next_cursor: createCursor(db, project, recipient, cursor.event_sequence) };
    }
    const nextCursor = createCursor(db, project, recipient, rows[rows.length - 1].event_sequence);
    return {
        events: rows.map(rowToEventHeader),
        next_cursor: nextCursor,
    };
}
export async function waitForAgentEvents(db, input, signal) {
    const timeoutMs = normalizeTimeout(input.wait_ms);
    const pollIntervalMs = normalizePollInterval(input.poll_interval_ms);
    const deadline = Date.now() + timeoutMs;
    let currentCursor = input.cursor ?? null;
    for (;;) {
        throwIfAborted(signal);
        const result = pollAgentEvents(db, {
            project: input.project,
            recipient: input.recipient,
            cursor: currentCursor,
            limit: input.limit,
        });
        if (result.events.length > 0)
            return result;
        currentCursor = result.next_cursor;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return result;
        await waitForDelay(Math.min(pollIntervalMs, remaining), signal);
    }
}
export function fetchAgentMessage(db, input) {
    const project = requireText('project', input.project, MAX_SCOPE_FIELD);
    const recipient = requireText('recipient', input.recipient, MAX_SCOPE_FIELD);
    const messageId = requireText('message_id', input.message_id, MAX_SCOPE_FIELD);
    const targetKind = parseTargetKind(input.target_kind ?? 'principal');
    const row = db.prepare(`
    SELECT
      m.message_id,
      m.project,
      m.sender,
      m.sender_host,
      d.recipient,
      d.target_kind,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      m.payload_json,
      m.provenance_json,
      m.created_at
    FROM agent_messages m
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    WHERE m.project = ? AND d.project = ? AND d.recipient = ? AND d.target_kind = ? AND m.message_id = ?
  `).get(project, project, recipient, targetKind, messageId);
    if (!row) {
        throw new AgentMessageAccessError(`Agent message ${messageId} is not available to recipient ${recipient} in project ${project}.`);
    }
    return {
        message_id: row.message_id,
        project: row.project,
        sender: row.sender,
        sender_host: row.sender_host,
        recipient: row.recipient,
        target_kind: parseTargetKind(row.target_kind),
        content_type: parseContentType(row.content_type),
        correlation_id: row.correlation_id,
        reply_to: row.reply_to_message_id,
        privacy: parsePrivacy(row.privacy),
        created_at: row.created_at,
        payload: parseJsonObjectOrValue(row.payload_json),
        provenance: parseJsonObject(row.provenance_json, 'provenance_json'),
    };
}
export function recordAgentReceipt(db, input) {
    const normalized = normalizeReceiptInput(input);
    assertMessageAccess(db, normalized.project, normalized.recipient, normalized.message_id);
    const detail = buildReceiptDetail(normalized);
    const requestHash = hashCanonical({
        message_id: normalized.message_id,
        receipt_kind: normalized.receipt_kind,
        actor: normalized.actor,
        detail,
    });
    const existing = lookupExistingReceipt(db, normalized.project, normalized.recipient, normalized.message_id, normalized.receipt_kind, normalized.idempotency_key);
    if (existing) {
        if (existing.request_hash !== requestHash) {
            throw new AgentIdempotencyConflictError(`Agent receipt idempotency conflict for message ${normalized.message_id} (${normalized.receipt_kind}).`);
        }
        return rowToReceipt(existing);
    }
    const receiptId = randomUUID();
    const tx = db.transaction(() => {
        db.prepare(`
      INSERT INTO agent_message_receipts (
        receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, request_hash, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(receiptId, normalized.message_id, normalized.project, normalized.recipient, normalized.receipt_kind, normalized.actor, normalized.idempotency_key, requestHash, stableStringify(detail));
    });
    try {
        tx.immediate();
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = lookupExistingReceipt(db, normalized.project, normalized.recipient, normalized.message_id, normalized.receipt_kind, normalized.idempotency_key);
        if (raced && raced.request_hash === requestHash)
            return rowToReceipt(raced);
        if (raced) {
            throw new AgentIdempotencyConflictError(`Agent receipt idempotency conflict for message ${normalized.message_id} (${normalized.receipt_kind}).`);
        }
        throw error;
    }
    const stored = lookupExistingReceipt(db, normalized.project, normalized.recipient, normalized.message_id, normalized.receipt_kind, normalized.idempotency_key);
    if (!stored)
        throw new AgentMessagingError(`Agent receipt ${receiptId} could not be read back.`);
    return rowToReceipt(stored);
}
export function readAgentMessageReceipts(db, input) {
    const project = requireText('project', input.project, MAX_SCOPE_FIELD);
    const recipient = requireText('recipient', input.recipient, MAX_SCOPE_FIELD);
    const messageId = requireText('message_id', input.message_id, MAX_SCOPE_FIELD);
    assertMessageAccess(db, project, recipient, messageId);
    const rows = db.prepare(`
    SELECT receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, detail_json, created_at, request_hash
    FROM agent_message_receipts
    WHERE project = ? AND recipient = ? AND message_id = ?
    ORDER BY rowid ASC
  `).all(project, recipient, messageId);
    return rows.map(rowToReceipt);
}
export function recordAgentAckFact(db, input) {
    const deliveryId = requireText('delivery_id', input.delivery_id, MAX_SCOPE_FIELD);
    const hostAcceptId = requireText('host_accept_id', input.host_accept_id, MAX_SCOPE_FIELD);
    const actor = requireText('actor', input.actor, MAX_SCOPE_FIELD);
    const idempotencyKey = requireText('idempotency_key', input.idempotency_key, MAX_IDEMPOTENCY_KEY);
    const detail = normalizeBoundedDetail(input.detail);
    const requestHash = hashCanonical({ delivery_id: deliveryId, host_accept_id: hostAcceptId, actor, detail });
    const accepted = db.prepare(`
    SELECT 1 FROM agent_host_accepts WHERE host_accept_id = ? AND delivery_id = ?
  `).get(hostAcceptId, deliveryId);
    if (!accepted) {
        throw new AgentMessageAccessError(`Host acceptance ${hostAcceptId} does not belong to delivery ${deliveryId}.`);
    }
    const existing = lookupAckFact(db, deliveryId, actor, idempotencyKey);
    if (existing)
        return checkedFact(existing, requestHash, rowToAckFact, deliveryId, 'agent_ack');
    const factId = randomUUID();
    try {
        db.prepare(`
      INSERT INTO agent_ack_facts (
        ack_fact_id, delivery_id, host_accept_id, actor, idempotency_key, request_hash, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(factId, deliveryId, hostAcceptId, actor, idempotencyKey, requestHash, stableStringify(detail));
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = lookupAckFact(db, deliveryId, actor, idempotencyKey);
        if (raced)
            return checkedFact(raced, requestHash, rowToAckFact, deliveryId, 'agent_ack');
        throw error;
    }
    const stored = lookupAckFact(db, deliveryId, actor, idempotencyKey);
    if (!stored)
        throw new AgentMessagingError(`Agent acknowledgement ${factId} could not be read back.`);
    return rowToAckFact(stored);
}
export function recordAgentWorkflowFact(db, input) {
    const deliveryId = requireText('delivery_id', input.delivery_id, MAX_SCOPE_FIELD);
    const actor = requireText('actor', input.actor, MAX_SCOPE_FIELD);
    const workflowState = requireText('workflow_state', input.workflow_state, MAX_SCOPE_FIELD);
    const idempotencyKey = requireText('idempotency_key', input.idempotency_key, MAX_IDEMPOTENCY_KEY);
    const detail = normalizeBoundedDetail(input.detail);
    assertDeliveryExists(db, deliveryId);
    const requestHash = hashCanonical({ delivery_id: deliveryId, actor, workflow_state: workflowState, detail });
    const existing = lookupWorkflowFact(db, deliveryId, actor, idempotencyKey);
    if (existing)
        return checkedFact(existing, requestHash, rowToWorkflowFact, deliveryId, 'workflow');
    const factId = randomUUID();
    try {
        db.prepare(`
      INSERT INTO agent_workflow_facts (
        workflow_fact_id, delivery_id, actor, workflow_state, idempotency_key, request_hash, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(factId, deliveryId, actor, workflowState, idempotencyKey, requestHash, stableStringify(detail));
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = lookupWorkflowFact(db, deliveryId, actor, idempotencyKey);
        if (raced)
            return checkedFact(raced, requestHash, rowToWorkflowFact, deliveryId, 'workflow');
        throw error;
    }
    const stored = lookupWorkflowFact(db, deliveryId, actor, idempotencyKey);
    if (!stored)
        throw new AgentMessagingError(`Agent workflow fact ${factId} could not be read back.`);
    return rowToWorkflowFact(stored);
}
export function recordAgentRetentionFact(db, input) {
    const messageId = requireText('message_id', input.message_id, MAX_SCOPE_FIELD);
    const actor = requireText('actor', input.actor, MAX_SCOPE_FIELD);
    const retentionState = requireText('retention_state', input.retention_state, MAX_SCOPE_FIELD);
    const idempotencyKey = requireText('idempotency_key', input.idempotency_key, MAX_IDEMPOTENCY_KEY);
    const detail = normalizeBoundedDetail(input.detail);
    if (!db.prepare('SELECT 1 FROM agent_messages WHERE message_id = ?').get(messageId)) {
        throw new AgentMessageAccessError(`Agent message ${messageId} does not exist.`);
    }
    const requestHash = hashCanonical({ message_id: messageId, actor, retention_state: retentionState, detail });
    const existing = lookupRetentionFact(db, messageId, actor, idempotencyKey);
    if (existing)
        return checkedFact(existing, requestHash, rowToRetentionFact, messageId, 'retention');
    const factId = randomUUID();
    try {
        db.prepare(`
      INSERT INTO agent_retention_facts (
        retention_fact_id, message_id, actor, retention_state, idempotency_key, request_hash, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(factId, messageId, actor, retentionState, idempotencyKey, requestHash, stableStringify(detail));
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = lookupRetentionFact(db, messageId, actor, idempotencyKey);
        if (raced)
            return checkedFact(raced, requestHash, rowToRetentionFact, messageId, 'retention');
        throw error;
    }
    const stored = lookupRetentionFact(db, messageId, actor, idempotencyKey);
    if (!stored)
        throw new AgentMessagingError(`Agent retention fact ${factId} could not be read back.`);
    return rowToRetentionFact(stored);
}
function normalizeSendInput(input) {
    const project = requireText('project', input.project, MAX_SCOPE_FIELD);
    const sender = requireText('sender', input.sender, MAX_SCOPE_FIELD);
    const recipient = requireText('recipient', input.recipient, MAX_SCOPE_FIELD);
    const target_kind = parseTargetKind(input.target_kind ?? 'principal');
    const idempotency_key = requireText('idempotency_key', input.idempotency_key, MAX_IDEMPOTENCY_KEY);
    const content_type = parseContentType(input.content_type);
    const sender_host = optionalText('sender_host', input.sender_host ?? null, MAX_SCOPE_FIELD);
    const correlation_id = optionalText('correlation_id', input.correlation_id ?? null, MAX_SCOPE_FIELD);
    const reply_to = optionalText('reply_to', input.reply_to ?? null, MAX_SCOPE_FIELD);
    const privacy = parsePrivacy(input.privacy ?? 'private');
    if (content_type === 'text/plain' && typeof input.payload !== 'string') {
        throw new AgentMessagingError('text/plain agent messages require a string payload.');
    }
    assertJsonValue(input.payload, 'payload');
    const payloadBytes = Buffer.byteLength(stableStringify(input.payload), 'utf8');
    if (payloadBytes > MAX_JSON_BYTES) {
        throw new AgentMessagingError(`Agent message payload exceeds ${MAX_JSON_BYTES} bytes.`);
    }
    const provenance = input.provenance === undefined
        ? {}
        : normalizeObject(input.provenance);
    const provenanceBytes = Buffer.byteLength(stableStringify(provenance), 'utf8');
    if (provenanceBytes > MAX_JSON_BYTES) {
        throw new AgentMessagingError(`Agent message provenance exceeds ${MAX_JSON_BYTES} bytes.`);
    }
    return {
        project,
        sender,
        recipient,
        target_kind,
        idempotency_key,
        content_type,
        payload: input.payload,
        sender_host,
        correlation_id,
        reply_to,
        privacy,
        provenance,
    };
}
function normalizeReceiptInput(input) {
    const project = requireText('project', input.project, MAX_SCOPE_FIELD);
    const recipient = requireText('recipient', input.recipient, MAX_SCOPE_FIELD);
    const message_id = requireText('message_id', input.message_id, MAX_SCOPE_FIELD);
    const actor = requireText('actor', input.actor, MAX_SCOPE_FIELD);
    const idempotency_key = requireText('idempotency_key', input.idempotency_key, MAX_IDEMPOTENCY_KEY);
    const detail = input.detail === undefined
        ? {}
        : normalizeObject(input.detail);
    const detailBytes = Buffer.byteLength(stableStringify(detail), 'utf8');
    if (detailBytes > MAX_JSON_BYTES) {
        throw new AgentMessagingError(`Agent receipt detail exceeds ${MAX_JSON_BYTES} bytes.`);
    }
    switch (input.receipt_kind) {
        case 'intake':
            if (input.intake_state !== 'fetched' && input.intake_state !== 'ingested') {
                throw new AgentMessagingError(`Unsupported intake_state ${String(input.intake_state)}.`);
            }
            return { ...input, project, recipient, message_id, actor, idempotency_key, detail };
        case 'ack':
            return { ...input, project, recipient, message_id, actor, idempotency_key, detail };
        case 'disposition':
            if (!['accepted', 'rejected', 'cancelled', 'completed', 'deferred'].includes(input.disposition)) {
                throw new AgentMessagingError(`Unsupported disposition ${String(input.disposition)}.`);
            }
            return { ...input, project, recipient, message_id, actor, idempotency_key, detail };
        case 'host_activation':
            if (!['woken', 'manual_resume_required', 'unsupported', 'failed'].includes(input.host_activation)) {
                throw new AgentMessagingError(`Unsupported host_activation ${String(input.host_activation)}.`);
            }
            return { ...input, project, recipient, message_id, actor, idempotency_key, detail };
        default:
            throw new AgentMessagingError(`Unsupported receipt_kind ${input.receipt_kind ?? '<missing>'}.`);
    }
}
function buildReceiptDetail(input) {
    const detail = input.detail === undefined
        ? {}
        : normalizeObject(input.detail);
    switch (input.receipt_kind) {
        case 'intake':
            return { intake_state: input.intake_state, detail };
        case 'ack':
            return { acknowledged: true, detail };
        case 'disposition':
            return { disposition: input.disposition, detail };
        case 'host_activation':
            return { host_activation: input.host_activation, detail };
    }
}
function normalizeLimit(limit) {
    if (limit === undefined)
        return DEFAULT_POLL_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_POLL_LIMIT) {
        throw new AgentMessagingError(`Poll limit must be an integer between 1 and ${MAX_POLL_LIMIT}.`);
    }
    return limit;
}
function normalizeTimeout(timeoutMs) {
    if (timeoutMs === undefined)
        return DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5 * 60 * 1000) {
        throw new AgentMessagingError('wait_ms must be an integer between 0 and 300000.');
    }
    return timeoutMs;
}
function normalizePollInterval(intervalMs) {
    if (intervalMs === undefined)
        return DEFAULT_WAIT_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_WAIT_INTERVAL_MS || intervalMs > 60_000) {
        throw new AgentMessagingError(`poll_interval_ms must be an integer between ${MIN_WAIT_INTERVAL_MS} and 60000.`);
    }
    return intervalMs;
}
function resolveCursor(db, project, recipient, cursorToken) {
    if (!cursorToken) {
        return { cursor_token: '', project, recipient, event_sequence: 0 };
    }
    const token = requireText('cursor', cursorToken, MAX_CURSOR_TOKEN);
    const row = db.prepare(`
    SELECT cursor_token, project, recipient, event_sequence
    FROM agent_message_cursors
    WHERE cursor_token = ?
  `).get(token);
    if (!row || row.project !== project || row.recipient !== recipient) {
        throw new AgentMessageAccessError(`Agent message cursor is not available to recipient ${recipient} in project ${project}.`);
    }
    return row;
}
function createCursor(db, project, recipient, eventSequence) {
    const existing = db.prepare(`
    SELECT cursor_token
    FROM agent_message_cursors
    WHERE project = ? AND recipient = ? AND event_sequence = ?
    LIMIT 1
  `).get(project, recipient, eventSequence);
    if (existing)
        return existing.cursor_token;
    const cursorToken = randomBytes(18).toString('base64url');
    try {
        db.prepare(`
      INSERT INTO agent_message_cursors (cursor_token, project, recipient, event_sequence)
      VALUES (?, ?, ?, ?)
    `).run(cursorToken, project, recipient, eventSequence);
    }
    catch (error) {
        if (!isUniqueConstraint(error))
            throw error;
        const raced = db.prepare(`
      SELECT cursor_token
      FROM agent_message_cursors
      WHERE project = ? AND recipient = ? AND event_sequence = ?
      LIMIT 1
    `).get(project, recipient, eventSequence);
        if (raced)
            return raced.cursor_token;
        throw error;
    }
    return cursorToken;
}
function lookupExistingMessage(db, project, sender, idempotencyKey) {
    return db.prepare(`
    SELECT
      i.request_hash,
      m.message_id,
      d.delivery_id,
      e.event_id,
      m.project,
      m.sender,
      m.sender_host,
      d.recipient,
      d.target_kind,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      m.provenance_json,
      m.created_at
    FROM agent_message_idempotency i
    JOIN agent_messages m ON m.message_id = i.message_id
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    JOIN agent_message_events e ON e.message_id = m.message_id
    WHERE i.project = ? AND i.sender = ? AND i.idempotency_key = ?
    ORDER BY e.event_sequence ASC
    LIMIT 1
  `).get(project, sender, idempotencyKey);
}
function loadSentMessage(db, project, recipient, messageId) {
    return db.prepare(`
    SELECT
      m.message_id,
      d.delivery_id,
      e.event_id,
      m.project,
      m.sender,
      m.sender_host,
      d.recipient,
      d.target_kind,
      m.content_type,
      m.correlation_id,
      m.reply_to_message_id,
      m.privacy,
      m.provenance_json,
      m.created_at
    FROM agent_messages m
    JOIN agent_message_deliveries d ON d.message_id = m.message_id
    JOIN agent_message_events e ON e.message_id = m.message_id
    WHERE m.project = ? AND d.project = ? AND d.recipient = ? AND m.message_id = ?
    ORDER BY e.event_sequence ASC
    LIMIT 1
  `).get(project, project, recipient, messageId);
}
function assertMessageAccess(db, project, recipient, messageId) {
    const row = db.prepare(`
    SELECT 1
    FROM agent_message_deliveries
    WHERE project = ? AND recipient = ? AND message_id = ?
  `).get(project, recipient, messageId);
    if (!row) {
        throw new AgentMessageAccessError(`Agent message ${messageId} is not available to recipient ${recipient} in project ${project}.`);
    }
}
function lookupExistingReceipt(db, project, recipient, messageId, receiptKind, idempotencyKey) {
    return db.prepare(`
    SELECT receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, detail_json, created_at, request_hash
    FROM agent_message_receipts
    WHERE project = ? AND recipient = ? AND message_id = ? AND receipt_kind = ? AND idempotency_key = ?
  `).get(project, recipient, messageId, receiptKind, idempotencyKey);
}
function lookupAckFact(db, deliveryId, actor, idempotencyKey) {
    return db.prepare(`
    SELECT ack_fact_id, delivery_id, host_accept_id, actor, idempotency_key,
           detail_json, created_at, request_hash
    FROM agent_ack_facts
    WHERE delivery_id = ? AND actor = ? AND idempotency_key = ?
  `).get(deliveryId, actor, idempotencyKey);
}
function lookupWorkflowFact(db, deliveryId, actor, idempotencyKey) {
    return db.prepare(`
    SELECT workflow_fact_id, delivery_id, actor, workflow_state, idempotency_key,
           detail_json, created_at, request_hash
    FROM agent_workflow_facts
    WHERE delivery_id = ? AND actor = ? AND idempotency_key = ?
  `).get(deliveryId, actor, idempotencyKey);
}
function lookupRetentionFact(db, messageId, actor, idempotencyKey) {
    return db.prepare(`
    SELECT retention_fact_id, message_id, actor, retention_state, idempotency_key,
           detail_json, created_at, request_hash
    FROM agent_retention_facts
    WHERE message_id = ? AND actor = ? AND idempotency_key = ?
  `).get(messageId, actor, idempotencyKey);
}
function checkedFact(row, requestHash, convert, subjectId, kind) {
    if (row.request_hash !== requestHash) {
        throw new AgentIdempotencyConflictError(`Agent ${kind} idempotency conflict for ${subjectId}.`);
    }
    return convert(row);
}
function assertDeliveryExists(db, deliveryId) {
    if (!db.prepare('SELECT 1 FROM agent_message_deliveries WHERE delivery_id = ?').get(deliveryId)) {
        throw new AgentMessageAccessError(`Agent message delivery ${deliveryId} does not exist.`);
    }
}
function normalizeBoundedDetail(detail) {
    const normalized = detail === undefined ? {} : normalizeObject(detail);
    if (Buffer.byteLength(stableStringify(normalized), 'utf8') > MAX_JSON_BYTES) {
        throw new AgentMessagingError(`Agent lifecycle detail exceeds ${MAX_JSON_BYTES} bytes.`);
    }
    return normalized;
}
function rowToAckFact(row) {
    return {
        ack_fact_id: row.ack_fact_id,
        delivery_id: row.delivery_id,
        host_accept_id: row.host_accept_id,
        actor: row.actor,
        idempotency_key: row.idempotency_key,
        detail: parseJsonObject(row.detail_json, 'detail_json'),
        created_at: row.created_at,
    };
}
function rowToWorkflowFact(row) {
    return {
        workflow_fact_id: row.workflow_fact_id,
        delivery_id: row.delivery_id,
        actor: row.actor,
        workflow_state: row.workflow_state,
        idempotency_key: row.idempotency_key,
        detail: parseJsonObject(row.detail_json, 'detail_json'),
        created_at: row.created_at,
    };
}
function rowToRetentionFact(row) {
    return {
        retention_fact_id: row.retention_fact_id,
        message_id: row.message_id,
        actor: row.actor,
        retention_state: row.retention_state,
        idempotency_key: row.idempotency_key,
        detail: parseJsonObject(row.detail_json, 'detail_json'),
        created_at: row.created_at,
    };
}
function finishSentMessage(row, options) {
    const sent = rowToSentAgentMessage(row);
    if (!options.notifier)
        return sent;
    try {
        const result = options.notifier.notify({
            delivery_id: sent.delivery_id,
            event_id: sent.event_id,
            project: sent.project,
            target_kind: sent.target_kind,
            target_id: sent.recipient,
        });
        if (result && typeof result.then === 'function')
            void result.catch(() => undefined);
    }
    catch {
    }
    return sent;
}
function rowToSentAgentMessage(row) {
    return {
        message_id: row.message_id,
        delivery_id: row.delivery_id,
        event_id: row.event_id,
        project: row.project,
        sender: row.sender,
        sender_host: row.sender_host,
        recipient: row.recipient,
        target_kind: parseTargetKind(row.target_kind),
        content_type: parseContentType(row.content_type),
        correlation_id: row.correlation_id,
        reply_to: row.reply_to_message_id,
        privacy: parsePrivacy(row.privacy),
        created_at: row.created_at,
        provenance: parseJsonObject(row.provenance_json, 'provenance_json'),
    };
}
function rowToEventHeader(row) {
    return {
        event_id: row.event_id,
        message_id: row.message_id,
        sender: row.sender,
        sender_host: row.sender_host,
        recipient: row.recipient,
        target_kind: parseTargetKind(row.target_kind),
        content_type: parseContentType(row.content_type),
        correlation_id: row.correlation_id,
        reply_to: row.reply_to_message_id,
        privacy: parsePrivacy(row.privacy),
        created_at: row.created_at,
    };
}
function rowToReceipt(row) {
    const detail = parseJsonObject(row.detail_json, 'detail_json');
    const base = {
        receipt_id: row.receipt_id,
        message_id: row.message_id,
        project: row.project,
        recipient: row.recipient,
        actor: row.actor,
        idempotency_key: row.idempotency_key,
        created_at: row.created_at,
    };
    switch (row.receipt_kind) {
        case 'intake': {
            const intakeState = detail.intake_state;
            if (intakeState !== 'fetched' && intakeState !== 'ingested') {
                throw new AgentMessagingError(`Unsupported stored intake_state ${String(intakeState)}.`);
            }
            return { ...base, receipt_kind: 'intake', intake_state: intakeState, detail };
        }
        case 'ack':
            return { ...base, receipt_kind: 'ack', detail };
        case 'disposition': {
            const disposition = detail.disposition;
            if (!['accepted', 'rejected', 'cancelled', 'completed', 'deferred'].includes(String(disposition))) {
                throw new AgentMessagingError(`Unsupported stored disposition ${String(disposition)}.`);
            }
            return { ...base, receipt_kind: 'disposition', disposition: disposition, detail };
        }
        case 'host_activation': {
            const activation = detail.host_activation;
            if (!['woken', 'manual_resume_required', 'unsupported', 'failed'].includes(String(activation))) {
                throw new AgentMessagingError(`Unsupported stored host_activation ${String(activation)}.`);
            }
            return { ...base, receipt_kind: 'host_activation', host_activation: activation, detail };
        }
        default:
            throw new AgentMessagingError(`Unsupported stored receipt_kind ${row.receipt_kind}.`);
    }
}
function parsePrivacy(value) {
    if (value === 'private' || value === 'team')
        return value;
    throw new AgentMessagingError(`Unsupported agent message privacy ${value}.`);
}
function parseContentType(value) {
    if (value === 'text/plain' || value === 'application/json')
        return value;
    throw new AgentMessagingError(`Unsupported agent message content_type ${value}.`);
}
function parseTargetKind(value) {
    if (value === 'principal' || value === 'session')
        return value;
    throw new AgentMessagingError(`Unsupported agent message target_kind ${value}.`);
}
function parseJsonObject(json, label) {
    const parsed = parseJsonObjectOrValue(json);
    if (!isPlainObject(parsed))
        throw new AgentMessagingError(`${label} must contain a JSON object.`);
    return parsed;
}
function parseJsonObjectOrValue(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch (error) {
        throw new AgentMessagingError(`Stored agent message JSON is invalid: ${error instanceof Error ? error.message : String(error)}.`);
    }
    assertJsonValue(parsed, 'stored_json');
    return parsed;
}
function hashCanonical(value) {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}
function stableStringify(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new AgentMessagingError('Only finite numbers are allowed in agent message JSON.');
        return JSON.stringify(value);
    }
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
    const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
}
function assertJsonValue(value, label) {
    if (value === null)
        return;
    if (typeof value === 'boolean')
        return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new AgentMessagingError(`${label} must contain only finite numbers.`);
        return;
    }
    if (typeof value === 'string')
        return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`));
        return;
    }
    if (isPlainObject(value)) {
        for (const [key, entry] of Object.entries(value)) {
            assertJsonValue(entry, `${label}.${key}`);
        }
        return;
    }
    throw new AgentMessagingError(`${label} must be JSON-serializable.`);
}
function normalizeObject(value) {
    assertJsonValue(value, 'object');
    return value;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requireText(label, value, maxLength) {
    if (typeof value !== 'string')
        throw new AgentMessagingError(`${label} must be a string.`);
    const trimmed = value.trim();
    if (trimmed.length === 0)
        throw new AgentMessagingError(`${label} must not be blank.`);
    if (trimmed.length > maxLength) {
        throw new AgentMessagingError(`${label} must be at most ${maxLength} characters.`);
    }
    return trimmed;
}
function optionalText(label, value, maxLength) {
    if (value === null)
        return null;
    return requireText(label, value, maxLength);
}
function isUniqueConstraint(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /UNIQUE constraint failed|PRIMARY KEY/i.test(message);
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new AgentWaitAbortedError('Waiting for agent events was aborted.');
}
async function waitForDelay(ms, signal) {
    if (ms <= 0)
        return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new AgentWaitAbortedError('Waiting for agent events was aborted.'));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
//# sourceMappingURL=agent-messaging.js.map