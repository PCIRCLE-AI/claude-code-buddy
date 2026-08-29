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
// block that carries the user's stated goal / next / blocked, which both
// `briefing` and the SessionStart hook render. One line, only when non-zero:
//
//   2 messages waiting for "memesh" — fetch them with the message tool
//
// What "unread" means, precisely: a delivery row exists for this project and
// no intake receipt (`fetched` or `ingested`) has been recorded for it. That
// is the durable inbox's own definition — polling and fetching are separate
// facts, and this counts only what nobody has fetched yet. It does NOT count
// acknowledgement; a fetched-but-unacknowledged message is the agent's
// business, not a wakeup.
//
// Read-only, one query, and it tolerates a database from before the message
// tables existed (returns 0, says nothing) — SessionStart runs against every
// graph on the machine, including ones that predate 4.8.0.
//
// This file is mirrored into scripts/hooks/_generated/ by
// scripts/generate-hook-core.mjs, exactly like task-state.ts, so the hook and
// the MCP surface cannot disagree on what "unread" means.

/** Minimal database shape shared by node:sqlite and the hook's wrapper. */
interface InboxDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Deliveries addressed to recipients in `project` that have no intake receipt.
 * 0 when the message tables are absent (pre-4.8.0 graph) or on any query
 * error — a briefing must never fail because the inbox could not be counted.
 */
export function unreadDeliveryCount(db: InboxDb, project: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n
       FROM agent_message_deliveries d
       WHERE d.project = ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_message_receipts r
           WHERE r.project = d.project
             AND r.recipient = d.recipient
             AND r.message_id = d.message_id
             AND r.receipt_kind = 'intake'
         )`,
    ).get(project) as { n?: number } | undefined;
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
export function unreadInboxLines(count: number, project: string): string[] {
  if (count <= 0) return [];
  const noun = count === 1 ? 'message' : 'messages';
  return [`${count} ${noun} waiting for "${project}" — fetch them with the message tool; fetching does not acknowledge.`];
}
