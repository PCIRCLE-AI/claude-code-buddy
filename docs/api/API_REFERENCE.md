# MeMesh Plugin - API Reference

**Protocol**: Model Context Protocol (MCP)

---

## Table of Contents

1. [Introduction](#introduction)
2. [Authentication & Connection](#authentication--connection)
3. [Tool Catalog](#tool-catalog)
4. [Core Tools](#core-tools)
   - [buddy-do](#buddy-do)
   - [buddy-remember](#buddy-remember)
   - [buddy-help](#buddy-help)
5. [Knowledge Graph Tools](#knowledge-graph-tools)
   - [memesh-create-entities](#memesh-create-entities)
6. [Learning & Automation Tools](#learning--automation-tools)
   - [memesh-record-mistake](#memesh-record-mistake)
   - [memesh-hook-tool-use](#memesh-hook-tool-use)
7. [System Tools](#system-tools)
   - [memesh-generate-tests](#memesh-generate-tests)
   - [memesh-metrics](#memesh-metrics)
8. [Data Models](#data-models)
9. [Error Reference](#error-reference)
10. [Integration Examples](#integration-examples)
11. [Rate Limits & Performance](#rate-limits--performance)

---

## Introduction

MeMesh Plugin is an MCP (Model Context Protocol) server that provides persistent memory management, context-aware task execution, and knowledge graph capabilities for Claude Code. This API reference documents all available MCP tools, their parameters, responses, and usage patterns.

**Key Features**:
- Context-aware task execution with memory integration
- Persistent knowledge graph storage
- Automatic memory linking and tagging
- Session health monitoring
- Test generation capabilities

**Architecture**:
```
Claude Code CLI
      ↓
MCP Protocol
      ↓
MeMesh Plugin
      ↓
   ┌──────┴──────┐
   ↓             ↓
Router      Knowledge Graph
```

---

## Authentication & Connection

MeMesh Plugin is a Claude Code Plugin. The MCP server is auto-managed via the plugin's `.mcp.json` file — no manual configuration of `~/.claude/mcp_settings.json` is needed.

Simply install MeMesh Plugin and restart Claude Code. The plugin system handles MCP server registration automatically.

**If auto-configuration fails**, run `memesh setup` to reconfigure.

**Advanced Configuration**:
```json
{
  "mcpServers": {
    "memesh": {
      "command": "npx",
      "args": ["-y", "@pcircle/memesh"],
      "env": {
        "DEBUG": "true",
        "MEMESH_DATA_DIR": "/custom/path/to/data",
        "MEMESH_LOG_LEVEL": "debug"
      }
    }
  }
}
```

**Environment Variables**:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DEBUG` | boolean | `false` | Enable debug logging |
| `MEMESH_DATA_DIR` | string | `~/.memesh` | Data directory for knowledge graph |
| `MEMESH_LOG_LEVEL` | string | `info` | Log level: error, warn, info, debug |

---

## Tool Catalog

MeMesh provides 8 MCP tools organized into three categories:

### Core Tools (User-Facing)

| Tool | Purpose | Complexity |
|------|---------|-----------|
| `buddy-do` | Execute tasks with memory context | Simple |
| `buddy-remember` | Store and recall project memory | Simple |
| `buddy-help` | Get help and command reference | Simple |

### Knowledge Graph Tools (Advanced)

| Tool | Purpose | Complexity |
|------|---------|-----------|
| `memesh-create-entities` | Create knowledge entities with auto-relations | Advanced |

### Learning & Automation Tools

| Tool | Purpose | Complexity |
|------|---------|-----------|
| `memesh-record-mistake` | Record mistakes for continuous learning | Medium |
| `memesh-hook-tool-use` | Process tool execution events (auto-triggered) | Internal |

### System Tools

| Tool | Purpose | Complexity |
|------|---------|-----------|
| `memesh-generate-tests` | Generate test cases from specs or code | Medium |
| `memesh-metrics` | View session metrics and memory status | Simple |

---

## Core Tools

### buddy-do

**Purpose**: Execute tasks with intelligent routing to specialized capabilities.

**Use Cases**:
- Development tasks (backend, frontend, DevOps)
- Architectural decisions
- Code reviews and debugging
- Documentation tasks
- Complex planning and analysis

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "task": {
      "type": "string",
      "description": "Task description to analyze and enrich (e.g., 'setup authentication', 'fix login bug')"
    }
  },
  "required": ["task"]
}
```

#### Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `task` | string | Yes | Task description in natural language | "implement user authentication with JWT" |

#### Response Format

```typescript
{
  content: [
    {
      type: "text",
      text: string  // Formatted response with routing decision
    }
  ]
}
```

**Response Structure** (parsed from formatted text):
- Task description
- Routing decision (approved/rejected)
- Capability focus (e.g., backend, frontend)
- Complexity level (simple, medium, complex)
- Estimated tokens
- Estimated cost
- Enhanced prompt (for Claude to execute)
- Duration and statistics

#### Examples

**Example 1: Backend Development Task**

Request:
```json
{
  "task": "implement user authentication with JWT tokens"
}
```

Response:
```
✓ BUDDY-DO SUCCESS

📋 Task
implement user authentication with JWT tokens

────────────────────────────────────

✓ Results
  routing:
    approved: true
    message: Task routed for capabilities: backend, authentication
    capabilityFocus: ["backend", "authentication"]
    complexity: medium
    estimatedTokens: 2500
    estimatedCost: 0.0125

────────────────────────────────────

💡 Next Steps
  1. Review implementation for security best practices
  2. Add tests for authentication flows
  3. Store decision: buddy-remember

Duration: 1.2s • Tokens: 2,500
```

**Example 2: Frontend Component**

Request:
```json
{
  "task": "create responsive navigation bar with dark mode toggle"
}
```

Response:
```
✓ BUDDY-DO SUCCESS

📋 Task
create responsive navigation bar with dark mode toggle

────────────────────────────────────

✓ Results
  routing:
    approved: true
    message: Task routed for capabilities: frontend, ui-design
    capabilityFocus: ["frontend", "ui-design"]
    complexity: medium
    estimatedTokens: 1800
    estimatedCost: 0.009

────────────────────────────────────

💡 Next Steps
  1. Test across different screen sizes
  2. Verify accessibility standards
  3. Store component patterns: buddy-remember

Duration: 0.9s • Tokens: 1,800
```

**Example 3: Bug Investigation**

Request:
```json
{
  "task": "investigate why sessions expire immediately after login"
}
```

Response:
```
✓ BUDDY-DO SUCCESS

📋 Task
investigate why sessions expire immediately after login

────────────────────────────────────

✓ Results
  routing:
    approved: true
    message: Task routed for capabilities: debugging, backend
    capabilityFocus: ["debugging", "backend"]
    complexity: medium
    estimatedTokens: 2200
    estimatedCost: 0.011

────────────────────────────────────

💡 Next Steps
  1. Check session configuration
  2. Review cookie settings
  3. Document fix: buddy-remember

Duration: 1.5s • Tokens: 2,200
```

#### Task Metadata Extraction

buddy-do automatically extracts metadata from task descriptions:

| Field | Pattern | Example |
|-------|---------|---------|
| `goal` | First sentence or "to X" | "implement login feature" |
| `reason` | "because X", "so that X" | "users need authentication" |
| `expectedOutcome` | "should X", "will X" | "users can log in securely" |

**Example**:
```json
{
  "task": "add email verification because users need to confirm their accounts"
}
```

Extracted metadata:
```typescript
{
  goal: "add email verification",
  reason: "users need to confirm their accounts",
  expectedOutcome: undefined  // Not explicitly stated
}
```

#### Complexity Levels

| Level | Token Range | Characteristics | Examples |
|-------|-------------|-----------------|----------|
| Simple | < 1,000 | Quick tasks, simple queries | "format this JSON", "explain this function" |
| Medium | 1,000-5,000 | Standard features, refactoring | "add user profile page", "refactor auth service" |
| Complex | > 5,000 | Architecture, large features | "redesign database schema", "build payment system" |

#### Best Practices

✅ **Do**:
- Use clear, specific task descriptions
- Include context when relevant (e.g., "because we need...")
- Mention expected outcomes
- Use for all development tasks

❌ **Don't**:
- Use for simple questions (use buddy-help instead)
- Use for memory searches (use buddy-remember instead)
- Write vague descriptions ("fix stuff")
- Include sensitive credentials in task text

#### Error Responses

```typescript
// Invalid input
{
  error: "Validation failed: task is required",
  code: "VALIDATION_FAILED"
}

// Routing failure
{
  error: "Unable to route task: no matching capabilities",
  code: "ROUTING_FAILED"
}

// System error
{
  error: "Router unavailable",
  code: "OPERATION_FAILED"
}
```

---

### buddy-remember

**Purpose**: Store and recall knowledge from your project's memory graph.

**Use Cases**:
- Store architectural decisions
- Record bug fixes and solutions
- Save API design patterns
- Document project conventions
- Search for past decisions

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query (natural language supported for semantic search)"
    },
    "mode": {
      "type": "string",
      "enum": ["semantic", "keyword", "hybrid"],
      "description": "Search mode: semantic (AI similarity), keyword (exact match), hybrid (both combined). Default: hybrid"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of results to return (1-50, default: 10)",
      "minimum": 1,
      "maximum": 50
    },
    "matchThreshold": {
      "type": "number",
      "description": "Minimum match score (0-1). Higher values return fewer but more relevant results. Default: 0.3",
      "minimum": 0,
      "maximum": 1
    },
    "allProjects": {
      "type": "boolean",
      "description": "Search across all projects (default: false, searches only current project + global memories)"
    }
  },
  "required": ["query"]
}
```

#### Parameters

| Parameter | Type | Required | Default | Description | Example |
|-----------|------|----------|---------|-------------|---------|
| `query` | string | Yes | - | Search query (natural language supported) | "why did we choose PostgreSQL?" |
| `mode` | string | No | hybrid | Search mode: `semantic`, `keyword`, `hybrid` | "keyword" |
| `limit` | number | No | 10 | Max number of results (1-50) | 20 |
| `matchThreshold` | number | No | 0.3 | Minimum match score (0-1) | 0.5 |
| `allProjects` | boolean | No | false | Search across all projects | true |

#### Response Format

```typescript
{
  content: [
    {
      type: "text",
      text: string  // Formatted response with memories
    }
  ]
}
```

**Response Structure** (parsed from formatted text):
- Query text
- Memory count
- Memory list (with timestamps, tags, content)
- Suggestions (if no results)

#### Examples

**Example 1: Store Decision**

Request:
```json
{
  "query": "We chose PostgreSQL because it supports JSON columns and has better performance for complex queries than MySQL"
}
```

Response:
```
✓ Memory Stored Successfully

📋 Task
Store project decision

────────────────────────────────────

✓ Results
  status: stored
  knowledge_id: "kb_1738560000123"
  tags: ["decision", "database", "postgresql"]
  timestamp: "2026-02-03T10:30:00Z"

────────────────────────────────────

💡 Next Steps
  1. Memory is now searchable
  2. Try: buddy-remember "postgresql" to verify

Duration: 0.8s • Tokens: 300
```

**Example 2: Recall Memories (With Results)**

Request:
```json
{
  "query": "database decisions",
  "limit": 3
}
```

Response:
```
✓ Memory Search Complete

📋 Query
database decisions

────────────────────────────────────

✓ Results
  count: 3
  memories:
    1. [2026-02-01] Decision: PostgreSQL for production
       "We chose PostgreSQL because it supports JSON..."
       Tags: decision, database, postgresql

    2. [2026-02-02] Configuration: Database pooling
       "Using pg-pool with max 20 connections..."
       Tags: configuration, database, performance

    3. [2026-02-03] Lesson: Connection timeout fix
       "Fixed timeouts by increasing pool timeout to 30s..."
       Tags: lesson, database, bug_fix

────────────────────────────────────

💡 Next Steps
  1. Review memories above for relevant context
  2. Apply these learnings to your current task

Duration: 1.1s • Tokens: 800
```

**Example 3: No Results Found**

Request:
```json
{
  "query": "blockchain integration"
}
```

Response:
```
✓ Memory Search Complete

📋 Query
blockchain integration

────────────────────────────────────

✓ Results
  count: 0

────────────────────────────────────

💡 Next Steps
  1. Try a broader search term
  2. Create new memory: buddy-remember
  3. Use different keywords

Duration: 0.5s • Tokens: 200
```

#### Storage vs. Recall Detection

MeMesh automatically detects whether you're storing or recalling:

**Storage Indicators**:
- Declarative statements
- Past tense verbs ("decided", "chose", "implemented")
- Contains factual information
- Longer descriptions (> 50 chars)

**Recall Indicators**:
- Question words ("why", "how", "what", "when")
- Question marks
- Short queries
- Search keywords

#### Auto-Tagging

MeMesh automatically generates tags based on content:

**Entity Types**:
- Technologies: postgresql, jwt, react, node.js
- Concepts: authentication, database, api, testing
- Actions: created, fixed, decided, refactored

**Tag Categories**:
- `decision` - Architectural choices
- `lesson` - Learnings from bugs/issues
- `pattern` - Code patterns and conventions
- `configuration` - Settings and configs

#### Best Practices

✅ **Storage Best Practices**:
- Be specific and concise
- Include context (why, when, what)
- Store as you work (not later)
- Use natural language
- Include reasons for decisions

✅ **Recall Best Practices**:
- Use keywords from your question
- Try broader terms if no results
- Search before starting new work
- Combine with buddy-do for context

❌ **Avoid**:
- Storing sensitive credentials
- Vague descriptions
- Duplicate storage
- Overly long queries

#### Error Responses

```typescript
// Invalid input
{
  error: "Validation failed: query is required",
  code: "VALIDATION_FAILED"
}

// Storage error
{
  error: "Failed to store memory: database unavailable",
  code: "OPERATION_FAILED"
}

// Search error
{
  error: "Memory search failed",
  code: "OPERATION_FAILED"
}
```

---

### buddy-help

**Purpose**: Get help, command reference, and usage examples.

**Use Cases**:
- First-time setup verification
- Quick command syntax reference
- Learn available commands
- View examples and patterns

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Specific command to get help for (e.g., 'do', 'remember', '--all' for full reference)",
      "optional": true
    }
  }
}
```

#### Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `command` | string | No | Command name or "--all" for full reference | "do", "--all" |

#### Response Format

```typescript
{
  content: [
    {
      type: "text",
      text: string  // Formatted help text
    }
  ]
}
```

#### Examples

**Example 1: Basic Help**

Request:
```json
{
  "command": undefined
}
```

Response:
```
🤖 MeMesh Quick Start

Essential Commands

┌────────────────────────────────────────────┐
│ buddy-do "<task>"                          │
└────────────────────────────────────────────┘
❯ buddy-do "add user authentication"
→ Routes to backend-developer, creates auth system

┌────────────────────────────────────────────┐
│ buddy-remember "<info>"                    │
└────────────────────────────────────────────┘
❯ buddy-remember "Using JWT for sessions"
→ Stores in Knowledge Graph with auto-tags

┌────────────────────────────────────────────┐
│ buddy-remember "<query>"                   │
└────────────────────────────────────────────┘
❯ buddy-remember "why JWT?"
→ Searches and recalls past decisions

💡 New to MeMesh?
Run: memesh tutorial

📖 Full reference: buddy-help --all
```

**Example 2: Full Reference**

Request:
```json
{
  "command": "--all"
}
```

Response: (Shows detailed reference for all commands with examples)

**Example 3: Specific Command**

Request:
```json
{
  "command": "do"
}
```

Response: (Shows detailed help for buddy-do command)

#### Best Practices

✅ **When to Use**:
- First time using MeMesh
- Forgot command syntax
- Need examples
- Want to see all available commands

❌ **Don't Use For**:
- Actual task execution (use buddy-do)
- Memory searches (use buddy-remember)

---

## Knowledge Graph Tools

### memesh-create-entities

**Purpose**: Create knowledge entities with explicit structure and relationships.

**Use Cases**:
- Build complex knowledge graphs
- Store structured architectural decisions
- Record feature implementations
- Document bug fixes with metadata
- Migrate external knowledge

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "entities": {
      "type": "array",
      "description": "Array of entities to create",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Entity name (unique identifier)"
          },
          "entityType": {
            "type": "string",
            "description": "Entity type"
          },
          "observations": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Array of observations (facts, notes)"
          },
          "tags": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional tags"
          },
          "metadata": {
            "type": "object",
            "description": "Optional metadata"
          }
        },
        "required": ["name", "entityType", "observations"]
      }
    }
  },
  "required": ["entities"]
}
```

#### Parameters

| Field | Type | Required | Description | Example |
|-------|------|----------|-------------|---------|
| `entities` | array | Yes | Array of entity objects | See examples |
| `entities[].name` | string | Yes | Unique entity identifier | "OAuth Integration 2026-02-03" |
| `entities[].entityType` | string | Yes | Type of entity (see types below) | "decision", "feature" |
| `entities[].observations` | array | Yes | Facts and notes about entity | ["Uses OAuth 2.0", "Supports Google/GitHub"] |
| `entities[].tags` | array | No | Additional tags | ["auth", "oauth", "security"] |
| `entities[].metadata` | object | No | Custom metadata | { "author": "KT", "priority": "high" } |

#### Entity Types

| Type | Description | Use Cases |
|------|-------------|-----------|
| `decision` | Architectural/technical decisions | "Chose PostgreSQL over MySQL" |
| `bug_fix` | Bug fixes and root causes | "Fixed session timeout issue" |
| `feature` | Feature implementations | "User profile feature" |
| `lesson_learned` | Lessons from incidents | "Always validate input data" |
| `best_practice` | Validated best practices | "Use JWT for stateless auth" |
| `problem_solution` | Problem-solution pairs | "Solved N+1 query problem" |
| `technical_debt` | Technical debt items | "Refactor user service needed" |
| `optimization` | Performance optimizations | "Added database indexing" |
| `refactoring` | Refactoring decisions | "Split monolith into services" |
| `code_change` | Code change events | "Updated auth middleware" |
| `test_result` | Test execution results | "All tests passing (245/245)" |

#### Response Format

```typescript
{
  created: string[],           // Names of created entities
  count: number,               // Number created
  autoRelationsCreated: number, // Auto-inferred relations created (v2.9.3+)
  errors?: Array<{             // Errors if any
    name: string,
    error: string
  }>
}
```

#### Auto-Relation Inference (v2.9.3+)

After creating entities, MeMesh automatically infers and creates relations between new entities and existing entities that share topic keywords. This is a best-effort feature — it never blocks entity creation.

**How it works:**
1. Topic keywords are extracted from entity names (first 2 words, 3+ characters)
2. New entities are compared against each other and against existing entities
3. Relations are inferred based on entity type combinations:

| Entity A Type | Entity B Type | Relation Created |
|--------------|--------------|-----------------|
| `bug_fix` | `feature` | bug_fix `solves` feature |
| `decision` | `feature` | feature `enabled_by` decision |
| `lesson_learned` | `bug_fix` | lesson_learned `caused_by` bug_fix |
| Same type | Same type | `similar_to` |

**Limits:**
- Maximum 50 auto-relations per batch (`MAX_AUTO_RELATIONS`)
- Session-specific types excluded (`session_keypoint`, `session_identity`, `task_start`, `session_summary`)
- Duplicate relations silently skipped (UNIQUE constraint)
```

#### Examples

**Example 1: Architecture Decision**

Request:
```json
{
  "entities": [
    {
      "name": "PostgreSQL Database Choice 2026-02-03",
      "entityType": "decision",
      "observations": [
        "Chose PostgreSQL over MySQL for production database",
        "Primary reasons: JSON column support, better performance for complex queries",
        "Supports full-text search natively",
        "Better concurrency handling with MVCC"
      ],
      "tags": ["database", "postgresql", "architecture"],
      "metadata": {
        "author": "KT",
        "date": "2026-02-03",
        "impact": "high"
      }
    }
  ]
}
```

Response:
```json
{
  "created": ["PostgreSQL Database Choice 2026-02-03"],
  "count": 1
}
```

**Example 2: Bug Fix with Context**

Request:
```json
{
  "entities": [
    {
      "name": "Session Timeout Bug Fix 2026-02-03",
      "entityType": "bug_fix",
      "observations": [
        "Bug: Sessions expired immediately after login",
        "Root cause: Cookie domain was set incorrectly",
        "Solution: Changed cookie domain to null in session config",
        "Testing: Verified sessions persist for 24 hours"
      ],
      "tags": ["bug", "session", "authentication", "fixed"],
      "metadata": {
        "severity": "critical",
        "affected_users": 0,
        "fix_duration": "2 hours"
      }
    }
  ]
}
```

Response:
```json
{
  "created": ["Session Timeout Bug Fix 2026-02-03"],
  "count": 1
}
```

**Example 3: Multiple Entities**

Request:
```json
{
  "entities": [
    {
      "name": "User Authentication Feature",
      "entityType": "feature",
      "observations": [
        "Implemented JWT-based authentication",
        "Supports email/password and OAuth",
        "Includes refresh token mechanism"
      ],
      "tags": ["feature", "auth", "jwt"]
    },
    {
      "name": "Authentication API Endpoints",
      "entityType": "code_change",
      "observations": [
        "POST /api/v1/auth/login",
        "POST /api/v1/auth/refresh",
        "POST /api/v1/auth/logout"
      ],
      "tags": ["api", "auth", "endpoints"]
    }
  ]
}
```

Response:
```json
{
  "created": [
    "User Authentication Feature",
    "Authentication API Endpoints"
  ],
  "count": 2
}
```

#### Auto-Tagging Behavior

If no `scope:` tag is provided, MeMesh automatically adds `scope:project`.

**Example**:
```json
{
  "tags": ["decision", "database"]
}
```

Becomes:
```json
{
  "tags": ["decision", "database", "scope:project"]
}
```

#### Best Practices

✅ **Do**:
- Use descriptive entity names with dates
- Include comprehensive observations
- Add relevant tags for searchability
- Use metadata for structured data
- Group related entities in single call

❌ **Don't**:
- Create duplicate entities (check first)
- Use vague entity names
- Skip observations (required field)
- Store sensitive data in observations

#### Error Responses

```typescript
// Invalid entity type
{
  created: ["Entity 1"],
  count: 1,
  errors: [
    {
      name: "Entity 2",
      error: "Invalid entity type: unknown_type"
    }
  ]
}

// Validation failure
{
  error: "Validation failed: observations is required",
  code: "VALIDATION_FAILED"
}

// Database error
{
  created: [],
  count: 0,
  errors: [
    {
      name: "Entity Name",
      error: "Database unavailable"
    }
  ]
}
```

---

---

## Learning & Automation Tools

### memesh-record-mistake

**Purpose**: Record AI mistakes for learning and prevention — enables systematic improvement from user feedback.

**Aliases**: `buddy-record-mistake` (deprecated, will be removed in v3.0.0)

**Use Cases**:
- User explicitly corrects AI behavior or approach
- Violated a documented procedure or guideline
- Made incorrect assumptions instead of asking
- Skipped validation step and caused problems

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "What action the AI took (the mistake)"
    },
    "errorType": {
      "type": "string",
      "description": "Error classification",
      "enum": [
        "procedure-violation",
        "workflow-skip",
        "assumption-error",
        "validation-skip",
        "responsibility-lack",
        "firefighting",
        "dependency-miss",
        "integration-error",
        "deployment-error"
      ]
    },
    "userCorrection": {
      "type": "string",
      "description": "User's correction/feedback"
    },
    "correctMethod": {
      "type": "string",
      "description": "What should have been done instead"
    },
    "impact": {
      "type": "string",
      "description": "Impact of the mistake"
    },
    "preventionMethod": {
      "type": "string",
      "description": "How to prevent this in the future"
    },
    "relatedRule": {
      "type": "string",
      "description": "Related rule/guideline (optional)"
    },
    "context": {
      "type": "object",
      "description": "Additional context (optional)"
    }
  },
  "required": ["action", "errorType", "userCorrection", "correctMethod", "impact", "preventionMethod"]
}
```

#### Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `action` | string | Yes | What action the AI took | "Edited file without reading first" |
| `errorType` | string | Yes | Error classification (see enum) | "procedure-violation" |
| `userCorrection` | string | Yes | User's correction/feedback | "Must read file before editing" |
| `correctMethod` | string | Yes | What should have been done | "Use Read tool first" |
| `impact` | string | Yes | Impact of the mistake | "Broke file indentation" |
| `preventionMethod` | string | Yes | How to prevent in future | "ALWAYS Read before Edit" |
| `relatedRule` | string | No | Related rule/guideline | "READ_BEFORE_EDIT" |
| `context` | object | No | Additional context | `{}` |

#### Example

Request:
```json
{
  "action": "Edited ServerInitializer.ts without reading file first",
  "errorType": "procedure-violation",
  "userCorrection": "Must read file before editing - broke indentation",
  "correctMethod": "Use Read tool first to see exact content and formatting, then Edit",
  "impact": "Broke file indentation, required re-edit, wasted user time",
  "preventionMethod": "ALWAYS invoke Read tool before Edit tool - no exceptions",
  "relatedRule": "READ_BEFORE_EDIT (Anti-Hallucination Protocol)"
}
```

---

### memesh-hook-tool-use

**Purpose**: Process tool execution events from Claude Code CLI for workflow automation.

**Aliases**: `hook-tool-use` (deprecated, will be removed in v3.0.0)

**Note**: This tool is auto-triggered by Claude Code hooks. Do not call manually.

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "toolName": {
      "type": "string",
      "description": "Tool name executed by Claude Code (e.g., 'Write', 'Edit', 'Bash')"
    },
    "arguments": {
      "type": "object",
      "description": "Tool arguments payload (tool-specific)"
    },
    "success": {
      "type": "boolean",
      "description": "Whether the tool execution succeeded"
    },
    "duration": {
      "type": "number",
      "description": "Execution duration in milliseconds (optional)"
    },
    "tokensUsed": {
      "type": "number",
      "description": "Tokens used by the tool call (optional)"
    },
    "output": {
      "type": "string",
      "description": "Tool output (optional)"
    }
  },
  "required": ["toolName", "success"]
}
```

#### Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `toolName` | string | Yes | Tool executed by Claude Code | "Write" |
| `success` | boolean | Yes | Whether execution succeeded | true |
| `arguments` | object | No | Tool arguments payload | `{"file_path": "..."}` |
| `duration` | number | No | Duration in milliseconds | 150 |
| `tokensUsed` | number | No | Tokens used by tool call | 500 |
| `output` | string | No | Tool output | "File written" |

---

## System Tools

### memesh-generate-tests

**Purpose**: Generate automated test cases from specifications or code.

**Use Cases**:
- Create test suites for new features
- Generate tests from requirements
- Create unit tests from code
- Build comprehensive test coverage
- Accelerate test development

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "specification": {
      "type": "string",
      "description": "Feature specification or requirements"
    },
    "code": {
      "type": "string",
      "description": "Source code to generate tests for"
    }
  }
}
```

**Note**: Either `specification` or `code` must be provided (but not both).

#### Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `specification` | string | Conditional | Feature spec or requirements | "User can log in with email/password" |
| `code` | string | Conditional | Source code to test | "function authenticate(user) { ... }" |

#### Response Format

```typescript
{
  testCode: string,      // Generated test code
  message: string        // Success message and instructions
}
```

#### Examples

**Example 1: Generate from Specification**

Request:
```json
{
  "specification": "User authentication feature:\n- User can log in with email and password\n- Invalid credentials return error\n- Successful login returns JWT token\n- Token expires after 24 hours"
}
```

Response:
```json
{
  "testCode": "describe('User Authentication', () => {\n  it('should log in with valid credentials', async () => {\n    const result = await authenticate({\n      email: 'user@example.com',\n      password: 'correctPassword'\n    });\n    expect(result.token).toBeDefined();\n    expect(result.token).toMatch(/^eyJ/);\n  });\n\n  it('should reject invalid credentials', async () => {\n    await expect(authenticate({\n      email: 'user@example.com',\n      password: 'wrongPassword'\n    })).rejects.toThrow('Invalid credentials');\n  });\n\n  it('should return token that expires in 24 hours', async () => {\n    const result = await authenticate(validCredentials);\n    const decoded = jwt.decode(result.token);\n    const expiresIn = decoded.exp - decoded.iat;\n    expect(expiresIn).toBe(86400); // 24 hours in seconds\n  });\n});",
  "message": "Test cases generated successfully. Review and adjust as needed."
}
```

**Example 2: Generate from Code**

Request:
```json
{
  "code": "export function calculateDiscount(price: number, couponCode: string): number {\n  if (price <= 0) throw new Error('Invalid price');\n  \n  const discounts: Record<string, number> = {\n    'SAVE10': 0.1,\n    'SAVE20': 0.2,\n    'SAVE50': 0.5\n  };\n  \n  const discount = discounts[couponCode] || 0;\n  return price * (1 - discount);\n}"
}
```

Response:
```json
{
  "testCode": "describe('calculateDiscount', () => {\n  it('should apply 10% discount for SAVE10', () => {\n    expect(calculateDiscount(100, 'SAVE10')).toBe(90);\n  });\n\n  it('should apply 20% discount for SAVE20', () => {\n    expect(calculateDiscount(100, 'SAVE20')).toBe(80);\n  });\n\n  it('should apply 50% discount for SAVE50', () => {\n    expect(calculateDiscount(100, 'SAVE50')).toBe(50);\n  });\n\n  it('should return original price for invalid coupon', () => {\n    expect(calculateDiscount(100, 'INVALID')).toBe(100);\n  });\n\n  it('should throw error for negative price', () => {\n    expect(() => calculateDiscount(-10, 'SAVE10')).toThrow('Invalid price');\n  });\n\n  it('should throw error for zero price', () => {\n    expect(() => calculateDiscount(0, 'SAVE10')).toThrow('Invalid price');\n  });\n});",
  "message": "Test cases generated successfully. Review and adjust as needed."
}
```

#### Test Generation Strategy

MeMesh uses sampling to generate comprehensive test suites that cover:

**Functional Testing**:
- Happy path scenarios
- Edge cases
- Boundary conditions
- Error handling

**Coverage Goals**:
- Input validation
- Business logic
- Error conditions
- Return values

#### Best Practices

✅ **Do**:
- Review generated tests before using
- Adjust assertions to match your framework
- Add additional edge cases as needed
- Run tests to verify they work
- Customize test descriptions

❌ **Don't**:
- Use generated tests without review
- Assume 100% coverage
- Skip manual test cases
- Ignore failing generated tests

#### Supported Test Frameworks

Generated tests are framework-agnostic but follow common patterns compatible with:
- Jest
- Mocha/Chai
- Vitest
- Jasmine

Adjust imports and syntax as needed for your framework.

#### Error Responses

```typescript
// Missing required input
{
  error: "Either specification or code must be provided",
  code: "VALIDATION_FAILED"
}

// Generation failed
{
  error: "Test generation failed: unable to parse code",
  code: "OPERATION_FAILED"
}

// Both inputs provided
{
  error: "Provide either specification or code, not both",
  code: "VALIDATION_FAILED"
}
```

---

### memesh-metrics

**Purpose**: View MeMesh session metrics, routing configuration, and memory status.

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "section": {
      "type": "string",
      "enum": ["all", "session", "routing", "memory"],
      "description": "Which metrics section to return (default: 'all')"
    }
  }
}
```

#### Parameters

| Parameter | Type | Required | Default | Description | Example |
|-----------|------|----------|---------|-------------|---------|
| `section` | string | No | "all" | Which metrics section to return | "session" |

#### Section Details

- **all** (default): Returns everything below
- **session**: Current session state — modified files, tested files, code review status
- **routing**: Active model rules, planning enforcement, dry-run gate, recent audit log
- **memory**: Knowledge graph size and status

#### Example

Request:
```json
{
  "section": "memory"
}
```

---

## Data Models

### Entity Model

```typescript
interface Entity {
  id?: number;                       // Auto-generated ID
  name: string;                      // Unique entity name
  entityType: EntityType;            // Type of entity
  observations: string[];            // Facts and notes
  tags?: string[];                   // Searchable tags
  metadata?: Record<string, unknown>; // Custom metadata
  createdAt?: Date;                  // Creation timestamp
}

type EntityType =
  // Knowledge types
  | 'decision'           // Architecture/technical decisions
  | 'bug_fix'           // Bug fixes and root causes
  | 'feature'           // Feature implementations
  | 'lesson_learned'    // Lessons from incidents
  | 'best_practice'     // Validated best practices
  | 'problem_solution'  // Problem-solution pairs
  | 'technical_debt'    // Technical debt items
  | 'optimization'      // Performance optimizations
  | 'refactoring'       // Refactoring decisions
  | 'learning_experience' // Learning patterns
  // Memory/tracking types
  | 'code_change'       // Code change events
  | 'test_result'       // Test execution results
  | 'session_snapshot'  // Session state snapshots
  | 'project_snapshot'  // Project state snapshots
  | 'workflow_checkpoint' // Workflow completions
  | 'commit'            // Git commit events
  | 'prevention_rule'   // Prevention rules
  | 'user_preference';  // User preferences
```

### Relation Model

```typescript
interface Relation {
  id?: number;                       // Auto-generated ID
  from: string;                      // Source entity name
  to: string;                        // Target entity name
  relationType: RelationType;        // Type of relationship
  metadata?: Record<string, unknown>; // Custom metadata
  createdAt?: Date;                  // Creation timestamp
}

type RelationType =
  | 'caused_by'         // A caused by B
  | 'enabled_by'        // A enabled by B
  | 'follows_pattern'   // A follows pattern from B
  | 'solves'            // A solves B
  | 'replaced_by'       // A replaced by B
  | 'depends_on'        // A depends on B
  | 'similar_to'        // A similar to B
  | 'evolved_from';     // A evolved from B
```

### Memory Model

```typescript
interface Memory {
  type: string;           // Entity type
  observations: string[]; // Array of observations
  timestamp?: string;     // ISO 8601 timestamp
}
```

### Task Metadata Model

```typescript
interface TaskMetadata {
  goal: string;              // Extracted task goal
  reason?: string;           // Reason for task
  expectedOutcome?: string;  // Expected result
}
```

---

## Error Reference

### Error Codes

| Code | Description | HTTP Equivalent | Common Causes |
|------|-------------|-----------------|---------------|
| `VALIDATION_FAILED` | Input validation error | 400 | Missing required fields, invalid types |
| `OPERATION_FAILED` | Operation execution failed | 500 | Database error, system unavailable |
| `RESOURCE_NOT_FOUND` | Resource not found | 404 | Entity doesn't exist |
| `ROUTING_FAILED` | Task routing failed | 500 | No matching capability |
| `TOOL_NOT_FOUND` | Tool doesn't exist | 404 | Invalid tool name |

### Error Response Format

All tools return errors in a consistent format:

```typescript
interface ErrorResponse {
  error: string;          // Human-readable error message
  code: string;           // Error code (see table above)
  details?: object;       // Additional error details
}
```

### Common Error Scenarios

#### Validation Errors

```typescript
// Missing required field
{
  error: "Validation failed: task is required",
  code: "VALIDATION_FAILED"
}

// Invalid type
{
  error: "Validation failed: limit must be a number",
  code: "VALIDATION_FAILED"
}

// Out of range
{
  error: "Validation failed: limit must be between 1 and 50",
  code: "VALIDATION_FAILED"
}
```

#### Operation Errors

```typescript
// Database unavailable
{
  error: "Database connection failed",
  code: "OPERATION_FAILED",
  details: {
    reason: "Connection timeout",
    path: "~/.memesh/database.db"
  }
}

// Permission denied
{
  error: "Cannot write to data directory",
  code: "OPERATION_FAILED",
  details: {
    path: "~/.memesh",
    permission: "denied"
  }
}
```

#### Resource Not Found

```typescript
// Entity not found
{
  error: "Entity not found: Non-existent Entity",
  code: "RESOURCE_NOT_FOUND"
}

// Tool not found
{
  error: "Tool not found: invalid-tool-name",
  code: "TOOL_NOT_FOUND"
}
```

### Error Handling Best Practices

✅ **Do**:
- Always check error codes
- Log errors with context
- Provide helpful error messages to users
- Retry transient errors (with backoff)
- Handle partial success in batch operations

❌ **Don't**:
- Ignore error responses
- Expose sensitive error details to users
- Retry non-transient errors indefinitely
- Assume success without checking status

---

## Integration Examples

### Example 1: Complete Feature Development Workflow

```typescript
// 1. Search for relevant context
const memories = await buddyRemember({
  query: "authentication patterns",
  limit: 5
});

// 2. Route implementation task
const task = await buddyDo({
  task: "implement user authentication with JWT because we need secure API access"
});

// 3. Create entity for implementation
await createEntities({
  entities: [
    {
      name: "User Authentication Implementation 2026-02-03",
      entityType: "feature",
      observations: [
        "Implemented JWT-based authentication",
        "Uses bcrypt for password hashing",
        "Refresh tokens stored in database",
        "Access tokens expire after 15 minutes"
      ],
      tags: ["auth", "jwt", "security", "feature"],
      metadata: {
        author: "KT",
        files: ["src/auth/jwt.ts", "src/middleware/auth.ts"],
        priority: "high"
      }
    }
  ]
});

// 4. Link to decision
await createRelations({
  relations: [
    {
      from: "User Authentication Implementation 2026-02-03",
      to: "JWT Library Decision",
      relationType: "enabled_by"
    }
  ]
});

// 5. Generate tests
const tests = await generateTests({
  specification: "User authentication with JWT:\n- Login with email/password\n- Token refresh\n- Token validation"
});

// 6. Store test results
await addObservations({
  observations: [
    {
      entityName: "User Authentication Implementation 2026-02-03",
      contents: [
        "All tests passing: 42/42",
        "Coverage: 95%",
        "Security audit passed"
      ]
    }
  ]
});
```

### Example 2: Bug Investigation and Fix

```typescript
// 1. Search for similar issues
const similarBugs = await buddyRemember({
  query: "session timeout issues",
  limit: 10
});

// 2. Investigate
const investigation = await buddyDo({
  task: "investigate why sessions expire immediately after login"
});

// 3. Document bug
await createEntities({
  entities: [
    {
      name: "Session Expiry Bug 2026-02-03",
      entityType: "bug_fix",
      observations: [
        "Bug: Sessions expire immediately after login",
        "Root cause: Cookie domain set incorrectly",
        "Affected: All users on production",
        "Discovered: User reports and monitoring"
      ],
      tags: ["bug", "session", "critical", "production"],
      metadata: {
        severity: "critical",
        affectedUsers: 1523,
        discoveredAt: "2026-02-03T08:00:00Z"
      }
    }
  ]
});

// 4. Document fix
await createEntities({
  entities: [
    {
      name: "Session Config Fix 2026-02-03",
      entityType: "code_change",
      observations: [
        "Changed cookie domain from '.example.com' to null",
        "Updated session middleware configuration",
        "Added tests for cookie settings"
      ],
      tags: ["fix", "session", "configuration"]
    }
  ]
});

// 5. Link bug and fix
await createRelations({
  relations: [
    {
      from: "Session Expiry Bug 2026-02-03",
      to: "Incorrect Cookie Domain Config",
      relationType: "caused_by"
    },
    {
      from: "Session Config Fix 2026-02-03",
      to: "Session Expiry Bug 2026-02-03",
      relationType: "solves"
    }
  ]
});

// 6. Update with resolution
await addObservations({
  observations: [
    {
      entityName: "Session Expiry Bug 2026-02-03",
      contents: [
        "Fixed: 2026-02-03T10:30:00Z",
        "Verified: Sessions now persist for 24 hours",
        "Deployed: Production rollout completed",
        "Impact: Zero session expiry reports since fix"
      ]
    }
  ]
});
```

### Example 3: Knowledge Graph Building

```typescript
// Build a comprehensive knowledge graph for a project

// 1. Architecture decisions
await createEntities({
  entities: [
    {
      name: "Microservices Architecture Decision",
      entityType: "decision",
      observations: [
        "Chose microservices over monolith",
        "Reasons: Independent scaling, team autonomy, tech diversity",
        "Trade-offs: Increased complexity, distributed debugging"
      ],
      tags: ["architecture", "microservices", "decision"]
    },
    {
      name: "PostgreSQL Database Choice",
      entityType: "decision",
      observations: [
        "Selected PostgreSQL for all services",
        "Reasons: JSON support, ACID compliance, mature ecosystem"
      ],
      tags: ["database", "postgresql", "decision"]
    }
  ]
});

// 2. Service implementations
await createEntities({
  entities: [
    {
      name: "User Service",
      entityType: "feature",
      observations: [
        "Handles user authentication and profiles",
        "Built with Node.js and Express",
        "Uses PostgreSQL for persistence"
      ],
      tags: ["service", "backend", "user"]
    },
    {
      name: "Order Service",
      entityType: "feature",
      observations: [
        "Manages order lifecycle",
        "Event-driven architecture with Kafka",
        "PostgreSQL for order storage"
      ],
      tags: ["service", "backend", "orders"]
    }
  ]
});

// 3. Build relationships
await createRelations({
  relations: [
    {
      from: "User Service",
      to: "Microservices Architecture Decision",
      relationType: "follows_pattern"
    },
    {
      from: "User Service",
      to: "PostgreSQL Database Choice",
      relationType: "depends_on"
    },
    {
      from: "Order Service",
      to: "Microservices Architecture Decision",
      relationType: "follows_pattern"
    },
    {
      from: "Order Service",
      to: "PostgreSQL Database Choice",
      relationType: "depends_on"
    },
    {
      from: "Order Service",
      to: "User Service",
      relationType: "depends_on",
      metadata: {
        reason: "Needs user information for orders"
      }
    }
  ]
});

// 4. Add best practices
await createEntities({
  entities: [
    {
      name: "Service Communication Best Practice",
      entityType: "best_practice",
      observations: [
        "Always use async messaging for service-to-service communication",
        "Prefer events over direct API calls",
        "Implement circuit breakers for resilience"
      ],
      tags: ["best_practice", "microservices", "resilience"]
    }
  ]
});

// 5. Link best practices
await createRelations({
  relations: [
    {
      from: "Order Service",
      to: "Service Communication Best Practice",
      relationType: "follows_pattern"
    }
  ]
});
```

---

## Rate Limits & Performance

### Performance Characteristics

| Operation | Typical Time | Notes |
|-----------|-------------|-------|
| `buddy-do` | 100-2000ms | Depends on task complexity |
| `buddy-remember` (store) | 50-200ms | Simple database insert |
| `buddy-remember` (search) | 100-500ms | Depends on graph size |
| `memesh-create-entities` | 50-200ms per entity | Batch operations faster |
| `memesh-record-mistake` | 50-200ms | Database insert |
| `memesh-hook-tool-use` | 10-100ms | Event processing |
| `memesh-generate-tests` | 1000-5000ms | Uses LLM sampling |
| `memesh-metrics` | 10-100ms | Read-only aggregation |

### Rate Limits

**MCP Protocol Limits**:
- No hard rate limits (local server)
- Performance scales with system resources
- Database operations are sequential

**Best Practices**:
- Batch entity creation when possible
- Cache buddy-remember results when appropriate
- Use appropriate query limits

### Resource Usage

**Memory**:
- Base server: ~50-100MB
- Knowledge graph: Grows with data (~1-10MB typical)
- Peak usage during memesh-generate-tests: ~200-300MB

**Storage**:
- Database file: `~/.memesh/database.db`
- Grows with entities and relations
- Typical project: 1-50MB
- Use SQLite VACUUM to optimize

**CPU**:
- Most operations: Low CPU usage
- memesh-generate-tests: Medium CPU (LLM sampling)
- memesh-metrics: Minimal CPU

### Optimization Tips

✅ **Optimize Performance**:
- Batch memesh-create-entities operations
- Use appropriate limit parameters
- Cache buddy-remember searches
- Clean up old entities periodically

✅ **Monitor Usage**:
- Use memesh-metrics to check memory status
- Monitor database file size
- Track operation latency
- Review error rates

---

## Appendix

### Version History

- **v2.6.6** (2026-02-03): Enhanced error handling, ErrorClassifier integration
- **v2.6.5** (2026-02-02): Interactive tutorial, improved QUICK_START
- **v2.6.4** (2026-02-01): Response formatting improvements
- **v2.6.3** (2026-01-31): Interactive setup wizard
- **v2.6.2** (2026-01-30): Auto-tracking and memory linking
- **v2.6.0** (2026-01-28): Smart routing with capability matching

### Related Documentation

- **User Guide**: [USER_GUIDE.md](../USER_GUIDE.md) - Complete user documentation
- **Best Practices**: [BEST_PRACTICES.md](../BEST_PRACTICES.md) - Effective workflows
- **Quick Start**: [QUICK_START.md](../QUICK_START.md) - Getting started guide
- **Troubleshooting**: [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) - Common issues and fixes
- **Commands**: [COMMANDS.md](../COMMANDS.md) - CLI command reference

### Support

**GitHub Repository**: https://github.com/PCIRCLE-AI/claude-code-buddy

**Issues**: https://github.com/PCIRCLE-AI/claude-code-buddy/issues

**Discussions**: https://github.com/PCIRCLE-AI/claude-code-buddy/discussions

---

**MeMesh Plugin** - Persistent memory and context-aware task execution for Claude Code

*For questions or issues, please visit the GitHub repository or open an issue.*
