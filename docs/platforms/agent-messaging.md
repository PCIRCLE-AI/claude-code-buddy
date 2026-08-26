# Local Agent Messaging Guide

MeMesh provides two complementary collaboration surfaces on one machine:

- shared durable memory, including the `team` namespace, for knowledge, decisions, and coarse handoffs;
- the `message` tool for explicit durable messages to one named recipient on the same MeMesh instance.

The messaging path is store-and-forward with bounded polling for durable recovery. An active compatible host can additionally receive a Local native notification; host acceptance is still not proof that a model acknowledged or accepted the work.

## One-time owner-private Local runner setup

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

For each runner below, create the config with mode `0600` and replace every
`/absolute/...` placeholder with data from the currently active host. The
stable `principal_id` is the logical recipient; `session_instance_id` is new
for each host process. Starting a runner is a one-time-per-active-session
registration, not a way to resume an old session.

```bash
umask 077
mkdir -p "$HOME/.memesh/hosts"
chmod 700 "$HOME/.memesh/hosts"
```

### Codex app-server runner

```bash
cat >"$HOME/.memesh/hosts/codex.json" <<'JSON'
{
  "router_socket": "/absolute/path/to/agent-router.sock",
  "token_file": "/absolute/path/to/agent-router.token",
  "project": "my-project",
  "principal_id": "codex-reviewer",
  "session_instance_id": "codex-session-unique-to-this-process",
  "control_socket": "/absolute/path/to/the-active-codex-app-server.sock",
  "thread_id": "active-codex-thread-id"
}
JSON
chmod 600 "$HOME/.memesh/hosts/codex.json"
memesh-host-codex --config "$HOME/.memesh/hosts/codex.json"
```

### Claude channel runner

Run this as the MCP server connected to the active Claude Code session, not as
an unrelated background process:

```bash
cat >"$HOME/.memesh/hosts/claude.json" <<'JSON'
{
  "router_socket": "/absolute/path/to/agent-router.sock",
  "token_file": "/absolute/path/to/agent-router.token",
  "project": "my-project",
  "principal_id": "claude-reviewer",
  "session_instance_id": "claude-session-unique-to-this-process",
  "server_name": "memesh-channel"
}
JSON
chmod 600 "$HOME/.memesh/hosts/claude.json"
memesh-host-claude --config "$HOME/.memesh/hosts/claude.json"
```

### Gemini ACP runner

Use this only for a MeMesh-managed ACP-capable local agent. The `command` and
`args` describe the owner's local ACP executable; they are not fetched or
started by a sender.

```bash
cat >"$HOME/.memesh/hosts/acp.json" <<'JSON'
{
  "router_socket": "/absolute/path/to/agent-router.sock",
  "token_file": "/absolute/path/to/agent-router.token",
  "project": "my-project",
  "principal_id": "gemini-reviewer",
  "session_instance_id": "acp-session-unique-to-this-process",
  "workspace": "/absolute/path/to/the-active-workspace",
  "command": "gemini",
  "args": ["--acp"]
}
JSON
chmod 600 "$HOME/.memesh/hosts/acp.json"
memesh-host-acp --config "$HOME/.memesh/hosts/acp.json"
```

All three runners deliver only while their configured target is active and
registered. If it is stopped, missing, disconnected, or replaced, MeMesh keeps
the durable message but does not start the host, recreate the session, or
silently redirect an exact-session target. Use cursor recovery for that case.

## What Works Today

- MCP, HTTP, and CLI use the same message lifecycle and SQLite system of record.
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key.
- `poll` and `memesh message watch` return only events for the exact project and recipient. The opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient in the named project. Polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion.
- The transport, rather than model-provided payload data, records sender-host provenance.

## Identity and lifecycle

A **principal** is the stable logical recipient. A **session** is one live host connection for that principal. A **generation** changes when that session is replaced. An exact-session target never reroutes. A principal target can deliver only to an eligible active session after its activation checkpoint; it does not replay historical inbox contents into a first session.

Persistence, dispatch attempt, host acceptance, intake, acknowledgement, workflow disposition, retention, and presence are independent state axes. An active compatible host may receive a host-native notification, removing polling for that live delivery. A stopped, missing, busy beyond its queue limit, or unsupported session is not awakened, resumed, or replaced; polling/cursor recovery remains the durable fallback.

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
2. The receiver calls `poll`, or runs `memesh message watch`, with its project, recipient ID, and last durable cursor.
3. A returned event is a privacy-minimized hint. A receiver operating under the host's policy calls `fetch` with the logical recipient ID to read the payload.
4. The receiver records only the facts that actually happened:
   - `intake`: payload fetched or durably ingested;
   - `ack`: explicit recipient acknowledgement;
   - `disposition`: accepted, rejected, completed, cancelled, or deferred;
   - `activation`: woken, manual resume required, unsupported, or failed.
5. After timeout or restart, the receiver repeats the poll/watch with its last cursor. Replaying an older cursor may replay an event, so application intake uses its own idempotency key.

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

- real-host dogfood for adapters; no stopped session is to be woken or resumed by that work;
- richer routing such as topics, claims/leases, and expiry where real use cases require them;
- operator inbox and receipt visibility;
- a governed Local-to-Cloud relay for cross-machine collaboration.

Those layers should reuse MCP for tools and A2A-compatible inter-agent semantics rather than introduce a new general-purpose base protocol.
