# MeMesh Universal Integration Guide

Use MeMesh with any local app, script, or AI client that can call HTTP endpoints or run CLI commands.

## Install

```bash
npm install -g @pcircle/memesh
```

## Option A: HTTP API

Start the server:

```bash
memesh serve
```

Default base URL:

```text
http://localhost:3737
```

Health check:

```bash
curl http://localhost:3737/v1/health
```

Remember:

```bash
curl -X POST http://localhost:3737/v1/remember \
  -H "Content-Type: application/json" \
  -d '{
    "name": "project-decision-2026",
    "type": "decision",
    "observations": ["We chose PostgreSQL"],
    "tags": ["project:myapp", "topic:database"]
  }'
```

Recall:

```bash
curl -X POST http://localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"database decisions","limit":5}'
```

Learn from a fix:

```bash
curl -X POST http://localhost:3737/v1/learn \
  -H "Content-Type: application/json" \
  -d '{
    "error": "API timeout",
    "fix": "Increased connection pool",
    "rootCause": "Pool exhaustion",
    "severity": "major"
  }'
```

Archive:

```bash
curl -X POST http://localhost:3737/v1/forget \
  -H "Content-Type: application/json" \
  -d '{"name":"outdated-decision"}'
```

## Option B: CLI

Use this when your workflow can run shell commands:

```bash
memesh remember --name "test" --type note --obs "Hello World"
memesh recall "test" --json
memesh learn --error "CORS error" --fix "Added CORS middleware" --root-cause "Missing headers"
```

## Option C: MCP

Use MCP mode for clients that support Model Context Protocol:

```bash
memesh-mcp
```

Add that command to your MCP client's server configuration.

## Prompt Template For Custom Integrations

```markdown
You have access to MeMesh persistent memory through the host application.

Use recall before project-specific work where prior decisions, bug fixes, or conventions may matter.
Use remember for durable decisions, architecture choices, project conventions, and recurring patterns.
Use learn for mistakes, root causes, fixes, and prevention notes.
Keep memories concise. Include tags such as project:<name>, topic:<area>, and tech:<tool>.
Do not claim memory was checked or written unless the tool/API call succeeded.
```

## Operational Notes

- Default database: `~/.memesh/knowledge-graph.db`
- Default HTTP host: `127.0.0.1`
- Default HTTP port: `3737`
- Dashboard: `http://localhost:3737/dashboard`
- API docs: [API_REFERENCE.md](../api/API_REFERENCE.md)

## Troubleshooting

Connection refused:

```bash
memesh serve
curl http://localhost:3737/v1/health
```

Port conflict:

```bash
MEMESH_HTTP_PORT=8080 memesh serve
```

No memories found:

```bash
memesh remember --name test --type note --obs "Hello"
memesh recall "test"
```
