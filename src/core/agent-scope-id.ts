// =============================================================================
// Canonical form and validation for durable-message scope identifiers
// =============================================================================
//
// `agent_message_deliveries` keys an inbox on (`project`, `recipient`), and
// both arrived as free text with no canonical form at all. On the maintainer's
// own graph that split one logical inbox across spellings:
//
//   recipient  root 25          vs  /root 20
//   project    memesh 38        vs  memesh-llm-memory 28
//              /Users/ktseng/Developer/Projects/memesh-llm-memory 1
//
// A recipient that fetches under one spelling never sees what was sent under
// the other, and `briefing`'s unread count is computed per spelling.
//
// What this module does, and — more importantly — what it deliberately does
// NOT do. Merging two identities that are genuinely different is worse than
// the split it would close: it delivers one agent's messages to another. So
// the only transformations here are ones that provably preserve identity:
//
//   1. Unicode NFC. Two byte-different strings that Unicode itself calls
//      canonically equivalent are one name; SQLite compares bytes and would
//      call them two. No such value exists in the measured graph — this is a
//      forward-looking safety property, not a fix for something observed.
//   2. Trim. Already the previous behaviour of `requireText`; kept.
//
// Everything else is a REFUSAL rather than a rewrite. In particular an
// absolute filesystem path is not a scope identifier and never can be:
// `getProjectName` (core/paths.ts) has three layers — git remote slug, git
// repo-root basename, and `basename(realpath)-<8 hex>` — and not one of them
// can return a value beginning with a separator or a drive letter. So a value
// of that shape is provably not a project identity this product produced, and
// the same holds for the agent id on the other side of the same key. Refusing
// it names the field and what a valid value looks like; silently rewriting
// `/root` to `root` would also silently fuse `/tmp/root` with `/var/root`.
//
// Why not lowercase, strip prefixes, or collapse separators: none of those is
// provably identity-preserving. `claude-code:session_X` vs `session_X` looks
// like a namespace prefix, but `claude-code:` appears nowhere in this
// repository's source, artifacts, or git history (`git log -S 'claude-code:'
// --all` is empty), so there is no convention to normalise against, and
// stripping it would merge a legitimate `claude-code:reviewer` with a
// different agent called `reviewer`.

/** The bound every message scope field already used. */
export const AGENT_SCOPE_ID_MAX_LENGTH = 200;

/**
 * The canonical byte form of a scope identifier: NFC, then trimmed.
 *
 * Applied on both the write and the read side of the same key — a caller that
 * passes the decomposed spelling on `poll` must land on the rows that the
 * composed spelling wrote. Normalising on reads ALONE would leave the split in
 * the data, which is the failure this exists to prevent.
 */
export function canonicalAgentScopeId(value: string): string {
  return value.normalize('NFC').trim();
}

/**
 * Is this value spelled as an absolute filesystem path?
 *
 * Three shapes, and deliberately only these three: a POSIX absolute path
 * (`/root`), a Windows drive path (`C:\work`, `C:/work`), and a UNC path
 * (`\\server\share`). A RELATIVE path — `a/b` — is not matched: nothing in the
 * measured data produced one, and an agent id containing a slash is not proof
 * that a filesystem was meant. The rule stays as narrow as the evidence.
 */
export function isFilesystemPathScopeId(value: string): boolean {
  const v = canonicalAgentScopeId(value);
  if (v.startsWith('/') || v.startsWith('\\')) return true;
  return /^[A-Za-z]:[\\/]/.test(v);
}

/**
 * The final segment of a path-shaped identifier, or `null` when there is none
 * (`/`, `C:\`). Used only by the one-shot repair in storage/graph-repairs.ts:
 * `/root` → `root`, `/Users/ktseng/Developer/Projects/memesh-llm-memory` →
 * `memesh-llm-memory`. It is NOT used on the write path, where the same value
 * is refused instead.
 */
export function lastPathSegment(value: string): string | null {
  const segments = canonicalAgentScopeId(value).split(/[\\/]+/).filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  // `C:` alone is a drive, not a name.
  if (/^[A-Za-z]:$/.test(last)) return null;
  return last;
}

/**
 * The fail-closed message for a scope identifier that can never be right, or
 * `null` when the value is acceptable.
 *
 * It names the field and shows what a valid value looks like, derived from
 * what the caller actually passed, so the fix is one edit rather than a
 * documentation lookup.
 */
export function agentScopeIdRejection(field: string, value: string): string | null {
  if (!isFilesystemPathScopeId(value)) return null;
  const suggestion = lastPathSegment(value);
  const example = suggestion === null ? 'reviewer-agent' : suggestion;
  return `${field} must be a stable identifier, not a filesystem path (received ${JSON.stringify(canonicalAgentScopeId(value))}). `
    + `Use the name on its own, for example ${JSON.stringify(example)}.`;
}

/**
 * Every durable-message column that holds a routing identity, with the role
 * each column plays. One list, imported by the one-shot repair
 * (`storage/graph-repairs.ts`) and by `kg rename-project`
 * (`core/project-tags.ts`), and mirrored — it cannot be imported from
 * JavaScript — by the invariant in `scripts/audit/memory-invariants.mjs`.
 * Keep the three in step: the set the write path refuses, the set the repair
 * rewrites, and the set the invariant watches must be equal, or the result is
 * either a hole or an invariant that is red forever.
 *
 * Table and column names here are literals and never caller input, so
 * interpolating them into SQL is safe.
 *
 * The router and presence tables (`agent_principals`,
 * `agent_session_instances`, `agent_session_connections`,
 * `agent_presence_facts`, `agent_dispatch_attempts`) are deliberately absent:
 * their `project` comes from an owner-written host config through
 * `memesh agent setup`, not from `MessageSchema`.
 */
export const AGENT_MESSAGE_SCOPE_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly columns: readonly string[];
}> = [
  { table: 'agent_messages', columns: ['project', 'recipient'] },
  { table: 'agent_message_deliveries', columns: ['project', 'recipient'] },
  { table: 'agent_message_events', columns: ['project', 'recipient'] },
  { table: 'agent_message_cursors', columns: ['project', 'recipient'] },
  { table: 'agent_message_receipts', columns: ['project', 'recipient', 'actor'] },
  { table: 'agent_message_idempotency', columns: ['project'] },
  { table: 'agent_ack_facts', columns: ['actor'] },
  { table: 'agent_workflow_facts', columns: ['actor'] },
  { table: 'agent_retention_facts', columns: ['actor'] },
];

/** The tables carrying a `project` scope column, for a project rename. */
export const AGENT_MESSAGE_PROJECT_TABLES: readonly string[] =
  AGENT_MESSAGE_SCOPE_COLUMNS.filter((e) => e.columns.includes('project')).map((e) => e.table);
