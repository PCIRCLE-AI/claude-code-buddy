# MeMesh Python SDK

Python client for [MeMesh](https://github.com/PCIRCLE-AI/memesh-llm-memory) — the lightest universal AI memory layer.

## Install

```bash
pip install memesh
```

Requires MeMesh server running (`npm install -g @pcircle/memesh && memesh serve`).

## Quick Start

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737

# Store knowledge
m.remember("auth-decision", "decision",
           observations=["Use OAuth 2.0 with PKCE"],
           tags=["project:myapp"])

# Search knowledge
results = m.recall("auth")
for entity in results:
    print(f"{entity.name}: {entity.observations}")

# Archive old knowledge
m.forget("old-design")

# Compress verbose entities
m.consolidate(tag="project:myapp")
```

## Features

- Connects to MeMesh HTTP API (default: localhost:3737)
- Falls back to CLI subprocess if server unavailable
- Type-safe with dataclass return types
- Context manager support (`with MeMesh() as m:`)
- Works with any Python AI framework (LangChain, CrewAI, AutoGen)
