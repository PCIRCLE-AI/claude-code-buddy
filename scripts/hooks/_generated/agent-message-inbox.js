// ============================================================================
// AUTO-GENERATED from src/core/agent-message-inbox.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export function unreadDeliveryCount(db, project) {
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`).get(project);
        const n = row?.n;
        return typeof n === 'number' && n > 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
export function unreadInboxLines(count, project) {
    if (count <= 0)
        return [];
    const noun = count === 1 ? 'message' : 'messages';
    return [`${count} ${noun} waiting for "${project}" — fetch them with the message tool; fetching does not acknowledge.`];
}
