# MeMesh Architecture

**Version**: 2.9.2
**Last Updated**: 2026-03-08
**Status**: Active

---

## Overview

MeMesh is a Model Context Protocol (MCP) server that enhances Claude Code with persistent memory, context-aware task execution, and knowledge management capabilities. It follows a layered architecture designed for extensibility, performance, and reliability.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code CLI                         │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP Protocol (JSON-RPC over stdio)
┌────────────────────────┴────────────────────────────────────┐
│                    MCP Server Layer (src/mcp/)               │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  ToolHandlers    │  │   Resources  │  │   Prompts    │  │
│  │  (facade)        │  └──────┬───────┘  └──────┬───────┘  │
│  │  ├ MemoryTool    │         │                  │          │
│  │  ├ SystemTool    │         │                  │          │
│  │  └ HookTool      │         │                  │          │
│  └────────┬─────────┘         │                  │          │
│  ┌────────┴─────────┐         │                  │          │
│  │StdinBufferManager│         │                  │          │
│  └──────────────────┘         │                  │          │
└─────────┼─────────────────────┼──────────────────┼──────────┘
          │                     │                  │
┌─────────┴─────────────────────┴──────────────────┴──────────┐
│                    Core Business Logic                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Memory System (src/memory/)                         │   │
│  │  ├─ UnifiedMemoryStore                               │   │
│  │  ├─ MemorySearchEngine (search/filter/rank/dedup)    │   │
│  │  ├─ ProjectAutoTracker                               │   │
│  │  ├─ ProactiveRecaller (session/test/error triggers)   │   │
│  │  ├─ MistakePatternEngine                             │   │
│  │  └─ AutoTagger                                       │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Knowledge Graph (src/knowledge-graph/)              │   │
│  │  ├─ KGSearchEngine (FTS5 + semantic + hybrid search) │   │
│  │  ├─ ContentHasher (SHA-256 embedding dedup)          │   │
│  │  ├─ createEntitiesBatch() (batch transactions)       │   │
│  │  └─ Entity Relationship Management                   │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Embeddings (src/embeddings/)                        │   │
│  │  ├─ EmbeddingService (LRU cache, batch encode)       │   │
│  │  ├─ VectorSearchAdapter (Strategy interface)         │   │
│  │  │  ├─ SqliteVecAdapter (sqlite-vec 0.1.3)           │   │
│  │  │  └─ InMemoryVectorAdapter (pure TS, testing)      │   │
│  │  └─ ModelManager (Xenova/all-MiniLM-L6-v2, 384-dim) │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Core (src/core/)                                    │   │
│  │  ├─ HookIntegration → GitCommandParser               │   │
│  │  ├─ CheckpointDetector                               │   │
│  │  └─ HealthCheck, ResourceMonitor                     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────┴───────────────────────────────────┐
│                   Data Persistence Layer                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Database (src/db/)                                  │   │
│  │  ├─ Connection Pool (better-sqlite3)                 │   │
│  │  ├─ Migrations & Schema                              │   │
│  │  └─ FTS5 + Vector Extensions                         │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## Layer Details

### 1. MCP Server Layer (`src/mcp/`)

**Purpose**: Implements the Model Context Protocol specification to communicate with Claude Code.

**Components**:
- **server.ts**: MCP server initialization and lifecycle management
- **server-bootstrap.ts**: Entry point for npm binary; handles CLI vs MCP mode detection, daemon/proxy bootstrap, global `unhandledRejection`/`uncaughtException` handlers, and background ONNX model preloading in daemon mode
- **StdinBufferManager.ts**: Pauses and buffers stdin during bootstrap to prevent "Method not found" errors when Claude Code sends `initialize` before the transport is connected
- **ToolHandlers.ts**: Thin facade (~137 lines) that dispatches to focused sub-handlers:
  - **MemoryToolHandler.ts**: Entity/relation/recall/mistake operations
  - **SystemToolHandler.ts**: Skills, uninstall, test generation
  - **HookToolHandler.ts**: Hook tool-use tracking
- **ToolRouter.ts**: Routes incoming MCP tool calls to ToolHandlers
- **BuddyCommands.ts**: Command definitions and help text (no longer handles routing)
- **ToolDefinitions.ts**: MCP tool schema definitions
- **validation.ts**: Input validation using Zod schemas
- **ProgressReporter.ts**: Real-time progress updates to Claude Code

**Communication**: JSON-RPC 2.0 over stdio

---

### 2. Memory System (`src/memory/`)

**Purpose**: Persistent, context-aware memory management for Claude Code sessions.

**Components**:

#### UnifiedMemoryStore
- Central memory management interface
- CRUD operations for memories
- Semantic search using embeddings
- FTS5 full-text search integration

#### MemorySearchEngine
- Search logic extracted from UnifiedMemoryStore
- Content-based query filtering (substring match)
- Search filter application (time range, importance, type, limit)
- Result deduplication by content hash
- Relevance ranking via SmartMemoryQuery delegation

#### ProjectAutoTracker
- Automatic tracking of project context
- File change detection via chokidar
- Git integration for tracking commits

#### ProactiveRecaller
- Automatically surfaces relevant memories based on trigger context
- Three triggers: `session-start` (hook output injection, top 5, >0.5 similarity), `test-failure` (top 3, >0.6), `error-detection` (top 3, >0.6)
- Builds optimized search queries per trigger type (strips conventional commit prefixes, extracts test names, isolates first error line)
- Session-start: integrated into `scripts/hooks/session-start.js` via FTS5 query
- Test/error: integrated into `scripts/hooks/post-tool-use.js` → writes `proactive-recall.json` → `HookToolHandler` reads and appends to MCP response

#### MistakePatternEngine
- Learns from user corrections
- Detects recurring mistakes
- Suggests improvements

#### AutoTagger
- Automatic tag generation for memories
- Category detection
- Relevance scoring

**Data Flow**:
```
User Input -> Memory Ingestion -> Vector Embedding -> SQLite Storage
                                                       |
User Query <- Similarity Search <- Vector Search + FTS5 Search
```

---

### 3. Knowledge Graph (`src/knowledge-graph/`)

**Purpose**: Structured knowledge representation with relationships and semantic search.

**Components**:

#### KnowledgeGraph (`index.ts`)
- Entity and relationship CRUD
- Uses injected `VectorSearchAdapter` instance (via constructor) instead of static VectorExtension
- `createEntitiesBatch()`: Wraps all entity creations in a single SQLite transaction for significantly better write performance; individual failures are caught without aborting the batch

#### ContentHasher (`ContentHasher.ts`)
- SHA-256 hash (truncated to 16 hex chars) of entity name + observations
- Used by `generateEmbeddingAsync` and `generateBatchEmbeddingsAsync` to skip ONNX inference when content unchanged
- Hash stored in `embedding_hashes` side table (vec0 virtual tables don't support ALTER TABLE)
- Cleaned up on entity deletion

#### KGSearchEngine (`KGSearchEngine.ts`)
- Extracted from KnowledgeGraph to separate search concerns from CRUD
- **FTS5 Full-Text Search**: Fast keyword-based search
- **Semantic Search**: Vector similarity via injected VectorSearchAdapter
- **Hybrid Search**: Combines FTS5 and vector results for optimal recall
- Receives dependencies via constructor to avoid circular imports

**Database Schema**:
```sql
entities (id, type, content, metadata, embedding[384])
relationships (source_id, target_id, type, metadata)
fts_entities (content) -- FTS5 virtual table
embedding_hashes (entity_name PK, hash) -- Content hash for embedding dedup
```

---

### 4. Embeddings Layer (`src/embeddings/`)

**Purpose**: Convert text to vector representations for semantic search.

**Model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- Small footprint (~25 MB)
- Fast inference via ONNX runtime
- Good quality for code/technical text

**Components**:

#### ModelManager.ts
- Model download and validation
- Cross-platform model directory resolution
- Environment variable overrides (`MEMESH_MODEL_DIR`, `MEMESH_DATA_DIR`)

#### EmbeddingService.ts
- Batch embedding generation via `encodeBatch()` (parallel chunks of 10)
- **LRU cache**: 500-entry cache for text embeddings; cache hits resolve nearly instantly
- Cosine similarity calculation
- Lazy-loading singleton (`LazyEmbeddingService`) for efficient resource management
- ONNX model preloading in daemon mode eliminates 10-20s cold start

#### VectorSearchAdapter.ts (Strategy Pattern Interface)
- Decouples vector search from specific implementations
- Defines operations: `loadExtension`, `createVectorTable`, `insertEmbedding`, `deleteEmbedding`, `knnSearch`, `getEmbedding`, `hasEmbedding`, `getEmbeddingCount`

#### SqliteVecAdapter.ts
- Concrete `VectorSearchAdapter` implementation using sqlite-vec
- sqlite-vec pinned to v0.1.3 (stable)
- Handles extension loading, virtual table creation, KNN search

#### InMemoryVectorAdapter.ts
- Pure TypeScript implementation (no native dependencies)
- Uses in-memory Map + brute-force cosine similarity
- Enables tests without native module compilation

---

### 5. Core Layer (`src/core/`)

**Purpose**: Shared business logic components.

**Components**:

#### HookIntegration.ts
- Bridges Claude Code hooks with the checkpoint detection system
- Monitors Write, Edit, Bash tool execution
- Delegates git command detection to **GitCommandParser**

#### GitCommandParser.ts
- Extracted from HookIntegration for reusability
- Static methods for git command classification (`isGitAdd`, `isGitCommit`, `extractCommitMessage`)
- Test file/command detection (`isTestFile`, `isTestCommand`)

#### CheckpointDetector.ts
- Detects workflow checkpoints from tool execution patterns
- Checkpoint types: `code-written`, `test-complete`, `commit-ready`, `committed`

#### HealthCheck.ts / ResourceMonitor.ts
- System health monitoring and resource usage tracking

---

### 6. Database Layer (`src/db/`)

**Purpose**: Persistent storage with connection pooling and migrations.

**Technology**: better-sqlite3 (synchronous SQLite)

**Features**:
- Connection pooling for concurrent access
- Migration system for schema evolution
- FTS5 extension for full-text search
- sqlite-vec extension for vector operations

**Key Tables**:
- `memories`: Core memory storage
- `entities`: Knowledge graph entities
- `tags`: Memory categorization
- `sessions`: Session tracking
- `embeddings`: Vector embeddings

---

### 7. Integration Layer (`src/integrations/`)

**Purpose**: External system integrations and session management.

**Components**:
- **session-memory/**: Claude Code session integration
  - SessionMemoryParser: Parse session transcripts
  - SessionMemoryIngester: Import session data
  - SessionContextInjector: Inject context into new sessions

---

### 8. UI Layer (`src/ui/`)

**Purpose**: Rich terminal UI for progress indication and data visualization.

**Components**:
- **ProgressRenderer.ts**: Real-time progress bars
- **ResponseFormatter.ts**: Formatted output for buddy commands
- **design-tokens.ts**: Color palette and typography
- **accessibility.ts**: WCAG AA compliance, screen reader support

---

### 9. Utilities

#### Config (`src/config/`)
- Environment variable management
- Model configuration
- Database configuration

#### Errors (`src/errors/`)
- Custom error types
- Error classification
- Sanitization for telemetry

#### Types (`src/types/`)
- TypeScript type definitions
- Shared interfaces

#### Utils (`src/utils/`)
- Logger (winston)
- Rate limiter
- LRU cache utilities
- Validation helpers

---

## Data Flow Examples

### 1. Memory Storage Flow

```
buddy-do "implement auth"
  |
ToolHandlers facade -> MemoryToolHandler
  |
UnifiedMemoryStore.create()
  |
Generate embedding (384-dim vector, LRU cache check)
  |
Store in SQLite (memories + embeddings tables)
  |
Index in FTS5
  |
Auto-tag (category detection)
  |
Return success to Claude Code
```

### 2. Memory Retrieval Flow

```
buddy-remember "auth"
  |
ToolHandlers facade -> MemoryToolHandler
  |
UnifiedMemoryStore.search() -> MemorySearchEngine
  |
Parallel search:
  |- FTS5 keyword search
  |- Vector similarity search (cosine)
  |
Merge, deduplicate, and rank results
  |
Format response (ResponseFormatter)
  |
Return to Claude Code
```

### 3. Knowledge Graph Batch Creation

```
memesh-create-entities [{...}, {...}, ...]
  |
ToolHandlers facade -> MemoryToolHandler
  |
KnowledgeGraph.createEntitiesBatch()
  |
Single SQLite transaction wrapping N entity inserts
  |
Per-entity: validate -> insert -> FTS5 index (embedding skipped)
  |
After transaction: hash-dedup check -> encodeBatch() -> bulk insert embeddings
  |
Return per-entity success/failure results
```

---

## Performance Characteristics

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| Memory write | < 10ms | Including embedding generation |
| FTS5 search | < 5ms | Scales with corpus size |
| Vector search | < 20ms | 384-dim cosine similarity |
| Hybrid search | < 25ms | FTS5 + vector combined |
| Embedding generation | ~50ms | First call; cached hits < 1ms |
| Embedding batch (10) | ~100ms | Parallel chunks of 10 |
| Batch entity creation | ~N*5ms | Single transaction, amortized |

**Performance optimizations (v2.9.2+)**:
- **Embedding LRU cache**: 500-entry cache eliminates redundant ONNX inference for repeated text
- **Batch transactions**: `createEntitiesBatch()` uses a single SQLite transaction instead of N separate ones
- **ONNX preloading**: Daemon mode preloads the embedding model in the background, eliminating 10-20s cold start on first semantic search
- **encodeBatch parallelization**: Texts are encoded in parallel chunks of 10 for improved throughput
- **Content hash dedup**: SHA-256 hash check skips ONNX inference when entity content unchanged (embedding_hashes table)
- **Batch embedding**: `createEntitiesBatch` uses `encodeBatch()` instead of N individual `encode()` calls

---

## Security & Privacy

1. **Local-First Architecture**: All data stored locally in `~/.memesh/`
2. **No External Calls**: Except configured AI providers (Anthropic)
3. **SQL Injection Prevention**: Parameterized queries only
4. **Input Validation**: Zod schemas for all user input
5. **Path Traversal Protection**: Validated file paths
6. **Screen Reader Support**: WCAG AA compliant UI

---

## Extension Points

### Adding New MCP Tools

1. Define tool schema in `ToolDefinitions.ts`
2. Implement handler in the appropriate sub-handler (`MemoryToolHandler.ts`, `SystemToolHandler.ts`, or `HookToolHandler.ts`)
3. Register dispatch in `ToolHandlers.ts` facade
4. Add validation schema
5. Update documentation

### Adding New Memory Types

1. Create new table in migration
2. Extend UnifiedMemoryStore interface
3. Implement CRUD operations
4. Add embedding support if needed

### Adding New Vector Search Backends

1. Implement `VectorSearchAdapter` interface
2. Handle extension loading, table creation, CRUD, and KNN search
3. Inject into KnowledgeGraph constructor

### Adding New Integrations

1. Create new directory in `src/integrations/`
2. Implement integration interface
3. Add configuration
4. Register with core system

---

## Deployment Modes

MeMesh supports three deployment modes to accommodate different environments:

### 1. Standard Mode (Full Functionality)

**When**: better-sqlite3 is available

**Features**:
- Full local Knowledge Graph with SQLite
- All memory tools (buddy-do, buddy-remember, memesh-create-entities)
- Vector embeddings and semantic search
- FTS5 full-text search

**Architecture**:
```
Claude Code -stdio-> MCP Server
                          |
                          v
                   KnowledgeGraph
                   (SQLite+Vec)
```

**Use Cases**:
- Claude Code CLI (recommended)
- Claude Code VS Code Extension
- Cursor (via MCP)
- Local development

---

### 2. Cloud-Only Mode (Partial Functionality)

**When**: better-sqlite3 unavailable + MEMESH_API_KEY is configured

**Features**:
- MCP server starts successfully
- Basic commands (buddy-help, memesh-generate-tests)
- Local memory tools disabled (buddy-do, buddy-remember, memesh-create-entities, memesh-hook-tool-use, memesh-record-mistake, memesh-metrics)

**Error Messages**:
```
Tool 'buddy-remember' is not available in cloud-only mode.

This MCP server is running without local SQLite storage (better-sqlite3 unavailable).

To use local memory tools:
1. Install better-sqlite3: npm install better-sqlite3
2. Restart the MCP server

Local SQLite storage is required for memory features.
```

**Architecture**:
```
Claude Code -stdio-> MCP Server (Cloud-Only)
                          |
                          v
                    Basic Tools Only
                    (no local storage)
```

**Use Cases**:
- Claude Desktop Cowork (sandbox environment)
- Environments where native modules cannot compile
- Read-only filesystems
- Cloud-first workflows (future)

**Limitations**:
- No local Knowledge Graph
- No vector embeddings
- No FTS5 search
- Memory tools return friendly errors

**Why Cloud-Only Mode Exists**:

Claude Desktop Cowork runs plugins in a restricted sandbox:
1. **Read-only filesystem** - Cannot write to plugin directories
2. **Blocked node-gyp compilation** - HTTP 403 when downloading Node.js headers
3. **No prebuilt binaries** - better-sqlite3, onnxruntime-node, sqlite-vec don't ship ARM64 Linux binaries
4. **Ephemeral storage** - `~/.memesh/` directory is session-scoped

Cloud-only mode allows the MCP server to start successfully and provide cloud sync functionality while gracefully degrading memory-dependent features.

---

### 3. Error Mode (Cannot Start)

**When**: Both better-sqlite3 unavailable AND no MEMESH_API_KEY

**Behavior**:
```
ConfigurationError: Cannot start MCP server without local SQLite or cloud configuration.

Please choose one of the following:
1. Install better-sqlite3: npm install better-sqlite3
2. Configure cloud access: export MEMESH_API_KEY="your-key"
3. Use global installation: npm install -g @pcircle/memesh

For detailed troubleshooting, see: docs/TROUBLESHOOTING.md
```

**Use Cases**: Configuration error, should not occur in normal usage

---

### Mode Detection Logic

**Implementation** (`src/mcp/ServerInitializer.ts`):

```typescript
const sqliteAvailability = await checkBetterSqlite3Availability();
const cloudEnabled = isCloudEnabled();

if (sqliteAvailability.available) {
  // Standard mode: Use local SQLite
  knowledgeGraph = KnowledgeGraph.createSync();
  projectMemoryManager = new ProjectMemoryManager(knowledgeGraph);
  cloudOnlyMode = false;
} else if (cloudEnabled) {
  // Cloud-only mode: Degrade gracefully
  logger.warn('[ServerInitializer] Running in cloud-only mode');
  knowledgeGraph = undefined;
  projectMemoryManager = undefined;
  cloudOnlyMode = true;
} else {
  // Error mode: Cannot start
  throw new ConfigurationError('Cannot start MCP server...');
}
```

**Availability Check**:
```typescript
async function checkBetterSqlite3Availability(): Promise<AvailabilityResult> {
  try {
    await import('better-sqlite3');
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: 'better-sqlite3 module not available',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

---

### Future: Cloud-First Memory Architecture

**Goal**: Full Claude Desktop Cowork support through cloud-first architecture

**Planned Implementation**:
1. Cloud API endpoints for KG operations (create, recall, search)
2. Memory tools proxy to cloud in cloud-only mode
3. Shared KG accessible from any client
4. No local persistence needed (cloud as source of truth)

**Timeline**: Long-term (no ETA)

**Related Issues**: #73, #76, #77

See [docs/COWORK_SUPPORT.md](./COWORK_SUPPORT.md) for detailed Cowork support documentation.

---

## Testing Strategy

- **Unit Tests**: `vitest` for individual components
- **Integration Tests**: End-to-end memory flows
- **E2E Tests**: Full MCP protocol testing
- **Installation Tests**: Verify npm package installation

**Coverage Target**: >= 80% for critical paths

---

## Deployment

**Distribution**: npm package `@pcircle/memesh`

**Installation**:
```bash
npm install -g @pcircle/memesh
```

**Binary**: `dist/mcp/server-bootstrap.js` (executable)

**Claude Code Integration**: MCP configuration in `~/.claude/mcp_settings.json`

---

## Future Architecture Considerations

- **Multi-Model Support**: Pluggable AI providers
- **Distributed Memory**: Sync across devices
- **Plugin System**: User-defined extensions
- **Web Dashboard**: Browser-based memory management

---

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [MeMesh User Guide](./USER_GUIDE.md)
- [API Reference](./api/API_REFERENCE.md)
- [Contributing Guide](./CONTRIBUTING.md)

---

**Maintained by**: PCIRCLE-AI
**License**: MIT
