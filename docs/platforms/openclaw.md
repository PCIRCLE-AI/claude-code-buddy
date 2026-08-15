# MeMesh With OpenClaw

OpenClaw has a **first-party, documented plugin system for memory capabilities** — `api.registerMemoryCapability()` with contract-based registration via `openclaw.json`, activated through `plugins.slots.memory`. This is not a generic HTTP/CLI bridge: OpenClaw ships with LanceDB as a reference memory provider (`@openclaw/memory-lancedb`), and MeMesh can be added as an alternative, with automatic per-turn recall/write — no core OpenClaw file needs editing.

This guide is written from confirmed upstream OpenClaw documentation (docs.openclaw.ai) and the shipping LanceDB reference plugin at `https://github.com/openclaw/openclaw/blob/main/extensions/memory-lancedb/index.ts`. It has NOT been built or verified live (unlike the Hermes Agent integration, which was deployed and tested end-to-end) — treat this as the confirmed CONTRACT for implementation, not a battle-tested deployment guide.

## Why this is a good fit

- OpenClaw's `before_prompt_build` hook maps directly onto MeMesh's `POST /v1/recall` — auto-recall fires on the latest user message before the prompt is built, exactly like Hermes's `prefetch()`.
- Tool surface (`memory_recall`, `memory_store`, `memory_forget`) maps cleanly onto `/v1/recall`, `/v1/remember`, `/v1/forget`.
- MeMesh's loopback-only auth model (no bearer token required for `localhost`) matches OpenClaw's local-first deployment pattern with zero secret management.
- Installation is npm-based (`openclaw plugins install <package>`), auto-assigns to the memory slot — same dev experience as OpenClaw's own first-party plugins.

## Key difference from Hermes Agent: threshold-gated auto-capture

**CRITICAL**: OpenClaw's auto-capture is **trigger-phrase + character-threshold gated** (configured via `autoCapture`, caps at 3 memories/turn), NOT "every turn" like Hermes's `sync_turn()`.

Do NOT blindly port the Hermes plugin's "write every turn" assumption — that exact pattern caused a real bug in the Hermes build (see lesson `lesson-ktseng-bea7afee-other` in MeMesh's knowledge graph) where an over-eager memory-management `system_prompt_block()` prompt caused the model to also rewrite Hermes's built-in `USER.md` file as an unintended side effect.

For OpenClaw, decide deliberately:
- **Mirror OpenClaw's threshold-gated model**: only capture when the user message meets `autoCapture` criteria (trigger phrase present + character threshold exceeded). Safer, matches LanceDB's behavior.
- **Go for Hermes's every-turn model**: capture every turn unconditionally via a `POST /v1/remember` call. Riskier prompt-engineering surface — test A/B (plugin on vs off, same query) to verify you're not triggering unintended file rewrites in OpenClaw's built-in memory files.

## The plugin shape

```
extensions/memory-memesh/   (or publish as @yourorg/openclaw-memory-memesh)
├── index.ts                # Plugin entry, implements definePluginEntry()
├── api.ts                  # OpenClaw plugin API types (if not importing from SDK)
├── config.ts               # Config schema, defaults
├── package.json            # npm package metadata
└── README.md
```

Minimum viable exports (all required by the OpenClaw plugin contract):

| Component | MeMesh call | Notes |
|---|---|---|
| `definePluginEntry({ id, name, description, kind: "memory", configSchema, register })` | — | Entry point exported as `default`. `kind: "memory"` declares the memory-capability contract. |
| `register(api: OpenClawPluginApi)` | — | Called at plugin load. Register tools, hooks, and call `api.registerMemoryCapability?.()`. |
| **Config schema** (TypeBox `Type.Object()`) | — | At minimum: `baseUrl` (default `http://localhost:3737`), optionally `autoCapture`/`autoRecall` booleans. |
| **Tool: `memory_recall`** | `POST /v1/recall` | Search. Param: `query` (string), `limit` (optional int, default 5). Return: `{ content: [{type:"text", text:"..."}], details: {count: N} }`. On empty: `"No relevant memories found."` |
| **Tool: `memory_store`** | `POST /v1/remember` | Persist. Params: `text` (required), `category` (optional, default `"note"`), `importance` (optional, 1-10). Reject if `looksLikePromptInjection(text)`. |
| **Tool: `memory_forget`** | `POST /v1/forget` | Delete. Param: `query` (string for semantic search, or accept `id` if MeMesh's `/v1/forget` supports ID-based delete). |
| **Hook: `api.on("before_prompt_build", ...)`** | `POST /v1/recall` | Automatic recall. Extract `extractLatestUserText(event.messages)`, normalize query, embed + search, inject top-N (default 3) into prompt context. Guard on `autoRecall` config. Skip on cooldown (if recall timed out recently). |
| *(Optional)* **Hook: after-turn capture** | `POST /v1/remember` | Only if mirroring OpenClaw's auto-capture. Gate on `autoCapture` config, trigger-phrase detection, character threshold. Cap at 3/turn. Sanitize (`sanitizeForMemoryCapture`, `dropMediaNoteLines`) before sending. |

## Configuration shape

Minimal example (user's `openclaw.json`):

```json
{
  "plugins": {
    "slots": {
      "memory": "memesh"
    },
    "entries": {
      "memesh": {
        "config": {
          "baseUrl": "http://localhost:3737",
          "autoRecall": true,
          "autoCapture": false
        }
      }
    }
  }
}
```

- `plugins.slots.memory: "memesh"` selects this plugin as the exclusive active memory provider.
- `plugins.entries.memesh.config` holds provider-specific settings.
- Set `autoCapture: false` initially to avoid the over-eager-write pattern; enable only after A/B testing confirms no unintended side effects on OpenClaw's built-in memory files.

## Installation (once published as an npm package)

```bash
openclaw plugins install @yourorg/openclaw-memory-memesh
# Auto-assigns to the memory slot.

# Verify:
openclaw memory status   # (if OpenClaw CLI exposes this)
```

Or manually: drop `extensions/memory-memesh/` into an OpenClaw checkout, add to `openclaw.json` as shown above.

## Tool implementation notes (from LanceDB reference)

1. **Timeout + cooldown**: Recall embedding should timeout after ~15s. On timeout, enter a cooldown (60s) to avoid stalling subsequent turns. LanceDB reference uses `runWithTimeout()` + `readMemoryRecallCooldown()` / `recordMemoryRecallCooldown()`.

2. **Over-fetch + filter**: Auto-recall should over-fetch (e.g., 10 results) from MeMesh, filter out any contaminated memories (prompt injection, envelope sludge), then cap the surviving results (e.g., 3) before injecting into the prompt. This keeps prompt-budget impact bounded.

3. **Prompt injection defense**: `memory_store` must reject if `looksLikePromptInjection(text)` returns true. LanceDB's definition: text that contains directives ("ignore previous", "disregard", "new instructions", etc.). Adapt or copy LanceDB's `looksLikePromptInjection()` implementation.

4. **Sanitization**: Before calling `POST /v1/remember`, run `sanitizeForMemoryCapture(text)` and `dropMediaNoteLines(text)` (from LanceDB's `memory-capture-sanitization.ts`). These strip media annotations and other non-semantic noise that degrades recall quality.

5. **Error handling**: If `POST /v1/recall` returns HTTP 500 or times out, return `{ content: [{type:"text", text:"Memory recall unavailable: <reason>"}] }` instead of throwing — a recall failure should not crash the turn.

## Pitfalls

1. **Don't over-encourage memory management in the prompt.** The LanceDB reference plugin does NOT inject a system_prompt_block() at all — tools are exposed, auto-recall happens silently, and the LLM only sees tool results when recall actually fires or when it explicitly calls a tool. If you do add a system prompt, keep it minimal and passive: "Memory recall happens automatically; explicit tools are a backstop for narrow lookups." Avoid "use the tools to manage memory" phrasing — that exact wording caused a real bug in the Hermes integration where the model also rewrote Hermes's built-in `USER.md` file as an unintended side effect.

2. **Test auto-capture with A/B comparison.** If enabling `autoCapture`, run the SAME query with the plugin fully disabled and verify that no OpenClaw built-in memory files (`AGENTS.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md`) are mutated. If they are, the capture logic or prompt is over-eager — dial it back or disable auto-capture entirely and rely only on auto-recall + explicit tools.

3. **OpenClaw imports are monorepo-internal.** The plugin imports from `openclaw/plugin-sdk/runtime-env`, `openclaw/plugin-sdk/config-contracts`, etc. — these are NOT published as a separate `@openclaw/plugin-sdk` npm package. The SDK is part of the main `openclaw/openclaw` monorepo. If publishing your plugin externally, it must declare `openclaw` as a `peerDependency` so the imports resolve at runtime.

4. **MeMesh HTTP API quirk (issue #159, CLOSED).** Early versions of MeMesh returned `POST /v1/recall` as `{success: true, data: [...]}` (a bare array) instead of the documented `{entities: [...]}` object envelope. This was fixed, but if supporting older MeMesh versions, add a defensive check: `const entities = response.entities ?? response.data ?? []`.

## Recommended platform-table entry

| Client | Best Mode | Setup | Guide |
|--------|-----------|-------|-------|
| **OpenClaw** | Native memory plugin | `openclaw plugins install <package>` (once published), or drop `extensions/memory-memesh/` into OpenClaw checkout; configure `plugins.slots.memory: "memesh"` in `openclaw.json` | This page |

Unlike the HTTP-only platforms in this directory, OpenClaw should get listed as a **native integration**, same tier as Hermes Agent and MCP mode for Claude Code — the plugin, once written, behaves exactly like OpenClaw's own first-party providers, discoverable and configurable through OpenClaw's own plugin system.

## Reference implementation

The official LanceDB memory plugin (`@openclaw/memory-lancedb`) is the canonical reference: https://github.com/openclaw/openclaw/blob/main/extensions/memory-lancedb/index.ts (711 lines, full production implementation with error handling, timeouts, cooldowns, sanitization, prompt-injection defense, and CLI commands). Copy its structure and adapt the vector-DB calls to MeMesh's HTTP API.

## Status

**Contract confirmed, implementation NOT yet built.** This guide documents the confirmed plugin contract from upstream OpenClaw docs and the LanceDB reference plugin. Unlike the Hermes Agent integration (which was built, deployed to dgx94, and verified end-to-end with cross-session automatic recall), this has not been tested live. Treat as the blueprint for implementation, not a battle-tested deployment guide.

The next implementer should:
1. Build the plugin following this spec.
2. Test with `autoCapture: false` first (auto-recall only, explicit tools as backstop).
3. Run A/B comparison (plugin on vs off, same query) to verify no unintended mutations to OpenClaw's built-in memory files.
4. Only enable `autoCapture` after confirming step 3 passes cleanly.
5. Update this document with deployment notes, actual installation commands, and any discovered pitfalls.
