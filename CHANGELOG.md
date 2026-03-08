# Changelog

All notable changes to MeMesh will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`memesh-view` CLI command** — generates self-contained HTML dashboard with D3.js force-directed knowledge graph, searchable entity table, and statistics
- Fixed vitest pool from `threads` to `forks` to prevent SIGSEGV with better-sqlite3 native module

## [3.0.0-alpha.1] - 2026-03-09

### Breaking Changes

- **Minimal core rewrite** — stripped from 50+ source files to 5, 26 dependencies to 3
- **3 MCP tools only**: `remember`, `recall`, `forget` (removed buddy-do, buddy-help, memesh-hook-tool-use, memesh-generate-tests, memesh-metrics)
- **2 hooks only**: session-start, post-commit (removed pre-tool-use, post-tool-use, stop, subagent-stop)

### Removed

- Vector search (ONNX embeddings, sqlite-vec, EmbeddingService)
- Daemon/proxy server modes (standalone only)
- CLI features (commander, inquirer, interactive prompts)
- HTTP server (express)
- All UI formatting (chalk, boxen, ora, cli-spinners, cli-table3, asciichart)
- Logging framework (winston)
- 23 production dependencies

### Architecture

- **Database**: Direct better-sqlite3 with FTS5 full-text search
- **Server**: Standalone MCP via StdioServerTransport
- **Validation**: Zod schemas for all tool inputs
- **Backward compatible**: Existing DB data (entities, observations, relations, tags) preserved and queryable

## [2.10.2] - 2026-03-09

### Changed

- Clean up changelog entries

## [2.10.1] - 2026-03-09

### Fixed

- **health-check**: Support npm global install and plugin marketplace install modes (previously only worked from dev directory)

### Changed

- Streamline repository for professional open source standards
- Simplify documentation and build configuration

## [2.10.0] - 2026-03-08

### Added

- **Streamlit Visual Explorer** — interactive web UI for exploring the knowledge graph
  - **Dashboard page**: entity/relation/observation/tag counts, entity type distribution (pie chart), top tags (bar chart), entity growth over time (line chart), recent entities table
  - **KG Explorer page**: interactive graph visualization with color-coded entity types and relation edges, FTS5 full-text search, filtering by type/tags/date range, adjustable node count
  - Uses `streamlit-agraph` (vis.js) for graph rendering with physics-based layout
  - Automatic database path resolution (`~/.memesh/` and legacy `~/.claude-code-buddy/`)
- **Auto-relation inference** — entities created via `create-entities` now automatically infer relations
  - Intra-batch relations between newly created entities sharing topic keywords
  - New-to-existing relations linking new entities with relevant existing ones
  - Semantic relation types: `similar_to`, `solves`, `caused_by`, `enabled_by`, `depends_on`, `follows_pattern`
- **Relation backfill script** (`streamlit/backfill_relations.py`) — 3-layer strategy for existing entities
  - Layer 1: Topic/project clustering via name prefix matching
  - Layer 2: Cross-type semantic relations within topic clusters
  - Layer 3: Tag-based similarity (entities sharing 2+ tags)
  - Supports `--dry-run` and `--db-path` flags, idempotent via INSERT OR IGNORE
- **KG-style SVG logo** — replaced emoji badge with clean vector knowledge graph icon

### Fixed

- FTS5 false unavailability on Streamlit hot-reload (removed stale module-level cache)
- JSON injection in backfill relation metadata (f-string → `json.dumps`)
- Keyword false positives in auto-relation inference (minimum 4-char filter)
- Removed dead code (`insert_relations`, unused `KNOWN_PREFIXES` constant)

## [2.9.3] - 2026-03-08

### Added

- **ProactiveRecaller** — automatically surfaces relevant memories based on context triggers
  - `session-start`: injects top 5 memories (>0.5 similarity) into hook output using project name + recent commits
  - `test-failure`: recalls top 3 memories (>0.6 similarity) matching test name + error message
  - `error-detection`: recalls top 3 memories (>0.6 similarity) matching error type + first line
  - Session-start: integrated into `scripts/hooks/session-start.js` via FTS5 query
  - Test/error: integrated via `post-tool-use.js` → `proactive-recall.json` → `HookToolHandler`
- **ContentHasher** — SHA-256 hash-based embedding deduplication
  - Skips ONNX inference when entity content (name + observations) unchanged
  - `embedding_hashes` side table (vec0 virtual tables don't support ALTER TABLE)
  - Cleaned up on entity deletion
- **Batch embedding** — `createEntitiesBatch()` uses `encodeBatch()` instead of N individual `encode()` calls
  - Combined with hash dedup for maximum efficiency

### Fixed

- Update all repository URLs from `claude-code-buddy` to `memesh-plugin`
- Sync `marketplace.json` version to match package version
- Update dependencies to resolve security vulnerabilities (express-rate-limit, ip-address)

## [2.9.2] - 2026-03-08

### Architecture Refactoring

- **VectorSearchAdapter** (Strategy pattern) — decouples vector search from sqlite-vec
  - `SqliteVecAdapter`: sqlite-vec implementation (pinned to v0.1.3 stable)
  - `InMemoryVectorAdapter`: pure TypeScript implementation for testing without native deps
  - KnowledgeGraph now uses injected adapter instance instead of static VectorExtension
- **ToolHandlers decomposition** — split 922-line monolith into 3 focused sub-handlers
  - `MemoryToolHandler`: entity/relation/recall/mistake operations
  - `SystemToolHandler`: skills, uninstall, test generation
  - `HookToolHandler`: hook tool-use tracking
  - ToolHandlers.ts reduced to ~130-line facade
- **KGSearchEngine** — extracted FTS5, semantic, and hybrid search from KnowledgeGraph
- **MemorySearchEngine** — extracted search/filter/rank/dedup from UnifiedMemoryStore
- **GitCommandParser** — extracted git command detection from HookIntegration
- **StdinBufferManager** — extracted stdin buffering from server-bootstrap.ts

### Performance

- **Embedding LRU cache** — 500-entry cache eliminates redundant ONNX inference
- **Batch transactions** — `createEntitiesBatch()` wraps N inserts in single transaction
- **ONNX preloading** — daemon mode preloads model in background (eliminates 10-20s cold start)
- **encodeBatch parallelization** — texts encoded in parallel chunks of 10

### Fixed

- Global `unhandledRejection` and `uncaughtException` handlers in server-bootstrap
- Embedding failure log level upgraded from DEBUG to WARN
- Socket cleanup in `StdioProxyClient.connectToDaemon()` error path
- Duplicate `CONTROL_CHAR_PATTERN` constant unified
- Duplicate `uncaughtException` handler prevented in daemon mode
- StdinBufferManager catch block now logs errors instead of silent swallow

### Removed

- 6 unused npm dependencies (ink, ink-spinner, multer, cors, form-data, log-update)
- 4 dead utility modules (money.ts, toonify-adapter.ts, toonify.ts, tracing/middleware.ts)
- Unused AgentRegistry injection from ToolHandlers

### Documentation

- Added project CLAUDE.md with mandatory documentation-code synchronization rules
- Updated ARCHITECTURE.md to reflect all architectural changes
- Fixed embedding model references (bge-small-en-v1.5 → all-MiniLM-L6-v2)

## [2.9.1] - 2026-03-01

### Security

- Updated plugin dependencies to resolve Dependabot alerts
- Removed orphaned dist files and scripts from previously removed features

## [2.9.0] - 2026-02-25

### Added

- **Claude Code Hooks System** - 7 hooks for session lifecycle automation
  - `pre-tool-use`: Smart routing (model selection per task type), planning enforcement (SDD+BDD template), dry-run gate (untested code warning), code review reminder
  - `post-tool-use`: Pattern detection (EDIT_WITHOUT_READ, GIT_WORKFLOW, FRONTEND_WORK), anomaly detection, session state tracking
  - `post-commit`: Saves commit metadata to knowledge graph
  - `subagent-stop`: Captures code review findings to knowledge graph
  - `session-start`: Cache-first memory recall with SQLite fallback, CLAUDE.md reload
  - `stop`: Session archiving, key point extraction, pattern analysis
  - `hook-utils`: Shared utilities (sqliteQuery, sqliteBatch, sqliteBatchEntity, readStdin)
  - 15 automated tests via custom test harness
- **`memesh-metrics` MCP Tool** - Exposes session, routing, and memory metrics
  - Session: modified files, tested files, code review status
  - Routing: active model rules, planning enforcement, audit log
  - Memory: knowledge graph size and status
- **Semantic Search** - KnowledgeGraph now supports vector similarity search via sqlite-vec
  - `semanticSearch()`: Vector search with FTS5 keyword fallback
  - `hybridSearch()`: Combines keyword and vector results, deduplicates by entity name
  - Async embedding generation via `Xenova/all-MiniLM-L6-v2`
  - Keyword fallback uses 0.5 similarity (not 1.0) for honest scoring
- **Smart Task Analysis in `buddy-do`** - Detects task type (bug-fix, feature, refactor, test, performance, security), extracts metadata (goal, reason, expected outcome), queries related context from knowledge graph
- **Bundled Skill: `comprehensive-code-review`** - Included in `scripts/skills/`
- **Cloud-Only Fallback Mode** - MCP server can now run without local SQLite when better-sqlite3 is unavailable but MEMESH_API_KEY is configured (#73, #74)
  - Three-mode architecture: Standard (SQLite) / Cloud-Only (API key) / Error (neither)
  - Graceful degradation for Claude Desktop Cowork environments
  - Added 13 comprehensive tests for cloud-only mode (4 unit + 9 integration)
- **Claude Desktop Cowork Documentation** - Guide at `docs/COWORK_SUPPORT.md` (#75)
- **BuddyHandlers Test Coverage** - 9 unit tests covering all buddy commands (#19)
- **Enhanced .gitignore** - Multi-platform patterns for macOS, Windows, Linux, IDEs (#21)

### Changed

- **Server Bootstrap** - Structured error handling with error classification (permission, disk, socket) and actionable recovery hints
- **StdioProxyClient** - Buffer overflow handling, proper listener cleanup on connection failure
- **Dependencies Update** - Updated 15/17 packages to latest versions (#68)
  - @types/node, @typescript-eslint/*, ajv, dotenv, glob, ink, inquirer, onnxruntime-node, typedoc, and more
  - Note: eslint 10.0.0 blocked (typescript-eslint incompatibility)

### Fixed

- **`getEntity()` Exact Match** - Now uses direct SQL `WHERE name = ?` instead of FTS5 fuzzy search that could return wrong entity
- **`post-commit` Hook Exit Code** - Changed from `exit(1)` to `exit(0)` to never block Claude Code on hook errors
- **Entity Name Collision** - `subagent-stop` entity names now include timestamp to prevent UNIQUE constraint failures on multiple reviews per day
- **`sqliteQuery` Error Handling** - Returns `null` on error instead of empty string, allowing callers to distinguish errors from empty results
- **`sqliteBatch` Orphan Prevention** - Propagates errors; `sqliteBatchEntity` cleans up orphaned entities when batch fails
- **Error Logging** - `initVectorSearch` and `deleteEntity` catch blocks now log error context instead of silently discarding
- **Metrics Tool** - Uses PathResolver for DB path (supports custom data directories), `os.homedir()` fallback, bounded audit log read (256KB)
- **`UnifiedMemoryStore.update()` Race Condition** - Returns `false` on concurrent delete instead of creating phantom data
- **Session File Growth** - `post-tool-use` toolCalls array capped at 1000 entries
- **Windows Compatibility** - `pre-tool-use` uses `fileURLToPath()` instead of `URL.pathname`
- **`readStdin` Performance** - Fast-path for already-closed stdin avoids 3-second timeout
- **Hybrid Search Scoring** - Keyword fallback uses `similarity: 0.5` instead of `1.0` for honest scoring in merge
- **Cloud-Only Mode Error Handling** - Fixed `handleHookToolUse` to check for cloud-only mode before accessing memory systems

### Technical

- **Server Architecture** - Modified `ServerInitializer` to support three initialization modes
- **Type Safety** - Changed all optional memory systems from `null` to `undefined` for TypeScript consistency
- **Test Coverage** - 1817 unit tests + 15 hook tests (100% passing)
- **Code Quality** - Three rounds of comprehensive code review, all CRITICAL and MAJOR issues resolved
- **Refactored `subagent-stop`** - Uses `sqliteBatchEntity` (3 spawns) instead of individual `sqliteQuery` calls (N+2 spawns)

**Issues Resolved**: #73 (cloud-only mode), #74 (Phase 2), #75 (docs), #68 (deps), #19 (tests), #21 (.gitignore)

## [2.8.10] - 2026-02-14

### Documentation

- Added comprehensive development guide at `docs/DEVELOPMENT.md` covering prerequisites, setup, development workflow, testing strategy, MCP server debugging, common tasks, troubleshooting, and best practices
- Added "Real-World Examples" section to `docs/USER_GUIDE.md` with three multi-day project scenarios demonstrating cross-session memory and context preservation
- Set up TypeDoc for auto-generated API documentation with GitHub Actions deployment to GitHub Pages
- Added `typedoc.json` configuration to generate API docs to `api-docs/` directory
- Created `.github/workflows/deploy-docs.yml` for automatic API documentation deployment
- Updated `README.md` with links to new Development Guide and API Reference
- Updated `.gitignore` to exclude auto-generated `api-docs/` directory

### Fixed

- **Project Memory Isolation**: Fixed `buddy-remember` to isolate memories by project, preventing cross-project memory mixing
  - Added `allProjects` parameter to `buddy-remember` tool (default: `false`, searches only current project + global memories)
  - Modified `ProjectMemoryManager.search()` to filter by `scope:project` and `scope:global` tags
  - Updated `keywordSearch()`, `semanticSearch()`, and `hybridSearch()` to support project filtering
  - Memories are now tagged with `scope:project` (via `AutoTagger`) when stored with `projectPath` context
  - Use `buddy-remember "query" allProjects=true` to search across all projects when needed

**Issues Resolved**: #70, #69, #17

## [2.8.9] - 2026-02-12

### Documentation

- Fixed outdated version numbers across all docs (2.8.0/2.8.3 → 2.8.8)
- Replaced remaining "smart routing" and "intelligent task routing" references with accurate descriptions
- Fixed MCP config path in ARCHITECTURE.md (`~/.config/claude/` → `~/.claude/mcp_settings.json`)
- Prioritized `npm install -g @pcircle/memesh` as recommended installation method in all guides
- Updated repo metadata (GitHub description, topics, keywords)
- Fixed outdated paths, dead links, and wrong package names across docs
- Rebuilt CHANGELOG with complete v2.0.0–v2.8.8 history

### Fixed

- Fixed `release.sh` `head -n -1` incompatibility on macOS

## [2.8.8] - 2026-02-12

### Documentation

- Rewrote README with user-first design — reorganized around user journey (Install → Verify → Use → Troubleshoot)
- Added prerequisites section, inline troubleshooting, removed jargon
- Removed vibe coder branding, improved issue reporting links

### Fixed

- Resolved remaining GitHub code scanning alerts
- Removed unused imports

## [2.8.7] - 2026-02-12

### Fixed

- Resolved all 18 GitHub code scanning alerts (insecure temp files, TOCTOU races, unused code)
- Removed unused `afterEach` import in login.test.ts

### Repository

- Dismissed 3 medium alerts as intentional (cloud sync, credential storage)
- Resolved 2 secret scanning alerts (test dummy values in deleted files)
- Cleaned up 3 stale branches (develop, feature/memesh-login, fix/device-auth-tier1-security)

## [2.8.6] - 2026-02-12

### Fixed

- **Hooks DB Path** - Resolved hooks silently failing due to hardcoded legacy path
  - Hooks now use PathResolver logic: checks `~/.memesh/` first, falls back to `~/.claude-code-buddy/`
  - Session-start, post-tool-use, and stop hooks now correctly access the active knowledge graph
- **MCP Connection** - Fixed invalid marketplace source type preventing Claude Code from connecting
  - Changed source type from invalid `'local'` to correct `'directory'` in all installation scripts
  - Updated TypeScript type definition to include all valid source types

### Security

- Resolved GitHub code scanning alerts (insecure temp files, TOCTOU race conditions, unused code)

## [2.8.5] - 2026-02-12

### Fixed

- **Plugin Installation via npm install** - Complete installation flow with backward compatibility
  - Fixed marketplace registration not happening during npm install (only happened during build)
  - Users installing via `npm install -g @pcircle/memesh` now get a fully functional plugin
  - Auto-detects install mode (global vs local dev)
  - Auto-repairs legacy v2.8.4/v2.8.3 installations on first run
  - Comprehensive plugin configuration:
    - Registers marketplace in `~/.claude/plugins/known_marketplaces.json`
    - Creates symlink to `~/.claude/plugins/marketplaces/pcircle-ai`
    - Enables plugin in `~/.claude/settings.json`
    - Configures MCP server in `~/.claude/mcp_settings.json`
  - Fixed pre-deployment check treating plugin as standalone MCP server

### Technical

- Implemented TDD with 20 tests (10 unit + 9 integration, 100% passing)
- Created `scripts/postinstall-lib.ts` with core installation functions
- Fixed ESM compatibility issues (replaced `__dirname` with proper ESM patterns)

## [2.8.4] - 2026-02-10

### Added

- **Device Auth Login** - `memesh login` / `memesh logout` CLI commands with device auth flow
- Secure stdin input for manual API key entry

## [2.8.3] - 2026-02-09

### Fixed

- **Version Reporting** - MCP server now correctly reports version from package.json instead of hardcoded "2.6.6"
  - Replaced import assertion syntax with `fs.readFileSync` for cross-environment compatibility

## [2.8.2] - 2026-02-08

### Added

- **WCAG AA Compliance** - Color contrast verification following WCAG 2.1 Level AA
- **Screen Reader Support** - JSON event emission via `MEMESH_SCREEN_READER=1` environment variable
- Accessibility documentation at `docs/ACCESSIBILITY.md`
- Contrast verification script: `npm run verify:contrast`

## [2.8.1] - 2026-02-08

### Fixed

- **Build Artifacts Cleanup** - Removed legacy secret-types files from build output
  - Cleaned up `dist/memory/types/secret-types.*` files deprecated in v2.8.0
  - No functional changes - purely build artifact cleanup

## [2.8.0] - 2026-02-08

### ⚠️ Breaking Changes

- **MCP Tool Naming Unification** - All non-core tools now use `memesh-*` prefix
  - `buddy-record-mistake` → `memesh-record-mistake`
  - `create-entities` → `memesh-create-entities`
  - `hook-tool-use` → `memesh-hook-tool-use`
  - `generate-tests` → `memesh-generate-tests`

  **Migration**: Old names still work via aliases with deprecation warnings. Aliases will be removed in v3.0.0. See [UPGRADE.md](docs/UPGRADE.md) for details.

### Added

- **Vector Semantic Search** - Find memories by meaning, not just keywords
  - `buddy-remember` supports `mode`: `semantic`, `keyword`, `hybrid` (default)
  - `minSimilarity` parameter for quality filtering (0-1 threshold)
  - Uses all-MiniLM-L6-v2 ONNX model (384 dimensions, runs 100% locally)
  - Backfill script for existing entities: `npm run backfill-embeddings`
- **Alias System** - Backward compatibility for renamed tools with deprecation warnings

### Removed

- **A2A Local Collaboration** - Simplified to local-first architecture
  - Removed 35 A2A-related files (daemon, socket server, distributed task queue)
  - Focus on single-agent local memory management

### Changed

- **Tool Count**: 18 → **8 tools** (3 buddy commands + 4 memesh tools + 1 cloud sync)

### Technical

- New `src/embeddings/` module with ModelManager, EmbeddingService, VectorExtension
- Added sqlite-vec, onnxruntime-node, @xenova/transformers dependencies
- ToolRouter with alias resolution and deprecation warnings

## [2.7.0] - 2026-02-04

### Added
- Daemon socket cleanup on exit/crash - prevents stale socket issues
- Exception handlers (uncaughtException, unhandledRejection) for graceful daemon shutdown

### Changed
- **Memory retention periods**: Session 7→30 days, Project 30→90 days
- Auto-memory hooks improvements

### Fixed
- Stale daemon socket causing MCP connection failures in new sessions

## [2.6.6] - 2026-02-03

### Fixed
- GitHub Actions npm publish workflow - replaced invalid GitHub API method with logging

## [2.6.5] - 2026-02-03

### Added
- Enhanced post-install messaging with quick-start guide
- Unified getting-started guide (docs/GETTING_STARTED.md)
- Comprehensive PathResolver tests (47 tests, 100% coverage)
- Professional error formatting with category badges

### Fixed
- **Critical**: Fixed 4 hardcoded `~/.claude-code-buddy/` paths to use PathResolver
- Fixed 14 failing errorHandler tests to match new API structure

## [2.6.0] - 2026-01-31

### Changed
- Code quality improvements
- Documentation updates

## [2.5.3] - 2026-01-31

### Fixed
- Bug fixes and stability improvements

## [2.5.2] - 2026-01-31

### Fixed
- Bug fixes and stability improvements

## [2.5.1] - 2026-01-31

### Fixed
- Bug fixes and stability improvements

## [2.5.0] - 2026-01-30

### Added
- Process management tools
- Internationalization improvements

### Changed
- Code comments converted to English

## [2.4.2] - 2026-01-30

### Fixed
- Build configuration issues

## [2.4.1] - 2026-01-30

### Fixed
- MCP resources distribution

## [2.4.0] - 2026-01-30

### Added
- Enhanced testing system
- Hook integration improvements

## [2.3.1] - 2026-01-30

### Fixed
- MCP server lifecycle
- Verification script updates

## [2.3.0] - 2026-01-30

### Added
- NPM package support

### Changed
- Installation improvements

## [2.2.1] - 2026-01-30

### Fixed
- MCP stdio communication
- Build process improvements

## [2.2.0] - 2026-01-20

### Added
- Evidence-based guardrails
- Quality gates

### Changed
- Improved E2E test reliability

## [2.0.0] - 2026-01-01

### Added
- Initial MCP server implementation
- Core memory management
- Knowledge graph storage

---

For detailed changes, see the [commit history](https://github.com/PCIRCLE-AI/claude-code-buddy/commits/main).
