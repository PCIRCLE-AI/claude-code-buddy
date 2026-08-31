// =============================================================================
// Unread inbox — the one fact about messages that belongs in a briefing
// =============================================================================
//
// Why this exists. On 2026-08-29 an agent working in this repository spent a
// whole session next to two other local agents and never once used `message`
// to reach them — it used the host's own push tool every time, because that
// tool named itself in the output the agent was reading, and nothing the agent
// read ever said "there is a durable inbox, and something in it is for you".
// The rules were all written down; none of them were in front of the agent at
// the moment it chose a tool.
//
// So this module puts the fact where the agent is already looking: the same
// block that carries the user's stated goal / next / blocked. One line, only
// when a briefing caller supplies an exact recipient and the count is non-zero:
//
//   2 messages waiting for "claude-implementer" in project "memesh" — poll
//   with that exact project and recipient, then fetch each message_id
//
// What "unread" means, precisely: a delivery row exists for this project and
// no intake receipt (`fetched` or `ingested`) has been recorded for it. That
// is the durable inbox's own definition — polling and fetching are separate
// facts, and this counts only what nobody has fetched yet. It does NOT count
// acknowledgement; a fetched-but-unacknowledged message is the agent's
// business, not a wakeup.
//
// Read-only, one query, and it tolerates a database from before the message
// tables existed (returns 0, says nothing). A caller with no exact recipient
// also returns 0 before querying, so generic briefing and SessionStart share
// one fail-closed rule instead of implementing separate omission paths.
//
// This file is mirrored into scripts/hooks/_generated/ by
// scripts/generate-hook-core.mjs, exactly like task-state.ts, so SessionStart
// and the MCP/CLI briefing surface cannot disagree on this trust boundary.

/** Minimal database shape shared by node:sqlite and the hook's wrapper. */
interface InboxDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Deliveries addressed to recipients in `project` that have no intake receipt.
 * 0 when the message tables are absent (pre-4.8.0 graph) or on any query
 * error — a briefing must never fail because the inbox could not be counted.
 */
export function unreadDeliveryCount(db: InboxDb, project: string, recipient?: string): number {
  if (!recipient) return 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND d.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`,
    ).get(project, recipient) as { n?: number } | undefined;
    const n = row?.n;
    return typeof n === 'number' && n > 0 ? n : 0;
  } catch {
    // Table missing (older schema) or unreadable: not a wakeup, not an error.
    return 0;
  }
}

/**
 * The line(s) to place beside the task-state lines. Empty when nothing is
 * waiting, so a quiet inbox adds no noise.
 */
export function unreadInboxLines(count: number, project: string, recipient?: string): string[] {
  if (count <= 0 || !recipient) return [];
  const noun = count === 1 ? 'message' : 'messages';
  // CLI callers bypass Zod and project/recipient values become model-facing
  // text. JSON quoting keeps quotes, control characters, and newlines from
  // forging a second briefing line while the SQL query still uses originals.
  const displayProject = JSON.stringify(project);
  const displayRecipient = JSON.stringify(recipient);
  return [`${count} ${noun} waiting for ${displayRecipient} in project ${displayProject} — poll the message tool with project ${displayProject} and recipient ${displayRecipient}, then fetch each message_id; fetching does not acknowledge.`];
}
