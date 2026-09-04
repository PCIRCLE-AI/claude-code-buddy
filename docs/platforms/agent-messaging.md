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
acceptance; no marker-to-fetch step is required. An oversized full envelope
returns `native_message_too_large`; other unavailable or rejected exact sessions
return `recipient_unavailable` while scoped recovery data remains durable.
Principal targets retain asynchronous store-and-forward semantics.
The JSON-encoded durable payload is limited to 65,536 UTF-8 bytes (64 KiB).
Native delivery separately limits the complete envelope, including routing
metadata and payload, to 16,384 bytes (16 KiB). Fitting the durable limit does
not guarantee that a native envelope fits; exact-session messages should stay
comfortably below the native cap.
The size failure is permanent for that exact envelope and is reported as
`native_message_too_large`, so callers do not retry it as transient session
unavailability.
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
envelope capped at 16,384 bytes (16 KiB), including routing metadata and payload.
The separate durable JSON-encoded payload limit is 65,536 bytes (64 KiB). The exact-session sender returns
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
registration is a warning: durable MCP/inbox messaging can still work, while
live Channel notification remains inactive until the upstream research-preview
channel is explicitly opted into. A malformed, stale, or insecure target is
also a warning. `CONFIGURED` means only that the declaration and target are
coherent; it does not verify development-channel admission or that an agent
surfaced the notification.

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
- `send` creates one canonical message, recipient delivery, and payload-free notification event under an idempotency key. Exact-session success additionally requires native host acceptance; an oversized envelope returns `native_message_too_large`, while other unavailable or rejected sessions return `recipient_unavailable`, with recovery state preserved.
- `poll` and `memesh message watch` return only events for the exact project and recipient. They are compatibility and diagnostic paths; the opaque cursor can be persisted and reused after a timeout, dropped hint, duplicate delivery, or process restart.
- `fetch` returns the payload only to the named recipient and matching `target_kind` in the named project. Exact-session messages require `target_kind=session`; polling and fetching do not acknowledge the message.
- `intake`, `ack`, `disposition`, and `activation` are explicit, separate, idempotent receipt facts. Inbox/MCP ACK is valid without a host-native acceptance; host-native ACK remains bound to its `host_accept`. `receipts` returns one ordered projection and identifies each underlying fact source. For example, `manual_resume_required` does not imply ACK, acceptance, rejection, cancellation, or completion.
- The transport, rather than model-provided payload data, records sender-host provenance.

## Repeatable owner-run live checks

Everything above is checked by the test suite against stubs and fakes. That
proves the plumbing and nothing about a live model: a queue admission or a
`host_accept` is a statement about a frame, not about cognition. Two checks
close that gap by requiring evidence that could only have come out of a running
model.

```bash
TMPDIR=/private/tmp npm run qa:live-journey -- --host codex  --out codex-report.json
TMPDIR=/private/tmp npm run qa:live-journey -- --host claude --out claude-report.json
```

`TMPDIR` is not decoration on macOS. The router's Unix socket lives beside the
database inside the temporary directory, and `AF_UNIX` caps a socket path at
104 bytes; the platform default `os.tmpdir()` spends about half of that before
the check adds anything. The script measures its own socket path and refuses
with this hint rather than starting a router that cannot bind.

`scripts/qa/live-journey.mjs` is owner-run and refuses to start when `CI` is
set, because neither check can run unattended: one needs the owner's Codex
login, the other needs a person at an interactive Claude session. Its argument
parsing, its refusals, and every **pure** assertion it makes are unit-tested in
`tests/qa/live-journey.test.ts`, which does run in CI against recorded
fixtures; the orchestration around them is exercised only by a live run.

Everything MeMesh writes goes into a fresh `mktemp` MEMESH_DIR that is deleted
on exit (`--keep` retains it), against this repository's own `dist/`. The check
refuses to start if that directory would resolve inside `$HOME/.memesh` — the
comparison is made on **real** paths, before anything is created, so a
symlinked `TMPDIR` cannot get past it — or if `dist/` has not been built. It
reads no authentication file. Where that isolation stops is listed under
limitations below, and the report records whether the working tree was dirty
and whether `dist/` predates the newest file under `src/`.

Shutdown order is part of the design rather than an afterthought. A connected
host that sees the router socket disappear starts a **detached** packaged
router inheriting its own environment — including this check's `MEMESH_DIR` —
and the router recreates its data directory on start. The check therefore stops
the companion, waits for live sessions to disconnect, stops the router, and
only then removes the directory; if a session is still connected when the wait
expires it keeps the directory rather than racing that spawn. The same sequence
runs on failures and on `SIGINT`/`SIGTERM`.

**`--host codex`** starts the router, runs `memesh agent setup codex-session`,
creates one real Codex CLI thread with `codex exec`, registers that thread,
sends one exact-session message, and then resumes the thread with a fixed
prompt that names neither the sentinel nor any identifier. The reply must quote
the envelope's `message_id` and `delivery_id` back, **and** that turn must have
produced nothing but an answer. Both halves matter: a `read-only` Codex sandbox
still permits reads, so a turn that ran one command could have taken the
identifiers off disk instead of out of the envelope. The Codex workspace is a
separate temporary tree for the same reason — the database and this run's own
logs are not one `..` away from it. The check then stops the companion and requires the next send to return
`recipient_unavailable` while `message fetch` still returns the payload.

**`--host claude`** starts the router, runs `memesh agent setup claude`, writes
a temporary MCP config, and prints the exact interactive launch command — which
includes `--setting-sources ""` so that no user, project, or local settings
file is loaded. The operator runs it, confirms with `/mcp` and `/hooks` that
only the two servers from `--mcp-config` are present, and then types nothing. The check waits for the session to appear
in `message discover`, sends one exact-session message, and then waits for an
`intake` receipt on that message whose actor is that session — the model must
call `intake` itself, which is what makes the proof model-visible rather than
transport-visible. The operator is then asked to exit the session, and the same
fail-closed assertion runs.

Print mode (`claude -p`) is **not supported** and is deliberately not
exercised. A print-mode session does not surface `memesh-channel` notifications
to the model even when the channel host reports the frame accepted, so it can
never produce the receipt this check requires.

Each run writes a JSON report: the repository revision, every `message_id` and
`delivery_id`, the `native_delivery` receipts, the model-visible evidence, and
a `limitations` list. The exit code is 0 only when every required step passed.
The limitations these checks always declare:

- The Codex **registration** half is harness-driven: the check drives the
  shipped `src/host-runtime/codex-session.ts` companion directly with the
  `SessionStart` payload the packaged plugin hook supplies, because a scripted
  `codex exec` turn was not observed to register anything on its own. *Why* the
  plugin hook does not run there is not established — `--ignore-user-config` is
  documented only as skipping `config.toml`, and on a machine whose
  `~/.memesh/hosts` has no `codex-session.json` the shipped companion would
  return early regardless. Dispatch → `codex queue` → model-visible reply is
  product-path evidence; the registration step is not.
- The interactive Claude session is **outside** this check's isolation.
  `--setting-sources ""` is accepted by the CLI (an invalid source name is
  rejected, an empty list is not), but it is not verified to exclude
  plugin-provided hooks or MCP servers. A MeMesh plugin hook running in that
  session inherits no `MEMESH_DIR` and would write the owner's real
  `~/.memesh`. The operator is told to confirm with `/mcp` and `/hooks` first,
  and the check cannot observe whether they did.
- `--host codex` creates one throwaway thread in the owner's Codex rollout
  store and queues one message into it. That is session state, not
  configuration; nothing outside the temporary directory is otherwise written.
- The Claude operator is told to type nothing, but the check cannot observe
  whether anything was typed. The intake receipt proves the model called
  `intake` in that session; it does not prove it did so unprompted.
- The Claude intake receipt is matched on its `actor`, which `intake` sets from
  the caller's `recipient`. The model must intake under its own session id; an
  intake recorded against the principal id would not match, and the check would
  report no model-visible proof.
- `recipient_unavailable` is a shared failure surface — the same string is
  returned when the *sender* cannot reach the router. The fail-closed step
  therefore also records that `message discover` still answered and that
  `message fetch` still returned the payload. That pairing, not the string, is
  what attributes the failure to the stopped recipient.

## Scope identifiers

`project` and `recipient` together key one inbox, and `actor` is derived from
`recipient`, so how those three are spelled is part of the contract rather than
a formatting detail. Two spellings of one name are two inboxes: the recipient
that fetches under one never sees what was sent under the other, and a
`briefing` unread count is computed per spelling.

Every message action canonicalises them to Unicode NFC and trims surrounding
whitespace, on reads as well as writes, so a decomposed spelling reaches the
rows a composed one wrote.

A value spelled as an **absolute filesystem path is refused** — a POSIX path
(`/root`), a Windows drive path (`C:\work`), or a UNC path (`\\host\share`).
Project identity is derived from the working directory and can never take that
shape, so such a value is not an identity MeMesh produced; the error names the
field and a valid value. Callers that previously passed a home directory or a
checkout path where the agent's or project's NAME belonged must pass the name.
Nothing else is rewritten: identifiers are compared exactly, case included, and
an identifier that merely contains a separator (`team/reviewer`) is accepted.
MeMesh does not treat any prefix as a namespace, so `claude-code:reviewer` and
`reviewer` are two different recipients.

The same rule covers every surface that reads or writes that key, not only the
`message` tool: `briefing` counts unfetched deliveries for one exact
(`project`, `recipient`), and `memesh agent setup --project/--principal` writes
the identity a host will register under. A path-shaped value is refused there
too, at the moment the config is written, rather than surfacing later as an
error about some other agent's send.

`sender` is not covered by any of this. It is provenance rather than routing —
it keys no inbox, and it keys the send idempotency record — so it is stored
exactly as given, and the transport-bound provenance remains the field to trust.

Rows written before this rule are repaired once, in place, at the first
database open after upgrade. Renaming a project across both its entity tags and
its message scopes is a separate, deliberate, owner-run operation:

```bash
memesh kg rename-project --from <old> --to <new>          # dry run
memesh kg rename-project --from <old> --to <new> --apply  # backs up first
```

## Identity and lifecycle

A **principal** is the stable logical recipient. A **session** is one live host connection for that principal. A **generation** changes when that session is replaced. An exact-session target never reroutes. A principal target can deliver only to an eligible active session after its activation checkpoint; it does not replay historical inbox contents into a first session.

Persistence, dispatch attempt, host acceptance, intake, acknowledgement,
workflow disposition, retention, and presence are independent state axes. An
active configured exact session receives a bounded full message without
polling or an inbox fetch. An oversized full envelope returns
`native_message_too_large`. A stopped, missing, busy beyond its queue limit,
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
| Ordinary Codex CLI | `codex-session` owner-private opt-in | bounded full-message native delivery while active | Exact workspace, principal, and SessionStart identity must match; oversized envelopes return `native_message_too_large`, while stopped or disconnected sessions return `recipient_unavailable` |
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
