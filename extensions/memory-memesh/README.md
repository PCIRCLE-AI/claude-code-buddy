# MeMesh Memory Provider for OpenClaw

Native memory-capability plugin that integrates MeMesh's HTTP API as a first-party memory provider for OpenClaw.

## Status

**Contract confirmed, NOT yet tested live.** This implementation follows the confirmed plugin contract from upstream OpenClaw docs and the `@openclaw/memory-lancedb` reference plugin. Unlike the Hermes Agent integration (which was built, deployed to dgx94, and verified end-to-end), this has not been tested against a running OpenClaw instance.

## Installation

### Option 1: Install from npm (once published)

```bash
openclaw plugins install @pcircle/openclaw-memory-memesh
```

### Option 2: Manual installation

1. Clone this directory into an OpenClaw checkout:

```bash
cd <openclaw-repo>/extensions/
git clone https://github.com/PCIRCLE-AI/memesh.git memesh-plugin
cp -r memesh-plugin/extensions/memory-memesh ./memory-memesh
cd memory-memesh
npm install
npm run build
```

2. Configure in `openclaw.json`:

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

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | string | `http://localhost:3737` | MeMesh HTTP API base URL |
| `autoRecall` | boolean | `true` | Enable automatic recall on `before_prompt_build` |
| `autoCapture` | boolean | `false` | Enable automatic capture (EXPERIMENTAL) |
| `recallResultCap` | number | `3` | Max memories injected on auto-recall |
| `recallTimeoutMs` | number | `15000` | Recall operation timeout |
| `recallCooldownMs` | number | `60000` | Cooldown after recall failure |

**IMPORTANT**: Set `autoCapture: false` initially. Test with auto-recall only first, then run an A/B comparison (plugin on vs off, same query) to verify no unintended mutations to OpenClaw's built-in memory files before enabling auto-capture.

## Prerequisites

1. **MeMesh server running**:

```bash
npm install -g @pcircle/memesh
memesh serve --port 3737
```

2. **OpenClaw** (peer dependency):

The plugin imports from `openclaw/plugin-sdk/*` — these are part of the main `openclaw/openclaw` monorepo, not a separate package. Declare `openclaw` as a peer dependency.

## Tools Exposed

- **`memory_recall`** - Search through memories
  - Params: `query` (string), `limit` (optional, 1-20)
  - Maps to: `POST /v1/recall`

- **`memory_store`** - Store a new memory
  - Params: `text` (string), `category` (optional), `importance` (optional, 1-10)
  - Maps to: `POST /v1/remember`
  - Guards: Prompt injection defense (rejects suspicious patterns)

- **`memory_forget`** - Delete memories
  - Params: `query` (string)
  - Maps to: `POST /v1/forget`

## Auto-Recall Hook

Fires on `before_prompt_build`:
- Extracts latest user message
- Calls `POST /v1/recall` with normalized query
- Injects top-N results (default 3) as context
- Guards: cooldown on timeout (60s), skip if query too short

## Differences from Hermes Agent Integration

1. **Auto-capture is threshold-gated** (max 3/turn when triggered), not every-turn like Hermes's `sync_turn()`
2. **TypeScript** instead of Python
3. **HTTP client** instead of direct database access
4. **No system_prompt_block()** — tools are exposed, auto-recall happens silently (matches LanceDB reference)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Clean
npm run clean
```

## Safety Notes

1. **Test A/B before enabling auto-capture** — run the same query with the plugin fully disabled and verify no OpenClaw built-in memory files are mutated
2. **Prompt injection defense is active** — `memory_store` rejects text matching suspicious patterns
3. **Cooldown on failure** — if recall times out, auto-recall is disabled for 60s to avoid stalling subsequent turns

## Reference

- **Full integration guide**: [docs/platforms/openclaw.md](../../docs/platforms/openclaw.md)
- **LanceDB reference plugin**: https://github.com/openclaw/openclaw/blob/main/extensions/memory-lancedb/index.ts
- **MeMesh HTTP API**: [docs/api/API_REFERENCE.md](../../docs/api/API_REFERENCE.md)

## License

MIT
