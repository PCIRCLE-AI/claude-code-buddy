# Local Agent Messaging Guide

MeMesh provides two complementary collaboration surfaces on one machine:

- shared durable memory, including the `team` namespace, for knowledge, decisions, and coarse handoffs;
- the `message` tool for explicit durable messages to one named recipient on the same MeMesh instance.

The messaging path is store-and-forward with bounded polling. It is not a push bus, and a wakeup event is not proof that a model resumed or accepted the work.

## What Works Today

- MCP, HTTP, and CLI use the same message lifecycle and SQLite system of record.
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key.
- `poll` and `memesh message watch` return only events for the exact project and recipient. The opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient in the named project. Polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion.
- The transport, rather than model-provided payload data, records sender-host provenance.

## What This Is Not Yet

- Not host-initiated push delivery. A receiver must keep or restart a poll/watch loop.
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
memesh message send \
  --project my-project \
  --sender implementation-agent \
  --recipient reviewer-agent \
  --idempotency-key review-request-42 \
  --payload '{"request":"Review the current change"}' \
  --content-type application/json
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

- verified host adapters that can safely wake or resume supported agent runtimes;
- richer routing such as topics, claims/leases, and expiry where real use cases require them;
- operator inbox and receipt visibility;
- a governed Local-to-Cloud relay for cross-machine collaboration.

Those layers should reuse MCP for tools and A2A-compatible inter-agent semantics rather than introduce a new general-purpose base protocol.
