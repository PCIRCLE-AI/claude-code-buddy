# MeMesh memory provider

Local-first knowledge-graph memory for Hermes Agent, backed by
[MeMesh](https://github.com/PCIRCLE-AI/memesh) (`memesh serve`, HTTP API,
default `http://localhost:3737`).

## Setup

1. Install MeMesh globally: `npm install -g @pcircle/memesh` (requires Node >= 22).
   If your global npm prefix isn't user-writable, configure a user-owned one
   (e.g. `npm config set prefix ~/.npm-global`) and make sure the resulting
   `bin/` directory is on `PATH` — including in whatever process manager
   supervises Hermes (a systemd user service's `Environment=PATH=...` does
   **not** inherit your shell's `PATH`; this is the most common cause of
   `is_available()` reporting `false` even though `memesh --version` works
   fine interactively).
2. Run `memesh serve` as a persistent process. A systemd user service is
   recommended for anything beyond local experimentation — `Restart=always`
   so it survives crashes, ordered `After=network.target`.
3. Activate this provider: set `memory.provider: memesh` in
   `$HERMES_HOME/config.yaml` (or `hermes memory setup` once memesh is
   registered in the provider catalog).

No secrets are required for a local loopback deployment — MeMesh does not
require a bearer token when bound to `localhost`.

## Config

`$HERMES_HOME/memesh.json` (optional, written by `save_config`):

```json
{
  "base_url": "http://localhost:3737"
}
```

## Behavior

- `prefetch()` / `queue_prefetch()`: recalls up to 5 relevant entities via
  `POST /v1/recall` before each turn, injected as context.
- `sync_turn()`: stores each completed turn as a `conversation` entity via
  `POST /v1/remember`, tagged `platform:hermes`, in a background thread.
  Skipped for non-`primary` agent contexts (cron, subagents, flush) so
  automated jobs don't pollute long-term memory.
- Tools: `memesh_remember`, `memesh_recall`, `memesh_forget` — exposed for
  explicit LLM-directed memory management on top of the automatic hooks.
- `on_pre_compress()` / `on_session_end()`: archive the tail of the
  conversation to MeMesh at a compression or session boundary — this is
  what keeps context that survives a Telegram-style auto-reset recallable
  instead of lost. Both run **synchronously** (unlike `sync_turn()`): they
  fire once per session/compression, immediately before the host calls
  `shutdown()` and closes the shared HTTP client, so a fire-and-forget
  background thread here reliably loses that race (`[Errno 9] Bad file
  descriptor` in testing) — don't "fix" this back to async.
- `on_session_switch()`: keeps the cached `session_id` current across
  `/reset`, `/resume`, `/branch`, and context-compression session rotation,
  so memories written after a switch aren't mistagged with the pre-switch
  session id.

## Known upstream discrepancy

`POST /v1/recall`'s `data` field is documented in MeMesh's own
`docs/api/API_REFERENCE.md` as an object (`{"entities": [...]}`), but the
live HTTP response (confirmed against MeMesh 4.5.1) returns `data` as a bare
array of entities directly. This plugin handles both shapes defensively.
Tracked upstream: https://github.com/PCIRCLE-AI/memesh/issues/159
