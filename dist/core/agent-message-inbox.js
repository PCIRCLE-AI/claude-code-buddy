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
//# sourceMappingURL=agent-message-inbox.js.map