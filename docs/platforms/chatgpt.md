# MeMesh With ChatGPT / Custom GPTs

ChatGPT can use MeMesh only when you provide a connector, action, proxy, or local bridge that can call your MeMesh HTTP server. Custom instructions alone cannot make ChatGPT call `localhost`.

## Supported Shape

Use this guide when you control one of these:

- A local app or script that calls both ChatGPT and MeMesh
- A Custom GPT Action exposed through a reachable HTTPS endpoint
- A private proxy/tunnel that forwards approved requests to local MeMesh

If you only use the normal ChatGPT web UI with custom instructions, MeMesh can still be used manually through the CLI, but ChatGPT will not call the API by itself.

## Start MeMesh

```bash
npm install -g @pcircle/memesh
memesh serve
```

Default endpoints:

```text
API:       http://localhost:3737/v1
Dashboard: http://localhost:3737/dashboard
```

Verify:

```bash
curl http://localhost:3737/v1/health
```

## HTTP Operations

Remember:

```bash
curl -X POST http://localhost:3737/v1/remember \
  -H "Content-Type: application/json" \
  -d '{
    "name": "database-decision",
    "type": "decision",
    "observations": ["Use PostgreSQL for ACID transactions"],
    "tags": ["project:myapp", "topic:database"]
  }'
```

Recall:

```bash
curl -X POST http://localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"database decisions","limit":5}'
```

Learn from a bug:

```bash
curl -X POST http://localhost:3737/v1/learn \
  -H "Content-Type: application/json" \
  -d '{
    "error": "API timeout",
    "fix": "Increased connection pool size",
    "rootCause": "Pool exhaustion",
    "severity": "major"
  }'
```

## Connector Prompt

Use this with your local bridge or Custom GPT Action:

```markdown
You have access to MeMesh persistent memory through an HTTP connector.

Use memory for:
- architecture decisions and rationale
- bug fixes, root causes, and prevention notes
- project conventions and coding patterns
- user preferences that should persist

Before answering project-specific questions, recall relevant memories.
After important decisions, fixes, or lessons, store concise memories with tags such as project:<name>, topic:<area>, and tech:<tool>.
Do not invent memory results. If the connector is unavailable, say so and continue without memory.
```

## Security Notes

- Do not expose `memesh serve` directly to the public internet.
- Put authentication in front of any HTTPS bridge or tunnel.
- Keep MeMesh local unless you intentionally build a controlled proxy.

See [Universal Integration Guide](./universal.md) and [API Reference](../api/API_REFERENCE.md).
