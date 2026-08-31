# Installing MeMesh — deterministic steps for an AI agent

This document is for an AI agent installing MeMesh (`@pcircle/memesh`) on its
user's machine. Execute each section exactly, verify with the stated check,
then stop. Once installed, read [AGENTS.md](AGENTS.md) for how to use it.

Facts that hold for every path below:

- Every host reads and writes the **same database**: `~/.memesh/knowledge-graph.db`.
  Installing for a second host adds an access path, not a second memory.
- **Nothing is auto-configured beyond what each step states.** `npm install -g`
  runs **no install scripts** — the package has none, by design (it installs
  fully working even under `--ignore-scripts`). Nothing registers MCP servers
  except the per-host commands in this document.
- Where a host asks for a configured MCP command, use `memesh-mcp` —
  **never `npx -p @pcircle/memesh`**. `npx -p` resolves to the *local* package
  whenever the host's working directory is inside a checkout of this
  repository, silently running that working tree instead of the installed
  release.

## 1. Claude Code (plugin)

Type these in Claude Code's **chat input** — they are Claude Code slash
commands, not shell commands:

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Claude Code wires the MCP server, the auto-capture hooks, and the `/memesh`
skill automatically.

**Verify**: restart Claude Code. A status line beginning `◉ MeMesh` appears at
the top of the next session.

| Failure | Remedy |
|---|---|
| `/plugin marketplace add` fails | The marketplace is fetched as a git clone. Check `git --version` succeeds and github.com is reachable. |
| `/plugin install` says plugin not found | The argument is exactly `memesh@pcircle-memesh` — plugin name `memesh`, marketplace name `pcircle-memesh`. Re-run the marketplace add first. |
| No `◉ MeMesh` line after restart | Run `/plugin` inside Claude Code and confirm the `memesh` plugin is installed and enabled, then restart again. |

The plugin does **not** put a `memesh` command on the shell PATH. For terminal
use — and as a prerequisite for sections 3 and 4 — also do section 2. The two
installs coexist and share the database.

## 2. Terminal / CLI (npm global)

Check Node **first** — the floor is 22.13.0 (`node:sqlite` is part of Node
itself; npm only warns on an engine mismatch, so an install onto an old Node
"succeeds" and fails later at runtime):

```
node --version
```

Expected: `v22.13.0` or later. If lower, stop and upgrade Node before
continuing.

```
npm install -g @pcircle/memesh
```

After installation, run `memesh doctor`. To probe the **installed** message MCP plus its bundled host-adapter imports (rather than only checking a manifest hash), opt in explicitly:

```
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
```

This probe does not exercise a real host session and never wakes a stopped
session. The ordinary Codex path below is the documented native local wakeup
path; `poll`/`watch` and cursor recovery remain available for compatibility and
diagnosis.

Message storage remains owner-controlled. There is no default quota or
automatic pruning. To inspect it after installation:

```bash
memesh message storage report --cutoff 2026-08-01T00:00:00Z
memesh message storage prune --cutoff 2026-08-01T00:00:00Z --batch-size 100
```

The prune command is a dry-run unless `--apply` is supplied. Only old terminal
payload content is tombstoned; unresolved/offline-pending messages and all
lifecycle audit facts are preserved. Set an explicit hard quota for all send
transports with `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES=<bytes>`; an
over-quota send is rejected atomically.

### Optional: one-time local host setup

This is separate from MCP setup. It is for the owner of an active local Codex
session, a MeMesh-managed Codex app-server, or a Claude channel. Keep all
files private to that Unix account; do not commit the token or config files.
This secure host-native runtime currently supports macOS and Linux. Windows
can still use core MeMesh, durable messages, and MCP tools, but not this
host-native wakeup path.

Each configured host connection starts the packaged router and retries its
connection when the owner-private socket is absent or refused. Start the router
yourself only when you want to inspect the socket directly:

```bash
umask 077
memesh-router
```

If you start it yourself, it creates `agent-router.sock` and `agent-router.token` beside the active
MeMesh database (normally `~/.memesh/`) with owner-private permissions. Check
the installed adapter imports and the live socket as distinct facts:

```bash
MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 memesh doctor
MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 memesh doctor
```

The router probe does not register a host, send content, or wake a stopped
session. Generate reusable `0600` configs; session identities are not copied
from an active ordinary session.

For an ordinary active local Codex session, first install and enable the MeMesh
Codex plugin (Option A), which supplies the packaged SessionStart hook. Then
run this from the exact workspace you want to configure and restart Codex in
that same workspace:

```bash
memesh agent setup codex-session --project my-project --principal codex-recipient --workspace "$PWD"
```

This stores the configured workspace realpath and principal in
`~/.memesh/hosts/codex-session.json`. On `SessionStart` (`startup` or
`resume`), an asynchronous companion registers only when its Codex thread ID,
hook session ID, and workspace realpath match that config. It receives no
message payload. Instead, an active registered session receives a
metadata-only `memesh_message_available` queue marker with routing identifiers,
then uses the scoped `message` `fetch` operation to read the durable payload.

`host_accept` records only that the local Codex queue accepted that marker. It
does not prove an agent read the payload, acknowledged it, or accepted the
work. If the session is stopped, missing, disconnected, or in another
workspace, MeMesh neither starts nor replaces it; the durable inbox remains
available to scoped fetch, cursor recovery, `poll`, and `memesh message watch`
for audit and diagnosis.

The following are separate managed-host paths:

```bash
memesh agent setup codex --project my-project --principal codex-recipient --workspace "$PWD"
memesh-host-codex --config "$HOME/.memesh/hosts/codex.json"

memesh agent setup claude --project my-project --principal claude-recipient
# Run the printed `registration_command` (`claude mcp add ... memesh-host-claude ...`) once.
# Start each participating session with the printed research-preview launch command:
claude --dangerously-load-development-channels server:memesh-channel
```

The managed Codex runner owns its app-server and thread; Claude owns its
Channel MCP child. Neither is the ordinary Codex-session path, and neither
attaches to, resumes, or replaces an ordinary stopped host. When no active
registration exists, the message remains durable with no false dispatch or
host acceptance. The package also contains the experimental
`memesh-host-acp` binary for protocol development, but no ACP provider is a
documented native-wakeup integration here.

Expected: exits without error; `memesh`, `memesh-mcp` and `memesh-http` are
now in `$(npm prefix -g)/bin/`. No compiler is involved and no install script
runs.

**Verify**:

```
memesh doctor
```

Expected: a report starting `MeMesh doctor v…` with `Overall: PASS`
(`PASS_WITH_CONCERNS` is also functional), exit code 0.

| Failure | Remedy |
|---|---|
| `command not found: memesh` | npm's global bin dir is not on PATH. Run `npm prefix -g`, append `/bin` to its output, and add that directory to PATH. |
| `No such built-in module: node:sqlite` | The running Node is older than 22.13.0. Upgrade Node, then re-run `memesh doctor`. |
| `EACCES` during `npm install -g` | The global prefix is not user-writable. Use a user-level Node (nvm/fnm), or `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to PATH, then re-install. |
| `Overall: FAIL` (exit code 1) | The report names the failing check and prints the fix next to it. Apply that fix and re-run `memesh doctor`. |

Only if Claude Code is used **without** the section-1 plugin (the plugin wires
hooks itself — skip this if section 1 is done):

```
memesh install-hooks
memesh doctor
```

## 3. Codex CLI

Prerequisite: section 2 — `memesh-mcp` must resolve on PATH.

```
codex mcp add memesh -- memesh-mcp
```

Writes `[mcp_servers.memesh]` into `~/.codex/config.toml`.

**Verify**:

```
codex mcp list
```

Expected: `memesh` is listed as enabled.

### Optional: Codex plugin marketplace

Current Codex CLI versions can install the repository's plugin marketplace
directly. For a fresh install:

```
codex plugin marketplace add PCIRCLE-AI/memesh
codex plugin add memesh@pcircle-memesh
```

If the configured marketplace snapshot is stale, refresh it and reinstall the
plugin:

```
codex plugin marketplace upgrade pcircle-memesh
codex plugin remove memesh
codex plugin add memesh@pcircle-memesh
```

These commands are separate from the MCP registration above; keep the MCP
path when a host needs `memesh-mcp` directly.

| Failure | Remedy |
|---|---|
| `command not found: codex` | Codex CLI itself is not installed — out of scope here; install it first, then re-run the add. |
| `memesh` absent from the list | The add did not persist. Re-run `codex mcp add memesh -- memesh-mcp` and re-check. |
| Listed, but tool calls fail | Run `command -v memesh-mcp`. Empty output means section 2 is incomplete or PATH is wrong — fix per section 2's table. |

## 4. Cursor

Prerequisite: section 2 — `memesh-mcp` must resolve on PATH.

For a personal server available in every Cursor project, create or edit
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memesh": {
      "command": "memesh-mcp"
    }
  }
}
```

For one project only, use the same entry in that project's `.cursor/mcp.json`.
Restart Cursor, then open Cursor's MCP settings and confirm that `memesh` is
connected. If the Cursor Agent CLI is installed, `cursor-agent mcp list` also
shows the configured server.

| Failure | Remedy |
|---|---|
| `memesh` is disconnected | Run `command -v memesh-mcp`. Empty output means section 2 is incomplete or PATH is not visible to Cursor. |
| Cursor cannot start the server | Use the absolute path returned by `command -v memesh-mcp` as `command`, then restart Cursor. |
| Tools are missing | Confirm the `mcpServers.memesh` entry is valid JSON and that the server is configured as a local stdio command, not an HTTP URL. |
