# Local Agent Messaging Guide

MeMesh provides two complementary collaboration surfaces on one machine:

- shared durable memory, including the `team` namespace, for knowledge, decisions, and coarse handoffs;
- the `message` tool for explicit durable messages to one named recipient on the same MeMesh instance.

The messaging path is durable store-and-forward. A registered active compatible host receives a Local native push; SQLite remains the audit and reconnect authority. `poll`/`watch` exist as explicit compatibility and diagnostic APIs, not as the normal active-session delivery loop. Host acceptance is still not proof that a model read, acknowledged, or accepted the work.

## One-time owner-private managed-host setup

Native delivery is optional and local to one Unix account. Do this setup once
for the account that owns both the MeMesh database and the active host
sessions; do not place router tokens or host config in a repository, shared
dotfile, or world-readable temp directory.

Start the router in a user-owned terminal. It creates an owner-private token
and socket beside the active MeMesh database on first start:

```bash
umask 077
memesh-router
```

Leave that process running. In a second terminal, verify only the installed
adapter imports and the live router socket separately:

```bash
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 memesh doctor
```

The first command proves the installed MCP schema and adapter imports. The
second only proves that the owner-private router socket accepts a connection.
Neither command starts or registers a host, sends a message, proves
`host_accept`, or wakes a stopped session.
In particular, a socket check does not start the host it observes.

Create one reusable owner-private config for each provider/principal. The
stable principal is the logical recipient; every managed process generates a
fresh exact session identity. No active thread/session ID is copied by hand.
Ordinary already-running sessions are not attached and are reported as
presence-only/inbound-unavailable.

```bash
memesh agent setup codex --project my-project --principal codex-reviewer --workspace "$PWD"
memesh agent setup claude --project my-project --principal claude-reviewer
memesh agent setup gemini --project my-project --principal gemini-reviewer --workspace "$PWD"
```

### Codex app-server runner

```bash
memesh-host-codex --config "$HOME/.memesh/hosts/codex.json"
```

This starts a MeMesh-owned `codex app-server`, creates its thread through the
private Unix/WebSocket control path, and registers only after that thread is
ready. It does not attach to an ordinary Codex TUI. Message content never
appears in MeMesh or Codex process arguments.

### Claude channel runner

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
the notification was written to stdio, not that Claude admitted it. With the
channel admitted, initialization creates and registers the exact MeMesh
session automatically; EOF, MCP close, or normal signals unregister it.

### Gemini ACP runner

Use this only for a MeMesh-managed ACP-capable local agent:

```bash
memesh-host-acp --config "$HOME/.memesh/hosts/gemini-acp.json"
```

The runner owns `gemini --acp`, creates or explicitly loads the ACP session,
and registers only after protocol/session readiness. Ordinary Gemini UI
resume/session flags are rejected. Authentication, capability, or process
failure leaves no false host acceptance.

All three runners deliver only while their configured target is active and
registered. If it is stopped, missing, disconnected, or replaced, MeMesh keeps
the durable message but does not start the host, recreate the session, or
silently redirect an exact-session target. A later eligible managed principal
registration drains only post-activation pending work; an exact-session target
never moves to the replacement. Manual cursor reads remain available for audit
and diagnostics, not as a requirement for active host delivery.

## What Works Today

- MCP, HTTP, and CLI use the same message lifecycle and SQLite system of record.
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key.
- `poll` and `memesh message watch` return only events for the exact project and recipient. The opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient and matching `target_kind` in the named project. Exact-session messages require `target_kind=session`; polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion.
- The transport, rather than model-provided payload data, records sender-host provenance.

## Identity and lifecycle

A **principal** is the stable logical recipient. A **session** is one live host connection for that principal. A **generation** changes when that session is replaced. An exact-session target never reroutes. A principal target can deliver only to an eligible active session after its activation checkpoint; it does not replay historical inbox contents into a first session.

Persistence, dispatch attempt, host acceptance, intake, acknowledgement, workflow disposition, retention, and presence are independent state axes. An active compatible host receives host-native input without polling. A stopped, missing, busy beyond its queue limit, or unsupported session is not awakened, resumed, or replaced; durable state remains available for audit and an eligible later registration, subject to exact-session and activation-checkpoint rules.

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

Applied pruning replaces only eligible payload content with a hash-bound
tombstone. Message identity, routing, receipts, ACK, workflow, presence, and
retention audit facts remain queryable. Freed SQLite pages become reusable;
the main database file is a high-watermark and is not promised to shrink.
Full `VACUUM` is never run by a hook or this bounded command.

An owner may set `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES` to a non-negative
integer. The canonical send transaction checks it before inserting any
message effect; an over-quota send returns `storage_quota_exceeded` and leaves
no partial message, delivery, event, idempotency, dispatch, or receipt row.
There is deliberately no default quota or automatic retention policy.

## Local and Cloud boundary

**Local** owns the SQLite durable event and the last-mile host-native input channel on the same machine. **Cloud** may relay or coordinate remote work, but it is not evidence that a local host received a message. A2A, SSE, discovery, persistence, and fetch are not host delivery, and neither path promises exactly-once cognition, a reply, or a stopped-session wake-up.

## What This Is Not Yet

- Not a claim of vendor-host dogfood. The packaged smoke test starts an installed router and controlled installed host client, then proves native delivery and persisted `host_accept`; it does not verify a live Codex, Claude, or ACP product session.
- Not universal stopped-session resume. Codex, Claude Code, ChatGPT, Gemini, Grok, or an Ollama-backed loop needs a separately implemented host adapter before MeMesh can claim it can resume that host.
- Not topic, broadcast, lease/claim, or TTL routing. The current delivery target is one exact recipient.
- Not arbitrary external-user access or cross-machine delivery. A local MeMesh instance is not a public collaboration service.
- Not permission to execute payload content. The receiving host must apply its own policy and required human approval.

## Support Matrix

| Participant | Current path | Status today | Notes |
|---|---|---|---|
| Claude Code | plugin or MCP | message tool available | The host or an adapter must call/poll it; stopped-session resume is not implied |
| Codex CLI | MCP | message tool available | `memesh-mcp`; the host controls polling and task execution |
| Gemini CLI | MCP | message tool available | `memesh-mcp`; the host controls polling and task execution |
| Cursor / Cline / other MCP hosts | MCP | message tool available | Exact automation depends on the host tool loop |
| ChatGPT web / Custom GPTs | local bridge or HTTPS action | adapter-dependent | Cannot call `localhost` by itself |
| Gemini web / AI Studio | local bridge | adapter-dependent | Gemini CLI is the direct MCP path; web needs a bridge |
| Grok or other browser-hosted AI | local bridge | adapter-dependent | Treat host automation as unsupported until its adapter is verified |
| Ollama-backed local agents | custom loop via MCP / HTTP / CLI | integration surface available | The agent loop participates; bare Ollama is not itself a MeMesh-aware host |
| Hermes Agent / OpenClaw / custom code | native plugin or local loop | adapter-dependent messaging | Existing memory integrations do not by themselves prove automatic message wakeup |

## Lifecycle

1. A sender calls `message` with `action: "send"`, a stable sender, one recipient, a project, an idempotency key, and a payload.
2. The router pushes the full authorized envelope to an eligible registered host-native adapter. An explicit `poll`/`watch` client may instead read privacy-minimized events for compatibility or diagnosis.
3. A host-native adapter receives the full envelope; a poll client must call `fetch` with the recipient ID and the message's matching principal/session target kind to read the payload.
4. The receiver records only the facts that actually happened:
   - `intake`: payload fetched or durably ingested;
   - `ack`: explicit recipient acknowledgement;
   - `disposition`: accepted, rejected, completed, cancelled, or deferred;
   - `activation`: woken, manual resume required, unsupported, or failed.
5. After router or host restart, registration drains only eligible durable deliveries. A manual cursor replay may repeat an event, so application intake still uses its own idempotency key.

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

## Remaining Product Work

- complete real-host dogfood for every advertised managed adapter; no stopped session is to be woken or resumed by that work;
- richer routing such as topics, claims/leases, and expiry where real use cases require them;
- operator inbox and receipt visibility;
- a governed Local-to-Cloud relay for cross-machine collaboration.

Those layers should reuse MCP for tools and A2A-compatible inter-agent semantics rather than introduce a new general-purpose base protocol.
