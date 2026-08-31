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
export function unreadInboxLines(count, project, recipient) {
    if (count <= 0 || !recipient)
        return [];
    const noun = count === 1 ? 'message' : 'messages';
    const displayProject = JSON.stringify(project);
    const displayRecipient = JSON.stringify(recipient);
    return [`${count} ${noun} waiting for ${displayRecipient} in project ${displayProject} — poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id; fetching does not acknowledge.`];
}
//# sourceMappingURL=agent-message-inbox.js.map