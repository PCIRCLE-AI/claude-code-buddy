// ============================================================================
// AUTO-GENERATED from src/core/agent-message-inbox.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export function unreadDeliveryCount(db, project, recipient) {
    if (!recipient)
        return 0;
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND d.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`).get(project, recipient);
        const n = row?.n;
        return typeof n === 'number' && n > 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
export function recipientEverSeen(db, project, recipient) {
    try {
        const row = db.prepare(`SELECT (
         EXISTS(SELECT 1 FROM agent_principals WHERE project = ? AND principal_id = ?)
         OR EXISTS(SELECT 1 FROM agent_message_deliveries WHERE project = ? AND recipient = ?)
         OR EXISTS(SELECT 1 FROM agent_session_instances WHERE project = ? AND session_instance_id = ?)
       ) AS seen`).get(project, recipient, project, recipient, project, recipient);
        return row?.seen === undefined ? undefined : Boolean(row.seen);
    }
    catch {
        return undefined;
    }
}
export function unreadInboxLines(count, project, recipient, everSeen) {
    if (!recipient)
        return [];
    const displayProject = JSON.stringify(project);
    const displayRecipient = JSON.stringify(recipient);
    if (count > 0) {
        const noun = count === 1 ? 'message' : 'messages';
        return [`${count} ${noun} waiting for ${displayRecipient} in project ${displayProject} — poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id; fetching does not acknowledge.`];
    }
    if (everSeen === false) {
        return [`No messages waiting for ${displayRecipient} in project ${displayProject} — and this recipient id has never been seen in this project (check for a typo).`];
    }
    return [];
}
