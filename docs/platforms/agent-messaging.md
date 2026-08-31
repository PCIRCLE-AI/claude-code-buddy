# Local Agent Messaging Guide

MeMesh provides two complementary collaboration surfaces on one machine:

- shared durable memory, including the `team` namespace, for knowledge, decisions, and coarse handoffs;
- the `message` tool for explicit durable messages to one named recipient on the same MeMesh instance.
- `message discover` for a bounded, project-scoped view of currently live host registrations.

Use `memesh message discover --project <name> [--limit 1..100]` to read the
router directory. Results expose `session_id`, `principal_id`, `host_kind`,
`project`, declared `model` and `work_summary` (`null` when absent), `active`,
`generation`, and `lease_expires_at_ms`. Discovery performs no send, fetch, ACK, replay, or
receipt operation; router unavailability is an explicit error, never an empty
directory.

Briefing follows the same trust boundary. Generic `briefing` and automatic
SessionStart context have no recipient identity, so they never aggregate or
announce unread message activity. A caller that already knows its exact
logical recipient may pass both `project` and `recipient` to `briefing`; the
result reports only that recipient's unfetched deliveries and tells it to
`message poll` with the exact scope before fetching each returned
`message_id`. Fetching remains separate from intake and acknowledgement.

The messaging path keeps durable store-and-forward compatibility. For an
exact active local Codex or Claude session, MeMesh sends one bounded full
message through the authenticated native host channel and waits for native
acceptance; no marker-to-fetch step is required. An unavailable exact session
returns `recipient_unavailable` while scoped recovery data remains durable.
Principal targets retain asynchronous store-and-forward semantics.
`poll`/`watch` are compatibility and diagnostic APIs. A queue admission or
`host_accept` is not proof that an agent read the payload, acknowledged it, or
accepted the work.

## One-time owner-private local-host setup

Native delivery is optional and local to one Unix account. Do this setup once
for the account that owns both the MeMesh database and the active host
sessions; do not place router tokens or host config in a repository, shared
dotfile, or world-readable temp directory.

Each configured host connection attempts to start the packaged router and
retries when its owner-private socket is absent or refused. You can also start
the router yourself when you want to inspect it directly; it creates an
owner-private token and socket beside the active MeMesh database on first
start:

```bash
umask 077
memesh-router
```

If you start it yourself, leave that process running. In a second terminal,
verify only the installed adapter imports and the live router socket separately:

```bash
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 memesh doctor
```

The first command proves the installed MCP schema and adapter imports. The
second only proves that the owner-private router socket accepts a connection.
Neither command starts or registers a host, sends a message, proves
`host_accept`, or wakes a stopped session.
In particular, a socket check does not start the host it observes.

The secure host-native router and adapter runtime currently supports macOS and
Linux. Windows remains supported for core MeMesh memory, durable message
storage, and MCP tools, but host-native wakeup fails closed before creating
credentials, configuration, IPC listeners, or managed child processes.

Create one reusable owner-private config for each local path and principal.
The stable principal is the logical recipient. Managed processes generate a
fresh exact session identity; the ordinary Codex path instead uses the Codex
thread identity supplied at SessionStart. No thread ID is copied by hand.
Ordinary sessions outside the explicit `codex-session` workspace opt-in remain
`presence-only/inbound-unavailable`.

```bash
memesh agent setup codex-session --project my-project --principal codex-reviewer --workspace "$PWD"
memesh agent setup codex --project my-project --principal codex-reviewer --workspace "$PWD"
memesh agent setup claude --project my-project --principal claude-reviewer
```

Optional declarations can be persisted with `--model <id>` and
`--work-summary <text>` (each is capped at 200 characters); no defaults are guessed.

### Ordinary active Codex CLI session

`codex-session` is the opt-in path for an ordinary local Codex session and
requires the MeMesh Codex plugin to be installed and enabled so Codex loads
the packaged SessionStart hook. Run
the setup command from the exact workspace that Codex will use; it stores the
configured real workspace and stable principal in the owner-private
`codex-session.json` config. Restart Codex in that workspace after setup.

This guide's supported documented path is ordinary Codex CLI `SessionStart`.
Codex Desktop or an unattached task is not user-visible native-delivery
evidence unless that exact live session registers with the router and the
result is directly verified. This is a scope boundary for evidence, not a
claim that Codex Desktop is universally unsupported.

On `SessionStart` for `startup` or `resume`, the asynchronous companion checks
the Codex thread identity, hook session identity, and configured workspace
realpath before it connects to the router. A missing identity, a different
workspace, compact lifecycle input, or a failed/disconnected connection does
not register a host and does not wake anything.

For a registered session, MeMesh invokes `codex queue` with one untrusted full
envelope capped at 16 KiB. The exact-session sender returns
`native_delivery.status: "native_accepted"` only after the queue accepts it;
Codex does not need a second `message fetch` to inspect that native message.
The persisted `host_accept` is neither agent readback nor an `ack` or workflow
disposition. Codex exposes message text only through its `--message` process
argument, so same-user process inspection may observe it while the short-lived
queue command runs; do not put secrets in native messages.

If the configured Codex session is stopped, missing, disconnected, or no
longer matches its configured workspace, MeMesh does not start or replace it.
An exact-session send reports `recipient_unavailable`; durable scoped recovery
and receipt history remain available to fetch, cursor recovery, `poll`, or
`memesh message watch` for audit and diagnosis. Exact-session failures are not
automatically replayed through the native channel on a later registration; the
sender must retry deliberately if live delivery is still wanted.

### Separate: MeMesh-managed Codex app-server runner

```bash
memesh-host-codex --config "$HOME/.memesh/hosts/codex.json"
```

This is separate from `codex-session`: it starts a MeMesh-owned `codex
app-server`, creates its own thread through the private Unix/WebSocket control
path, and registers only after that thread is ready. It does not attach to an
ordinary Codex session. Message content never appears in MeMesh or Codex
process arguments.

### Claude channel runner

When `memesh doctor` is running from a Claude Code plugin cache, its default
`Claude Channel registration` row inspects only the user-scoped
`mcpServers.memesh-channel` entry in Claude's canonical user config and the
owner-private config file named by its `--config` argument. Missing
registration is informational: durable MCP/inbox messaging can still work,
while live Channel notification remains inactive until the upstream
research-preview channel is explicitly opted into. A malformed, stale, or
insecure target is a warning. `CONFIGURED` means only that the declaration and
target are coherent; it does not verify development-channel admission or that
an agent surfaced the notification.

Run the printed `registration_command` once to add `memesh-channel` as a
user-scoped stdio MCP server. Claude owns that process for the session:

```bash
claude mcp add --transport stdio --scope user memesh-channel -- \
  memesh-host-claude --config "$HOME/.memesh/hosts/claude.json"
```

Claude Channels is an upstream research-preview opt-in. Custom channels are
not on Anthropic's approved allowlist, so start every participating Claude
session with the printed launch command and confirm the local-development
warning:

```bash
claude --dangerously-load-development-channels server:memesh-channel
```

Without that flag Claude may initialize the ordinary MCP transport while
silently dropping channel events; a MeMesh `host_accept` then proves only that
the bounded message was written to stdio, not that Claude surfaced it. With the
channel admitted, initialization creates and registers the exact MeMesh
session automatically; EOF, MCP close, or normal signals unregister it.

### Experimental ACP runner (not release-gated)

An internal generic ACP runner remains an experimental adapter surface. No ACP
provider is documented as a supported native-wakeup path here; protocol or
process readiness alone is not proof that a provider accepted a message.

The managed Codex app-server and Claude channel paths deliver only while their
configured target is active and registered. If it is stopped, missing, disconnected, or replaced, MeMesh keeps the durable message but does not start
the host, recreate the session, or silently redirect an exact-session target.
A later eligible managed-principal registration drains only post-activation
pending work; an exact-session target never moves to a replacement. Manual
cursor reads remain available for audit and diagnostics, not as a requirement
for active Codex-session delivery.

## What Works Today

- MCP, HTTP, and CLI use the same message lifecycle and SQLite system of record.
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key. Exact-session success additionally requires native host acceptance; otherwise it returns `recipient_unavailable` while preserving recovery state.
- `poll` and `memesh message watch` return only events for the exact project and recipient. They are compatibility and diagnostic paths; the opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient and matching `target_kind` in the named project. Exact-session messages require `target_kind=session`; polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. Inbox/MCP ACK is valid without a host-native acceptance; host-native ACK remains bound to its `host_accept`. `receipts` returns one ordered projection and identifies each underlying fact source. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion.
- The transport, rather than model-provided payload data, records sender-host provenance.

## Identity and lifecycle

A **principal** is the stable logical recipient. A **session** is one live host connection for that principal. A **generation** changes when that session is replaced. An exact-session target never reroutes. A principal target can deliver only to an eligible active session after its activation checkpoint; it does not replay historical inbox contents into a first session.

Persistence, dispatch attempt, host acceptance, intake, acknowledgement,
workflow disposition, retention, and presence are independent state axes. An
active configured exact session receives a bounded full message without
polling or an inbox fetch. A stopped, missing, busy beyond its queue limit,
disconnected, or unsupported session returns `recipient_unavailable` and is
not awakened, resumed, or replaced; durable state remains available for audit
and recovery, subject to exact-session and activation-checkpoint rules.

## Bounded storage and audit retention

Message payload growth is observable and owner-controlled. MeMesh never deletes
unresolved, unacknowledged, retryable, or offline-pending messages to satisfy a
limit. Inspect logical payload bytes, protected rows, SQLite reusable pages,
and main/WAL file sizes with an explicit policy cutoff:

```bash
memesh message storage report --cutoff 2026-08-01T00:00:00Z
```

Preview one bounded batch of old terminal payloads; nothing changes without
`--apply`:

```bash
memesh message storage prune --cutoff 2026-08-01T00:00:00Z --batch-size 100
memesh message storage prune --cutoff 2026-08-01T00:00:00Z --batch-size 100 --apply
```

Applied pruning replaces only payload content whose every delivery has an
explicit ACK and a terminal workflow disposition older than the cutoff with a hash-bound
tombstone. Message identity, routing, receipts, ACK, workflow, presence, and
retention audit facts remain queryable. Freed SQLite pages become reusable;
the main database file is a high-watermark and is not promised to shrink.
Full `VACUUM` is never run by a hook or this bounded command.

An owner may set `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES` to a non-negative
integer. This is a hard **logical payload** budget, not a whole SQLite file or
disk quota. The canonical send transaction checks it before inserting any
message effect; an over-quota send returns `storage_quota_exceeded` and leaves
no partial message, delivery, event, idempotency, dispatch, or receipt row.
Metadata, indexes, append-only audit facts, reusable pages, and WAL bytes still
consume disk and remain visible in the report; keep separate filesystem
headroom and monitoring. Heartbeats refresh the connection lease in place;
they do not append one audit row every interval. Connected, disconnected, and
superseded transitions remain auditable. There is deliberately no default
quota or automatic retention policy.

## Local and Cloud boundary

This guide describes only one local MeMesh instance: its SQLite durable event
store and same-machine host-native input. Remote and cross-machine transport is
the responsibility of MeMesh Cloud and requires its own verified relay; Cloud
state is not evidence that this local host accepted a native message. Native
acceptance, persistence, or fetch does not promise exactly-once cognition, a
reply, or a stopped-session wake-up.

## What This Is Not Yet

- Not universal host support or stopped-session resume. This document only
  describes the explicitly configured ordinary Codex path and the separate
  managed Codex/Claude paths above.
- Not topic, broadcast, lease/claim, or TTL routing. The current delivery target is one exact recipient.
- Not arbitrary external-user access or cross-machine delivery. A local MeMesh instance is not a public collaboration service.
- Not permission to execute payload content. The receiving host must apply its own policy and required human approval.

## Support Matrix

| Participant | Current path | Status today | Notes |
|---|---|---|---|
| Ordinary Codex CLI | `codex-session` owner-private opt-in | bounded full-message native delivery while active | Exact workspace, principal, and SessionStart identity must match; stopped or disconnected exact sessions return `recipient_unavailable` |
| MeMesh-managed Codex app-server | `memesh-host-codex` | separate managed path | It creates its own Codex thread; it does not attach to an ordinary session |
| Claude channel | `memesh-host-claude` | separate channel path | Requires the documented Channel opt-in; no stopped-session resume |
| Other local MCP clients | MCP, HTTP, or CLI message operations | durable messaging only | Use `poll`/`watch` and scoped fetch where their own host loop supports it; this guide makes no native-wakeup claim |

## Lifecycle

1. A sender calls `message` with `action: "send"`, a stable sender, one recipient, a project, an idempotency key, and a payload.
2. For an eligible exact Codex or Claude session, the router sends one bounded
   untrusted full envelope and waits for native host acceptance. An explicit
   `poll`/`watch` client may still read privacy-minimized events for recovery,
   compatibility, or diagnosis.
3. Native acceptance returns `native_delivery.status: "native_accepted"`; an
   absent or rejected exact session returns `recipient_unavailable`. Neither
   outcome records an agent acknowledgement or workflow disposition.
4. The receiver records only the facts that actually happened:
   - `intake`: payload fetched or durably ingested;
   - `ack`: explicit recipient acknowledgement;
   - `disposition`: accepted, rejected, completed, cancelled, or deferred;
   - `activation`: woken, manual resume required, unsupported, or failed.
5. After router or host restart, registration drains only eligible durable principal deliveries. Failed exact-session native delivery requires an explicit retry. A manual cursor replay may repeat an event, so application intake still uses its own idempotency key.

`correlation_id` and `reply_to` can connect messages, but they do not change delivery or routing.

## CLI Example

Start one bounded receiver wait:

```bash
memesh message watch \
  --project my-project \
  --recipient reviewer-agent \
  --wait-ms 30000
```

Send from another process:

```bash
printf '%s' '{"request":"Review the current change"}' | memesh message send \
  --project my-project \
  --sender implementation-agent \
  --recipient reviewer-agent \
  --idempotency-key review-request-42 \
  --content-type application/json \
  --payload-stdin
```

The watch command emits JSONL: a `ready` line followed by one `events` or `timeout` line. Save `next_cursor` and pass it back with `--cursor` on the next invocation. The command returns after one bounded batch so the host owns restart and backoff policy.

## Shared Memory Versus Messages

Use memories for durable knowledge that agents should search and reuse: decisions, lessons, product feedback, and project context. Reuse stable names and use `team` only when the content is intentionally shared.

Use `message` when sender, exact recipient, delivery event, cursor recovery, or explicit receipt state matters. Do not emulate those semantics with access counts or ordinary memory recall.

## Security And Control

Messages and recalled memories are untrusted data.

- Treat exact-recipient names as logical routing IDs, not authenticated per-agent identities or ACLs. Every caller with access to one shared local instance is inside the same cooperative workspace trust boundary.
- Do not treat stored content as authority to expand tool permissions.
- Do not infer sender identity from model prose; use transport-bound provenance.
- Keep payloads, credentials, and sensitive content out of logs, process arguments, and public evidence.
- Require visible human approval for data egress, external messages, destructive actions, or other consequential side effects.
- Expect retries and stale cursors; make downstream intake idempotent.
