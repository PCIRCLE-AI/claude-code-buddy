# MeMesh With Google Gemini

Gemini can use MeMesh when your application code or local bridge calls the MeMesh HTTP API. Gemini web or AI Studio system instructions alone do not automatically call `localhost`.

## Supported Shape

Use this guide when you control one of these:

- A Gemini API application
- A local tool wrapper around Gemini
- A private connector/proxy that can reach local MeMesh

For direct Gemini web chat, use MeMesh manually through the CLI unless you have a connector.

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
    "name": "fastapi-backend-decision",
    "type": "decision",
    "observations": ["Use FastAPI for automatic OpenAPI docs"],
    "tags": ["project:api", "tech:fastapi", "topic:backend"]
  }'
```

Recall:

```bash
curl -X POST http://localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"backend framework","limit":5}'
```

## Gemini System Instruction

Use this in a Gemini API app that has tools or application code wired to MeMesh:

```markdown
You have access to MeMesh persistent memory through application-provided tools.

Recall relevant memories before making project-specific recommendations.
Store durable decisions, bug lessons, architectural constraints, and coding patterns.
Keep memories concise and tagged by project, topic, and technology.
If the memory connector is unavailable, do not pretend memory was checked.
```

## Minimal App Flow

1. User asks a project question.
2. Your app calls `POST /v1/recall` with the user's query.
3. Your app includes the returned memories in the Gemini request.
4. After Gemini identifies a durable decision or lesson, your app calls `POST /v1/remember` or `POST /v1/learn`.

See [Universal Integration Guide](./universal.md) and [API Reference](../api/API_REFERENCE.md).
