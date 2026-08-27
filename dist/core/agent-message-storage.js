import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'cancelled', 'rejected']);
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;
export class AgentMessageStorageError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'AgentMessageStorageError';
        this.code = code;
    }
}
export class AgentMessageStorageQuotaExceededError extends AgentMessageStorageError {
    quotaBytes;
    usedBytes;
    requestedBytes;
    constructor(quotaBytes, usedBytes, requestedBytes) {
        super('storage_quota_exceeded', 'Agent message storage quota exceeded.');
        this.name = 'AgentMessageStorageQuotaExceededError';
        this.quotaBytes = quotaBytes;
        this.usedBytes = usedBytes;
        this.requestedBytes = requestedBytes;
    }
}
export function getAgentMessageStorageReport(db, options) {
    const cutoff = normalizeCutoff(options.cutoff);
    const states = readMessageStates(db, cutoff);
    const lifecycle = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agent_message_deliveries) AS delivery_count,
      (SELECT COUNT(*) FROM agent_message_events) AS event_count,
      (SELECT COUNT(*) FROM agent_message_receipts) AS receipt_count,
      (SELECT COUNT(*) FROM agent_message_cursors) AS cursor_count,
      (SELECT COUNT(*) FROM agent_principals) AS principal_count,
      (SELECT COUNT(*) FROM agent_session_instances) AS session_instance_count,
      (SELECT COUNT(*) FROM agent_session_connections) AS session_connection_count,
      (SELECT COUNT(*) FROM agent_presence_facts) AS presence_fact_count,
      (SELECT COUNT(*) FROM agent_dispatch_attempts) AS dispatch_attempt_count,
      (SELECT COUNT(*) FROM agent_host_accepts) AS host_accept_count,
      (SELECT COUNT(*) FROM agent_ack_facts) AS ack_fact_count,
      (SELECT COUNT(*) FROM agent_workflow_facts) AS workflow_fact_count,
      (SELECT COUNT(*) FROM agent_retention_facts) AS retention_fact_count
  `).get();
    const pageCount = pragmaInteger(db, 'page_count');
    const pageSize = pragmaInteger(db, 'page_size');
    const freelistCount = pragmaInteger(db, 'freelist_count');
    return {
        message_count: states.message_count,
        delivery_count: lifecycle.delivery_count,
        event_count: lifecycle.event_count,
        receipt_count: lifecycle.receipt_count,
        cursor_count: lifecycle.cursor_count,
        principal_count: lifecycle.principal_count,
        session_instance_count: lifecycle.session_instance_count,
        session_connection_count: lifecycle.session_connection_count,
        presence_fact_count: lifecycle.presence_fact_count,
        dispatch_attempt_count: lifecycle.dispatch_attempt_count,
        host_accept_count: lifecycle.host_accept_count,
        ack_fact_count: lifecycle.ack_fact_count,
        workflow_fact_count: lifecycle.workflow_fact_count,
        retention_fact_count: lifecycle.retention_fact_count,
        payload_bytes: states.payload_bytes,
        original_payload_bytes: states.original_payload_bytes,
        tombstoned_message_count: states.tombstoned_message_count,
        protected_unresolved_message_count: states.protected_unresolved_message_count,
        terminal_retained_message_count: states.terminal_retained_message_count,
        terminal_prunable_message_count: states.terminal_prunable_message_count,
        terminal_prunable_payload_bytes: states.terminal_prunable_payload_bytes,
        reconciled_message_count: states.reconciled_message_count,
        page_count: pageCount,
        page_size: pageSize,
        freelist_count: freelistCount,
        allocated_database_bytes: pageCount * pageSize,
        reusable_freelist_bytes: freelistCount * pageSize,
        database_file_bytes: safeFileSize(options.databasePath),
        wal_file_bytes: options.databasePath ? safeFileSize(`${options.databasePath}-wal`) : null,
    };
}
export function pruneTerminalAgentMessagePayloads(db, options) {
    const cutoff = normalizeCutoff(options.cutoff);
    const batchSize = normalizeBatchSize(options.batchSize);
    const dryRun = options.dryRun === undefined ? true : options.dryRun;
    const actor = normalizeActor(options.actor);
    if (dryRun) {
        const candidates = selectPrunableMessages(db, cutoff, batchSize).map(toCandidate);
        return resultForCandidates(true, candidates);
    }
    return db.transaction(() => {
        const selected = selectPrunableMessages(db, cutoff, batchSize);
        const candidates = selected.map(toCandidate);
        for (let index = 0; index < selected.length; index++) {
            const candidate = candidates[index];
            options.fault?.beforeTombstone?.(candidate);
            const tombstone = stableTombstone(candidate.payload_sha256, candidate.payload_bytes);
            const result = db.prepare(`
        UPDATE agent_messages
        SET payload_json = ?, payload_sha256 = ?, payload_original_bytes = ?, payload_tombstoned_at = CURRENT_TIMESTAMP
        WHERE message_id = ? AND payload_tombstoned_at IS NULL
      `).run(tombstone, candidate.payload_sha256, candidate.payload_bytes, candidate.message_id);
            if (result.changes !== 1) {
                throw new AgentMessageStorageError('retention_concurrent_change', 'Agent message retention candidate changed during pruning.');
            }
            insertRetentionFact(db, candidate, actor, tombstone);
        }
        return resultForCandidates(false, candidates);
    }).immediate();
}
export function enforceAgentMessageStorageQuota(db, input) {
    const quotaBytes = normalizeNonNegativeInteger('quotaBytes', input.quotaBytes);
    const additionalPayloadBytes = normalizeNonNegativeInteger('additionalPayloadBytes', input.additionalPayloadBytes);
    const row = db.prepare(`
    SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payload_bytes
    FROM agent_messages
  `).get();
    const usedBytes = row.payload_bytes;
    if (usedBytes + additionalPayloadBytes > quotaBytes) {
        throw new AgentMessageStorageQuotaExceededError(quotaBytes, usedBytes, additionalPayloadBytes);
    }
}
export function agentMessagePayloadStorageBytes(payloadJson) {
    if (typeof payloadJson !== 'string') {
        throw new AgentMessageStorageError('invalid_payload_storage_input', 'Agent message payload JSON must be a string.');
    }
    return Buffer.byteLength(payloadJson, 'utf8');
}
function readMessageStates(db, cutoff) {
    return db.prepare(`
    WITH workflow_candidates AS (
      SELECT delivery_id, workflow_state, created_at, 1 AS source_rank, rowid AS fact_order
      FROM agent_workflow_facts
      UNION ALL
      SELECT d.delivery_id, json_extract(r.detail_json, '$.disposition') AS workflow_state,
        r.created_at, 0 AS source_rank, r.rowid AS fact_order
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'disposition'
    ), latest_workflow AS (
      SELECT delivery_id, workflow_state, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY delivery_id
          ORDER BY julianday(created_at) DESC, source_rank DESC, fact_order DESC
        ) AS row_number
      FROM workflow_candidates
    ), acknowledged_deliveries AS (
      SELECT delivery_id
      FROM agent_ack_facts
      UNION
      SELECT d.delivery_id
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'ack'
    ), delivery_states AS (
      SELECT d.message_id,
        COUNT(*) AS delivery_count,
        SUM(CASE WHEN acknowledged_deliveries.delivery_id IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged_count,
        SUM(CASE WHEN lw.workflow_state IN ('completed', 'cancelled', 'rejected') THEN 1 ELSE 0 END) AS terminal_count,
        SUM(CASE WHEN lw.workflow_state IN ('completed', 'cancelled', 'rejected')
                      AND julianday(lw.created_at) < julianday(?) THEN 1 ELSE 0 END) AS old_terminal_count
      FROM agent_message_deliveries d
      LEFT JOIN acknowledged_deliveries ON acknowledged_deliveries.delivery_id = d.delivery_id
      LEFT JOIN latest_workflow lw ON lw.delivery_id = d.delivery_id AND lw.row_number = 1
      GROUP BY d.message_id
    ), message_states AS (
      SELECT m.message_id, length(CAST(m.payload_json AS BLOB)) AS payload_bytes,
        COALESCE(m.payload_original_bytes, length(CAST(m.payload_json AS BLOB))) AS original_payload_bytes,
        CASE
          WHEN m.payload_tombstoned_at IS NOT NULL THEN 'tombstoned'
          WHEN COALESCE(ds.delivery_count, 0) > 0
               AND ds.acknowledged_count = ds.delivery_count
               AND ds.terminal_count = ds.delivery_count
               AND ds.old_terminal_count = ds.delivery_count THEN 'prunable'
          WHEN COALESCE(ds.delivery_count, 0) > 0
               AND ds.acknowledged_count = ds.delivery_count
               AND ds.terminal_count = ds.delivery_count THEN 'terminal_retained'
          ELSE 'protected'
        END AS storage_state
      FROM agent_messages m
      LEFT JOIN delivery_states ds ON ds.message_id = m.message_id
    )
    SELECT
      COUNT(*) AS message_count,
      COALESCE(SUM(payload_bytes), 0) AS payload_bytes,
      COALESCE(SUM(original_payload_bytes), 0) AS original_payload_bytes,
      COALESCE(SUM(storage_state = 'tombstoned'), 0) AS tombstoned_message_count,
      COALESCE(SUM(storage_state = 'protected'), 0) AS protected_unresolved_message_count,
      COALESCE(SUM(storage_state = 'terminal_retained'), 0) AS terminal_retained_message_count,
      COALESCE(SUM(storage_state = 'prunable'), 0) AS terminal_prunable_message_count,
      COALESCE(SUM(CASE WHEN storage_state = 'prunable' THEN payload_bytes ELSE 0 END), 0) AS terminal_prunable_payload_bytes,
      COALESCE(SUM(storage_state IN ('tombstoned', 'protected', 'terminal_retained', 'prunable')), 0) AS reconciled_message_count
    FROM message_states
  `).get(cutoff);
}
function selectPrunableMessages(db, cutoff, batchSize) {
    return db.prepare(`
    WITH workflow_candidates AS (
      SELECT delivery_id, workflow_state, created_at, 1 AS source_rank, rowid AS fact_order
      FROM agent_workflow_facts
      UNION ALL
      SELECT d.delivery_id, json_extract(r.detail_json, '$.disposition') AS workflow_state,
        r.created_at, 0 AS source_rank, r.rowid AS fact_order
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'disposition'
    ), latest_workflow AS (
      SELECT delivery_id, workflow_state, created_at,
        ROW_NUMBER() OVER (
          PARTITION BY delivery_id
          ORDER BY julianday(created_at) DESC, source_rank DESC, fact_order DESC
        ) AS row_number
      FROM workflow_candidates
    ), acknowledged_deliveries AS (
      SELECT delivery_id
      FROM agent_ack_facts
      UNION
      SELECT d.delivery_id
      FROM agent_message_receipts r
      JOIN agent_message_deliveries d
        ON d.message_id = r.message_id AND d.project = r.project AND d.recipient = r.recipient
      WHERE r.receipt_kind = 'ack'
    ), delivery_states AS (
      SELECT d.message_id,
        COUNT(*) AS delivery_count,
        SUM(CASE WHEN acknowledged_deliveries.delivery_id IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged_count,
        SUM(CASE WHEN lw.workflow_state IN ('completed', 'cancelled', 'rejected')
                      AND julianday(lw.created_at) < julianday(?) THEN 1 ELSE 0 END) AS old_terminal_count
      FROM agent_message_deliveries d
      LEFT JOIN acknowledged_deliveries ON acknowledged_deliveries.delivery_id = d.delivery_id
      LEFT JOIN latest_workflow lw ON lw.delivery_id = d.delivery_id AND lw.row_number = 1
      GROUP BY d.message_id
    )
    SELECT m.message_id, m.payload_json, length(CAST(m.payload_json AS BLOB)) AS payload_bytes
    FROM agent_messages m
    JOIN delivery_states ds ON ds.message_id = m.message_id
    WHERE m.payload_tombstoned_at IS NULL
      AND ds.delivery_count > 0
      AND ds.acknowledged_count = ds.delivery_count
      AND ds.old_terminal_count = ds.delivery_count
    ORDER BY m.created_at ASC, m.message_id ASC
    LIMIT ?
  `).all(cutoff, batchSize);
}
function toCandidate(row) {
    return {
        message_id: row.message_id,
        payload_bytes: row.payload_bytes,
        payload_sha256: createHash('sha256').update(row.payload_json, 'utf8').digest('hex'),
    };
}
function resultForCandidates(dryRun, candidates) {
    return {
        dry_run: dryRun,
        candidate_count: candidates.length,
        tombstoned_count: dryRun ? 0 : candidates.length,
        reclaimed_payload_bytes: reclaimedPayloadBytes(candidates),
        candidates,
    };
}
function reclaimedPayloadBytes(candidates) {
    const netPayloadBytes = candidates.reduce((total, candidate) => {
        const tombstone = stableTombstone(candidate.payload_sha256, candidate.payload_bytes);
        return total + candidate.payload_bytes - Buffer.byteLength(tombstone, 'utf8');
    }, 0);
    return Math.max(0, netPayloadBytes);
}
function insertRetentionFact(db, candidate, actor, tombstone) {
    const idempotencyKey = `payload-tombstone:${candidate.message_id}:${candidate.payload_sha256}`;
    const detailJson = JSON.stringify({
        algorithm: 'sha256',
        original_payload_bytes: candidate.payload_bytes,
        payload_sha256: candidate.payload_sha256,
        tombstone_payload_bytes: Buffer.byteLength(tombstone, 'utf8'),
    });
    const requestHash = createHash('sha256').update(detailJson, 'utf8').digest('hex');
    db.prepare(`
    INSERT INTO agent_retention_facts (
      retention_fact_id, message_id, actor, retention_state, idempotency_key, request_hash, detail_json
    ) VALUES (?, ?, ?, 'payload_tombstoned', ?, ?, ?)
  `).run(randomUUID(), candidate.message_id, actor, idempotencyKey, requestHash, detailJson);
}
function stableTombstone(payloadHash, originalPayloadBytes) {
    return JSON.stringify({
        _agent_message_tombstone_v1: {
            algorithm: 'sha256',
            original_payload_bytes: originalPayloadBytes,
            payload_sha256: payloadHash,
        },
    });
}
function normalizeCutoff(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new AgentMessageStorageError('invalid_retention_cutoff', 'Agent message retention cutoff must be a valid date.');
    }
    return date.toISOString();
}
function normalizeBatchSize(value) {
    if (value === undefined)
        return DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
        throw new AgentMessageStorageError('invalid_retention_batch_size', `Agent message retention batch size must be between 1 and ${MAX_BATCH_SIZE}.`);
    }
    return value;
}
function normalizeActor(value) {
    const actor = (value ?? 'agent-message-retention-v1').trim();
    if (actor.length === 0 || actor.length > 200) {
        throw new AgentMessageStorageError('invalid_retention_actor', 'Agent message retention actor must be 1 to 200 characters.');
    }
    return actor;
}
function normalizeNonNegativeInteger(label, value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new AgentMessageStorageError('invalid_storage_quota', `${label} must be a non-negative safe integer.`);
    }
    return value;
}
function pragmaInteger(db, pragma) {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    const value = row[pragma];
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new AgentMessageStorageError('invalid_storage_pragma', `SQLite PRAGMA ${pragma} returned an invalid value.`);
    }
    return value;
}
function safeFileSize(filePath) {
    if (!filePath)
        return null;
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? stat.size : null;
    }
    catch {
        return null;
    }
}
export const AGENT_MESSAGE_TERMINAL_WORKFLOW_STATES = [...TERMINAL_WORKFLOW_STATES];
//# sourceMappingURL=agent-message-storage.js.map