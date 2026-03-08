# User Guide
## Complete Reference for MeMesh

Welcome to the complete MeMesh User Guide! This guide provides detailed information about all commands, features, and workflows.

---

## Table of Contents

1. [Introduction](#introduction)
2. [Core Commands](#core-commands)
3. [MCP Tools](#mcp-tools)
   - [Advanced MCP Tools](#advanced-mcp-tools)
   - [Learning & Error Tracking](#learning--error-tracking)
4. [CLI Commands](#cli-commands)
5. [Memory System](#memory-system)
6. [Task Execution](#task-execution)
7. [Configuration](#configuration)
8. [Visual Explorer (Streamlit UI)](#visual-explorer-streamlit-ui)
9. [Advanced Usage](#advanced-usage)
10. [Troubleshooting](#troubleshooting)

---

## Introduction

### What is MeMesh?

MeMesh is a persistent memory plugin for Claude Code that helps you:

- **Remember across sessions**: Persistent knowledge graph storage
- **Execute tasks with context**: Memory-enhanced task execution
- **Learn from experience**: Auto-tracking and pattern recognition
- **Work efficiently**: Context-aware assistance

### Architecture Overview

MeMesh runs as a local-first MCP server:

```
Claude Code ──stdio──► MeMesh MCP Server
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              ┌─────────┐ ┌────────┐ ┌──────────┐
              │ Router  │ │ Memory │ │ Semantic  │
              │         │ │ Graph  │ │ Search    │
              └─────────┘ └────────┘ └──────────┘
```

**Benefits:**
- Local-first: All data stored locally, never transmitted
- Zero configuration: Works out of the box
- Vector semantic search: ONNX embeddings for intelligent recall
- Persistent memory: Knowledge graph persists across sessions

---

## Core Commands

### buddy-do

**Purpose**: Execute tasks with memory-enhanced context

**Syntax**:
```
buddy-do "<task description>"
```

**How it works**:
1. Analyzes task complexity and required capabilities
2. Routes to the best-suited capability (backend, frontend, devops, etc.)
3. Enhances prompt with project context
4. Returns routing decision and enhanced prompt

**Examples**:

```bash
# Backend development
buddy-do "implement user authentication with JWT"
# → Routes to backend-developer capability
# → Analyzes database requirements, security considerations
# → Provides enhanced prompt with project context

# Frontend development
buddy-do "create responsive navbar with dark mode toggle"
# → Routes to frontend-developer capability
# → Considers existing design system
# → Suggests component structure

# DevOps tasks
buddy-do "setup CI/CD pipeline with GitHub Actions"
# → Routes to devops capability
# → Analyzes deployment requirements
# → Provides workflow configuration

# Bug fixes
buddy-do "fix memory leak in user service"
# → Routes to debugging capability
# → Analyzes potential causes
# → Suggests investigation steps
```

**Task Metadata Extraction**:

buddy-do automatically extracts metadata from your task description:

- **Goal**: What you want to achieve
- **Reason**: Why you're doing this (if mentioned)
- **Expected Outcome**: What success looks like

Example:
```
buddy-do "add email verification because users need to confirm accounts"

Extracted:
- Goal: "add email verification"
- Reason: "users need to confirm accounts"
- Expected Outcome: (inferred from context)
```

**Response Structure**:

```
✓ BUDDY-DO SUCCESS

📋 Task
Setup user authentication with JWT

────────────────────────────────────

✓ Results
  routing:
    approved: true
    message: Task routed to backend-developer
    complexity: medium
    estimatedTokens: 2500
    estimatedCost: $0.0125

────────────────────────────────────

💡 Next Steps
  1. Verify implementation meets requirements
  2. Run tests to ensure nothing broke
  3. Store decision: buddy-remember

Duration: 2.3s • Tokens: 2,500
```

**Complexity Levels**:

- **Simple** (< 1000 tokens): Quick tasks, simple queries
- **Medium** (1000-5000 tokens): Standard features, moderate refactoring
- **Complex** (> 5000 tokens): Architectural changes, large features

**When to Use**:
- ✅ Any development task (coding, testing, debugging)
- ✅ Architectural decisions
- ✅ Code reviews
- ✅ Documentation tasks
- ✅ Planning and analysis

**When NOT to Use**:
- ❌ Simple questions (use buddy-help instead)
- ❌ Memory queries (use buddy-remember instead)

---

### buddy-remember

**Purpose**: Store and recall knowledge from your project's memory graph

**Syntax**:
```bash
# Store knowledge
buddy-remember "<information to store>"

# Recall knowledge (search)
buddy-remember "<search query>"
```

**How it works**:

**Storage Mode**:
- Detects when you're providing information (not a question)
- Stores in Knowledge Graph with auto-generated tags
- Records timestamp and context
- Returns confirmation

**Recall Mode**:
- Searches Knowledge Graph by keywords and semantic similarity
- Ranks results by relevance
- Returns matching memories with context
- Suggests next steps if no results found

**Storage Examples**:

```bash
# Store decisions
buddy-remember "We decided to use PostgreSQL because it supports JSON and has better performance for complex queries"

# Store patterns
buddy-remember "All API endpoints follow RESTful conventions with /api/v1 prefix"

# Store lessons learned
buddy-remember "Login bug was caused by session timeout not being reset on activity. Fixed by updating session middleware"

# Store configuration
buddy-remember "Production uses AWS RDS with t3.medium instances, staging uses t3.micro"
```

**Recall Examples**:

```bash
# Search for decisions
buddy-remember "why did we choose PostgreSQL?"
# → Returns: Database selection decisions and reasons

# Find patterns
buddy-remember "API endpoint conventions"
# → Returns: RESTful patterns, versioning strategy

# Find solutions to similar problems
buddy-remember "session timeout issues"
# → Returns: Past bugs, solutions, and lessons learned

# Check configuration
buddy-remember "database configuration"
# → Returns: Database settings, connection strings (sanitized)
```

**Response Structure (Storage)**:

```
✓ Memory Stored Successfully

📋 Task
Store project decision about database choice

────────────────────────────────────

✓ Results
  status: stored
  knowledge_id: "kb_1234567890"
  tags: ["decision", "database", "postgresql"]
  timestamp: "2026-01-20T10:30:00Z"

────────────────────────────────────

💡 Next Steps
  1. Memory is now searchable
  2. Try: buddy-remember "postgresql" to verify

Duration: 0.8s • Tokens: 300
```

**Response Structure (Recall - With Results)**:

```
✓ Memory Search Complete

📋 Query
postgresql

────────────────────────────────────

✓ Results
  count: 3
  memories:
    1. [2026-01-15] Decision: PostgreSQL for production
       "We decided to use PostgreSQL because..."
       Tags: decision, database, postgresql

    2. [2026-01-18] Configuration: Database connection
       "Production: aws-rds-pg.xyz, port 5432..."
       Tags: configuration, database, postgresql

    3. [2026-01-19] Lesson: Connection pooling
       "Fixed timeout issues by increasing pool size..."
       Tags: lesson, database, performance

────────────────────────────────────

💡 Next Steps
  1. Review memories above for relevant context
  2. Apply these learnings to your current task

Duration: 1.2s • Tokens: 800
```

**Response Structure (Recall - No Results)**:

```
✓ Memory Search Complete

📋 Query
microservices

────────────────────────────────────

✓ Results
  count: 0

────────────────────────────────────

💡 Next Steps
  1. Try a broader search term
  2. Create new memory: buddy-do

Duration: 0.5s • Tokens: 200
```

**Best Practices**:

**Storage**:
- ✅ Be specific and concise
- ✅ Include context (why, when, what)
- ✅ Store as you work, not later
- ✅ Use natural language (the system handles tagging)

**Recall**:
- ✅ Use keywords from your question
- ✅ Try broader terms if no results
- ✅ Search before starting new work
- ✅ Combine with buddy-do for context-aware tasks

**Auto-Tagging**:

The system automatically generates tags based on content:
- **Entities**: Users, products, services, technologies
- **Actions**: Created, updated, fixed, decided
- **Concepts**: Authentication, database, API, testing
- **Types**: Decision, lesson, pattern, configuration

---

### buddy-help

**Purpose**: Quick help and command reference

**Syntax**:
```bash
# Basic help
buddy-help

# Detailed help for all commands
buddy-help --all
```

**Output**:

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

**When to Use**:
- ✅ First-time setup (verify MeMesh is working)
- ✅ Quick command reference
- ✅ Syntax reminders

---

## Real-World Examples

Learn how MeMesh helps you build better software through real project scenarios. These examples demonstrate how MeMesh's persistent memory enhances your workflow across multiple sessions.

### Example 1: Building a REST API (Multi-Day Workflow)

This example shows how MeMesh remembers your architectural decisions and coding patterns across a week-long project.

#### Day 1: Initial Setup

**Your Task**: Start building a REST API for an e-commerce platform

```bash
You: buddy-do "create Express API with user authentication"
```

**What MeMesh Does**:
- Analyzes requirements (Express, authentication, API)
- Routes to backend-developer capability
- Generates complete setup:
  - Express server with middleware
  - JWT authentication system
  - User model and database schema
  - Auth routes (/login, /register, /refresh)

**MeMesh Automatically Remembers**:
```
✅ Tech stack: Express + MongoDB + JWT
✅ Coding style: RESTful, async/await, error handling middleware
✅ File structure: controllers/, models/, routes/, middleware/
✅ Authentication: JWT with 15-min access tokens, 7-day refresh tokens
```

**Store Your Decision**:
```bash
You: buddy-remember "Using JWT for authentication because we need stateless auth for mobile app and easy horizontal scaling"
```

---

#### Day 3: Adding New Features

**Your Task**: Add password reset functionality

```bash
You: buddy-do "add password reset feature"
```

**MeMesh Recalls**:
```
✅ Your auth architecture from Day 1 (JWT tokens, user model)
✅ Email service setup (from Day 2)
✅ Token generation pattern (consistent with existing auth)
```

**Result**:
- Password reset integrates seamlessly with existing auth system
- Uses same JWT library and token patterns
- Follows your established API conventions (/api/v1/auth/reset-password)
- No need to re-explain architecture

**Store the New Pattern**:
```bash
You: buddy-remember "Password reset uses time-limited JWT tokens (15 min expiry) sent via email. Tokens are single-use and invalidated after use."
```

---

#### Day 7: Query Past Decisions

**Your Task**: New team member asks about auth implementation

```bash
You: buddy-remember "why JWT over sessions?"
```

**MeMesh Returns**:
```
Found 3 relevant memories:

1. [Day 1, 2026-01-15] Decision: JWT authentication
   "Using JWT for authentication because we need stateless
   auth for mobile app and easy horizontal scaling"
   Tags: authentication, jwt, architecture, decision

2. [Day 3, 2026-01-17] Pattern: Token expiration
   "JWT tokens: 15-min access, 7-day refresh. Keeps security
   tight while maintaining good UX"
   Tags: jwt, security, tokens

3. [Day 4, 2026-01-18] Lesson: Token refresh
   "Implemented silent refresh. Frontend checks token expiry
   and refreshes 5 minutes before expiration"
   Tags: jwt, frontend, refresh-token
```

**Benefit**: Complete context retrieved in seconds, no digging through Git history or Slack messages.

---

#### Day 10: Bug Fix with Context

**Your Task**: Login fails on mobile app

```bash
You: buddy-remember "mobile authentication"
You: buddy-do "investigate mobile login failures"
```

**MeMesh Uses**:
- Remembers mobile-specific requirements (from Day 1)
- Recalls auth flow implementation (from Day 1-3)
- Checks for related past bugs (searches memory graph)

**Finds the Issue**: Cookie settings incompatible with mobile WebView

**Store the Solution**:
```bash
You: buddy-remember "Mobile login bug: Cookie sameSite attribute must be 'none' for mobile WebView. Fixed by updating Express session config."
```

---

### Example 2: Frontend Development with Design System

**Day 1: Setting Up the Design System**

```bash
You: buddy-do "create design system with Tailwind and component library"
```

**MeMesh Generates**:
- Tailwind configuration with custom colors
- Base component library (Button, Input, Card)
- Typography scale
- Spacing system

**Store Design Decisions**:
```bash
You: buddy-remember "Design system uses 8px spacing scale. Primary color: #3B82F6 (blue-500). Components follow atomic design: atoms → molecules → organisms"
```

---

**Day 4: Building Feature Components**

```bash
You: buddy-do "create product card component with image, title, price, and add-to-cart button"
```

**MeMesh Recalls**:
```
✅ Design system spacing scale (8px grid)
✅ Primary color (#3B82F6)
✅ Existing Button component (reusable)
✅ Component structure pattern (atomic design)
```

**Result**:
- Product card follows established patterns
- Uses existing Button component
- Matches spacing and color scheme
- No style inconsistencies

---

**Day 8: Responsive Design**

```bash
You: buddy-remember "responsive breakpoints"
```

**MeMesh Returns**:
```
Found 2 relevant memories:

1. [Day 2] Configuration: Tailwind breakpoints
   "Using default Tailwind breakpoints: sm (640px),
   md (768px), lg (1024px), xl (1280px)"
   Tags: tailwind, responsive, config

2. [Day 5] Pattern: Mobile-first approach
   "All components built mobile-first, then enhanced
   for larger screens using md: and lg: prefixes"
   Tags: responsive, mobile-first, pattern
```

**Apply Consistently**: Now you know exactly how to make the new component responsive.

---

### Example 3: DevOps and Infrastructure

**Day 1: Setting Up CI/CD**

```bash
You: buddy-do "setup GitHub Actions CI/CD pipeline"
```

**Store Infrastructure Decisions**:
```bash
You: buddy-remember "Using GitHub Actions for CI/CD. Workflow: lint → test → build → deploy to Vercel. Runs on pull requests and main branch merges."
```

---

**Day 5: Adding Environment Variables**

```bash
You: buddy-remember "deployment configuration"
You: buddy-do "add database URL environment variable to deployment"
```

**MeMesh Recalls**:
- CI/CD workflow structure
- Vercel deployment setup
- Existing environment variable pattern

**Adds Variable Correctly**: Uses GitHub Secrets, updates Vercel config, follows naming convention.

---

**Week 2: Troubleshooting Deployment**

```bash
You: buddy-remember "CI/CD issues"
```

**MeMesh Returns**:
```
Found 1 relevant memory:

[Day 8] Lesson: Build cache issue
"GitHub Actions build was failing due to stale cache.
Fixed by adding cache-dependency-path: package-lock.json
to setup-node action"
Tags: github-actions, ci-cd, cache, troubleshooting
```

**Benefit**: Quickly recall solutions to past problems, avoid repeating debugging sessions.

---

### Key Takeaways

#### 1. **Cross-Session Context**
MeMesh maintains context across days and weeks:
- No need to re-explain architecture
- Past decisions inform current work
- Consistent patterns throughout project

#### 2. **Collaborative Memory**
Perfect for teams:
- Onboard new members faster
- Share tribal knowledge
- Document decisions as you make them

#### 3. **Learning from Experience**
Build institutional knowledge:
- Record bugs and solutions
- Track what works and what doesn't
- Prevent repeating mistakes

#### 4. **Natural Workflow**
No disruption to your process:
- Store knowledge as you work
- Recall when you need it
- Automatic memory linking

---

### Next Steps

**Try These Workflows**:
1. **Start a new feature**: `buddy-do "plan [feature]"` → implement → store decisions
2. **Debug an issue**: `buddy-remember "[error]"` → investigate → store solution
3. **Review past work**: `buddy-remember "[topic]"` → understand context

**Best Practices**:
- ✅ Store decisions immediately (don't wait until later)
- ✅ Be specific in memory descriptions (future you will thank you)
- ✅ Query memory before starting new work (leverage past knowledge)
- ✅ Record bugs and solutions (build your knowledge base)

**Learn More**:
- [BEST_PRACTICES.md](./BEST_PRACTICES.md) - Effective workflows and patterns
- [Advanced Usage](#advanced-usage) - Complex scenarios and integrations
- [Memory System](#memory-system) - How the knowledge graph works

---

## MCP Tools

### Advanced MCP Tools

These tools provide lower-level access to MeMesh capabilities. For complete API documentation with detailed schemas, examples, and error handling, see **[API_REFERENCE.md](./api/API_REFERENCE.md)**.

#### memesh-create-entities

**Purpose**: Create knowledge entities with explicit relationships

**Usage**: Advanced users who need fine-grained control over knowledge graph structure

**Quick Example**:
```json
{
  "entities": [
    {
      "name": "PostgreSQL Database Choice 2026-02-03",
      "entityType": "decision",
      "observations": [
        "Chose PostgreSQL over MySQL",
        "Better JSON support and performance"
      ],
      "tags": ["database", "postgresql", "architecture"]
    }
  ]
}
```

**When to Use**:
- Building complex knowledge graphs
- Migrating external knowledge
- Integrating with other systems

📖 **Full Documentation**: [API_REFERENCE.md - memesh-create-entities](./api/API_REFERENCE.md#memesh-create-entities)

#### memesh-generate-tests

**Purpose**: Generate automated test cases using AI

**Aliases**: `generate-tests` (deprecated, will be removed in v3.0.0)

**Parameters**:
- `specification`: Feature spec (optional)
- `code`: Source code (optional)

**Note**: Provide either specification or code.

📖 **Full Documentation**: [API_REFERENCE.md - memesh-generate-tests](./api/API_REFERENCE.md#memesh-generate-tests)

---

### Learning & Error Tracking

#### memesh-record-mistake

**Purpose**: Record errors and mistakes for learning and prevention

**Parameters**:
- `action` (required): What action the AI took
- `errorType` (required): Error classification (`procedure-violation`, `workflow-skip`, `assumption-error`, `validation-skip`, `responsibility-lack`, `firefighting`, `dependency-miss`, `integration-error`, `deployment-error`)
- `userCorrection` (required): User's correction/feedback
- `correctMethod` (required): What should have been done instead
- `impact` (required): Impact of the mistake
- `preventionMethod` (required): How to prevent in future
- `relatedRule` (optional): Related rule/guideline
- `context` (optional): Additional context object

**Quick Example**:
```json
{
  "action": "Used synchronous file read in async handler",
  "errorType": "assumption-error",
  "userCorrection": "This blocks the event loop",
  "correctMethod": "Use fs.promises.readFile() instead of fs.readFileSync()",
  "impact": "Server becomes unresponsive under load",
  "preventionMethod": "Always use async I/O in request handlers"
}
```

**When to Use**:
- After fixing bugs
- Learning from errors
- Building team knowledge
- Preventing repeated mistakes

**Benefits**:
- Automatically stored in knowledge graph
- Searchable via buddy-remember
- Helps prevent repeating errors
- Builds institutional knowledge

📖 **Full Documentation**: [API_REFERENCE.md - memesh-record-mistake](./api/API_REFERENCE.md#memesh-record-mistake)

---

### Complete API Reference

For comprehensive documentation including:
- Detailed input/output schemas
- JSON examples for all tools
- Error codes and handling
- Integration patterns
- Performance characteristics

See **[API_REFERENCE.md](./api/API_REFERENCE.md)**

---

## CLI Commands

### memesh setup

**Purpose**: Interactive configuration wizard

**Features**:
- Auto-detects Claude Code installation
- Generates MCP configuration
- Validates setup
- Tests connection

**Usage**:
```bash
memesh setup
```

**When to Use**:
- First-time installation
- Troubleshooting connection issues
- Reconfiguring after updates

See [QUICK_START.md](./QUICK_START.md) for detailed setup guide.

---

### memesh tutorial

**Purpose**: Interactive 5-minute guided tutorial

**Features**:
- 7-step walkthrough
- Hands-on practice with buddy-do and buddy-remember
- Progress tracking
- Completion certificate

**Usage**:
```bash
memesh tutorial
```

**Steps**:
1. Welcome & Overview
2. Setup Verification
3. First buddy-do Command
4. Memory Storage Demo
5. Memory Recall Demo
6. Advanced Features Preview
7. Next Steps & Resources

**When to Use**:
- Learning MeMesh for the first time
- Refreshing your knowledge
- Training team members

---

### memesh dashboard

**Purpose**: View session health and metrics

**Features**:
- Real-time MCP server status
- Memory usage statistics
- Recent command history
- Performance metrics
- Error log summary

**Usage**:
```bash
memesh dashboard
```

---

### memesh stats

**Purpose**: View usage statistics

**Features**:
- Command frequency analysis
- Token usage trends
- Cost tracking
- Capability usage breakdown
- Memory growth over time

**Usage**:
```bash
memesh stats
memesh stats --day       # Last 24 hours
memesh stats --week      # Last 7 days
memesh stats --month     # Last 30 days
memesh stats --json      # Export as JSON
memesh stats --csv       # Export as CSV
memesh stats --verbose   # Detailed statistics
```

---

### memesh config

**Purpose**: Manage MeMesh configuration

**Subcommands**:

```bash
# Show current configuration
memesh config show

# Validate MCP setup
memesh config validate

# Edit configuration in default editor
memesh config edit

# Reset configuration to defaults
memesh config reset
```

**When to Use**:
- Verifying setup after installation
- Troubleshooting connection issues
- Checking configuration paths

---

### memesh report-issue

**Purpose**: Report bugs or issues

**Usage**:
```bash
memesh report-issue
```

**What it does**:
- Provides GitHub issues link
- Collects system information (future)
- Suggests troubleshooting steps

---

## Memory System

### Knowledge Graph Architecture

MeMesh uses a graph-based knowledge storage system:

```
    ┌─────────────┐
    │  Entities   │  (Users, APIs, Technologies, etc.)
    └──────┬──────┘
           │
           │ has properties
           │
    ┌──────▼──────┐
    │ Properties  │  (name, type, metadata)
    └──────┬──────┘
           │
           │ connected by
           │
    ┌──────▼──────┐
    │  Relations  │  (USES, DEPENDS_ON, CREATED_BY)
    └─────────────┘
```

### Entity Types

**Automatic Classification**:
- `Decision`: Architecture choices, technology selections
- `Pattern`: Code patterns, conventions, standards
- `Lesson`: Bug fixes, learnings, best practices
- `Configuration`: Settings, environment variables
- `Technology`: Tools, frameworks, libraries
- `Feature`: Application features, capabilities
- `Bug`: Issues, problems, error cases
- `Person`: Team members, stakeholders
- `Project`: Projects, repositories, systems

### Relationship Types

- `USES`: Entity A uses Entity B
- `DEPENDS_ON`: Entity A depends on Entity B
- `CREATED_BY`: Entity A created by Entity B
- `RELATES_TO`: General relationship
- `PART_OF`: Entity A is part of Entity B

### Auto-Tracking (Phase 0.6)

**Task Start Tracking**:
When you use `buddy-do`, MeMesh automatically records:
- Task description
- Goal (extracted)
- Reason (if provided)
- Expected outcome (if mentioned)
- Start timestamp

**Memory Linking**:
Memories created during a task are automatically linked to that task.

**Example**:
```bash
buddy-do "implement login feature because users need authentication"

# Auto-tracked:
{
  task: "implement login feature",
  goal: "implement login feature",
  reason: "users need authentication",
  timestamp: "2026-01-20T10:00:00Z"
}

# Later memories automatically linked:
buddy-remember "Using bcrypt for password hashing"
# → Links to login feature task
```

---

## Task Execution

### How Task Execution Works

**1. Task Analysis**:
```
Input: "setup user authentication with JWT"

Analysis:
- Complexity: Medium (~2500 tokens)
- Domain: Backend development
- Required capabilities: [authentication, backend, database]
- Keywords: [authentication, JWT, user, setup]
```

**2. Capability Matching**:
```
Available capabilities:
- backend-developer: 90% match (authentication, database)
- frontend-developer: 20% match (user interface)
- devops: 30% match (deployment considerations)

Selected: backend-developer (highest match)
```

**3. Prompt Enhancement**:
```
Enhanced Prompt:
[System Context]
Project: e-commerce-platform
Tech Stack: Node.js, Express, PostgreSQL
Recent Work: User registration endpoint completed

[Task]
Setup user authentication with JWT

[Context]
- Existing user model in database
- JWT library already installed (jsonwebtoken)
- Environment variables configured for secrets
```

### Capability Catalog

**backend-developer**:
- API development
- Database design
- Server-side logic
- Authentication/authorization
- Data validation

**frontend-developer**:
- UI components
- State management
- Styling and layout
- Client-side logic
- Responsive design

**devops**:
- CI/CD pipelines
- Deployment automation
- Infrastructure configuration
- Monitoring and logging
- Container orchestration

**database-admin**:
- Schema design
- Query optimization
- Migrations
- Backups and recovery
- Performance tuning

**security-expert**:
- Vulnerability assessment
- Authentication systems
- Data encryption
- Security audits
- Compliance

**general-agent**:
- Default fallback
- General questions
- Documentation
- Planning and analysis

---

## Configuration

### MCP Configuration

MeMesh is a Claude Code Plugin. The MCP server is auto-managed via the plugin's `.mcp.json` file — no manual configuration of `~/.claude/mcp_settings.json` is needed.

Simply install MeMesh and restart Claude Code. If auto-configuration fails, run `memesh setup`.

**For Claude Desktop** (not Claude Code CLI), see the Claude Desktop documentation for MCP configuration locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

**Environment Variables**:

- `DEBUG`: Enable debug logging (true/false)
- `MEMESH_DATA_DIR`: Custom data directory (default: ~/.memesh)
- `MEMESH_LOG_LEVEL`: Log level (error/warn/info/debug)

---

## Visual Explorer (Streamlit UI)

MeMesh includes an interactive web UI for exploring your knowledge graph visually.

### Setup

```bash
cd streamlit
pip install -r requirements.txt
streamlit run app.py
```

### Dashboard

The dashboard provides an overview of your knowledge base:

- **Statistics cards**: Entity, relation, observation, and tag counts
- **Entity Type Distribution**: Pie chart showing the breakdown of entity types
- **Top Tags**: Bar chart of most frequently used tags over time
- **Entity Growth**: Cumulative growth chart (day/week/month granularity)
- **Recent Entities**: Table of latest entities with tag and observation counts

### KG Explorer

The Knowledge Graph Explorer provides an interactive graph visualization:

- **Interactive graph**: Drag, zoom, and hover over nodes and edges
- **Color-coded nodes**: Each entity type has a distinct color
- **Relation edges**: Color-coded by relation type (similar_to, solves, caused_by, etc.)
- **Filters**: Search by text (FTS5), entity type, tags, and date range
- **Adjustable density**: Slider to control the number of displayed nodes (10–300)

### Backfilling Relations

If you have existing entities without relations, run the backfill script:

```bash
# Preview what will be created
python streamlit/backfill_relations.py --dry-run

# Execute (creates relations in the database)
python streamlit/backfill_relations.py
```

The script uses a 3-layer strategy: topic/project clustering, cross-type semantic relations, and tag-based similarity.

---

## Advanced Usage

### Workflow Examples

#### Workflow 1: Starting a New Feature

```bash
# 1. Recall relevant context
buddy-remember "similar features"
buddy-remember "architectural patterns"

# 2. Plan implementation
buddy-do "plan user profile feature with avatar upload"

# 3. Execute implementation
buddy-do "implement user profile API endpoints"
buddy-do "create profile UI component"

# 4. Store decisions
buddy-remember "User profile feature uses S3 for avatar storage because it scales better"

# 5. Document patterns
buddy-remember "Profile endpoints follow /api/v1/users/:id/profile pattern"
```

#### Workflow 2: Debugging a Bug

```bash
# 1. Search for similar issues
buddy-remember "login errors"
buddy-remember "session timeout"

# 2. Analyze and fix
buddy-do "investigate why sessions expire immediately after login"

# 3. Record solution
buddy-remember "Login session bug was caused by cookie domain mismatch. Fixed by setting domain to null in session config."
```

#### Workflow 3: Code Review

```bash
# 1. Recall standards
buddy-remember "code review checklist"
buddy-remember "security best practices"

# 2. Review implementation
buddy-do "review authentication implementation for security issues"

# 3. Store findings
buddy-remember "Security review found: need rate limiting on login endpoint to prevent brute force"
```

### Integration with Other Tools

**Git Integration**:
```bash
# Store commit messages as memories
buddy-remember "feat(auth): add JWT authentication"

# Recall to maintain consistency
buddy-remember "recent authentication changes"
```

**CI/CD Integration** (Future):
```bash
# Store deployment info
buddy-remember "Deployment v1.2.3 to production on 2026-01-20, includes authentication feature"

# Query deployment history
buddy-remember "recent deployments"
```

**Testing Integration**:
```bash
# Store test results
buddy-remember "Test suite passing: 245/245 tests, coverage 87%"

# Track test patterns
buddy-remember "Authentication tests use mock JWT tokens"
```

---

## Troubleshooting

### Common Issues

For detailed troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

**Quick Fixes**:

1. **buddy-help not working**
   ```bash
   memesh setup
   # Restart Claude Code
   # Try: buddy-help
   ```

2. **Connection errors**
   ```bash
   memesh config validate
   # Check configuration
   # Restart Claude Code
   ```

3. **Slow responses**
   - Simplify task descriptions
   - Check network connection
   - Review token limits

### Debug Mode

Enable debug logging by setting environment variables `DEBUG=true` and `MEMESH_LOG_LEVEL=debug` in the plugin's `.mcp.json` configuration.

Check logs:
- **macOS**: `~/Library/Logs/Claude/`
- **Windows**: `%APPDATA%\Claude\Logs\`

### Getting Help

1. **Check Documentation**:
   - [QUICK_START.md](./QUICK_START.md) - Getting started
   - [BEST_PRACTICES.md](./BEST_PRACTICES.md) - Effective workflows
   - [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues

2. **Run Commands**:
   ```bash
   memesh tutorial       # Interactive learning
   memesh config validate # Check setup
   memesh report-issue   # Get support
   ```

3. **Community Support**:
   - GitHub Issues: https://github.com/PCIRCLE-AI/claude-code-buddy/issues
   - Discussions: https://github.com/PCIRCLE-AI/claude-code-buddy/discussions

---

## Appendix

### Command Quick Reference

```
┌─────────────────────────────────────────────────────┐
│              MeMesh Command Reference               │
├─────────────────────────────────────────────────────┤
│ MCP Tools (In Claude Code)                          │
│   buddy-do "<task>"       Execute with memory context│
│   buddy-remember "<info>" Store/recall memory       │
│   buddy-help              Quick help guide           │
│                                                      │
│ CLI Commands (In Terminal)                          │
│   memesh setup            Interactive setup wizard  │
│   memesh tutorial         5-minute guided tour      │
│   memesh dashboard        Session health dashboard  │
│   memesh stats            Usage statistics          │
│   memesh config           Manage configuration      │
│   memesh report-issue     Bug reporting             │
└─────────────────────────────────────────────────────┘
```

### Glossary

- **MCP**: Model Context Protocol - Standard for AI tool integration
- **Knowledge Graph**: Graph database storing entities and relationships
- **Capability**: Specialized skill set for task execution
- **Entity**: Node in knowledge graph (user, technology, decision, etc.)
- **Relation**: Edge connecting entities (USES, DEPENDS_ON, etc.)
- **Task Metadata**: Extracted information from task description
- **Prompt Enhancement**: Adding project context to task prompts

### Version History

- **v2.8.0**: Tool naming unification (memesh-* prefix), A2A removal (local-first architecture), Vector semantic search with ONNX embeddings
- **v2.7.0**: Memory retention periods updated (30/90 days), Auto-memory hooks improvements, Documentation updates
- **v2.6.6**: ErrorClassifier integration, Enhanced error handling
- **v2.6.5**: Interactive tutorial, Improved QUICK_START
- **v2.6.4**: Response formatting improvements, Visual hierarchy
- **v2.6.3**: Interactive setup wizard
- **v2.6.2**: Phase 0.6 - Auto-tracking and memory linking
- **v2.6.1**: Performance optimizations
- **v2.6.0**: Smart routing with capability matching

---

**Next Steps**:

1. **Learn More**: Read [BEST_PRACTICES.md](./BEST_PRACTICES.md) for effective workflows
2. **Try It Out**: Run `memesh tutorial` for hands-on practice
3. **Get Support**: Visit our [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
4. **Contribute**: Check [CONTRIBUTING.md](../CONTRIBUTING.md) to get involved

---

**MeMesh** — Persistent memory for Claude Code
