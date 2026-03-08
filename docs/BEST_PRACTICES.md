# Best Practices
## Effective Workflows for MeMesh Plugin

This guide provides proven workflows and best practices for using MeMesh effectively in your daily development work.

---

## Table of Contents

1. [Core Principles](#core-principles)
2. [Memory Management](#memory-management)
3. [Effective Task Descriptions](#effective-task-descriptions)
4. [Workflow Patterns](#workflow-patterns)
5. [Team Collaboration](#team-collaboration)
6. [Performance Optimization](#performance-optimization)
7. [Common Anti-Patterns](#common-anti-patterns)
8. [Advanced Techniques](#advanced-techniques)

---

## Core Principles

### 1. Memory First

**Always search before creating**:
```bash
# ❌ Bad: Start working without context
buddy-do "implement login feature"

# ✅ Good: Check for existing knowledge first
buddy-remember "authentication"
buddy-remember "login implementation"
# Then work with context
buddy-do "implement login feature using our existing auth patterns"
```

**Why**: Past decisions and solutions save time and ensure consistency.

---

### 2. Store As You Work

**Record decisions immediately**:
```bash
# ❌ Bad: Wait until end of day to record
# ... work all day ...
# Try to remember what you decided

# ✅ Good: Store immediately after decision
buddy-remember "Chose bcrypt over argon2 because team familiarity and proven track record"
```

**Why**: Fresh memories are more accurate and detailed.

---

### 3. Context Over Keywords

**Provide rich context**:
```bash
# ❌ Bad: Minimal information
buddy-remember "using JWT"

# ✅ Good: Full context with reasoning
buddy-remember "Using JWT for authentication because it's stateless, scales horizontally, and works well with our microservices architecture. Token expiry set to 24 hours for security balance."
```

**Why**: Future you (and your team) will need the "why", not just the "what".

---

### 4. Progressive Complexity

**Start simple, then enhance**:
```bash
# ✅ Good: Progressive refinement
buddy-do "plan user authentication system"
# Review plan
buddy-remember "Auth system will use JWT + refresh tokens"
# Implement
buddy-do "implement JWT authentication middleware"
# Test and refine
buddy-remember "JWT middleware handles token refresh automatically"
```

**Why**: Incremental progress with knowledge capture builds better systems.

---

## Memory Management

### Storage Patterns

#### Decision Recording

**Template**:
```
We [decision] because [reason]

Example:
buddy-remember "We chose PostgreSQL over MongoDB because we need ACID transactions for financial data and have complex relational queries"
```

#### Pattern Documentation

**Template**:
```
All [entity type] follow [pattern] for [reason]

Example:
buddy-remember "All API endpoints follow /api/v1/{resource} pattern for consistent versioning and client compatibility"
```

#### Lesson Learned

**Template**:
```
[Problem] was caused by [root cause]. Fixed by [solution]

Example:
buddy-remember "Memory leak in user service was caused by unclosed database connections. Fixed by implementing connection pooling with 'pg-pool' and proper cleanup in finally blocks"
```

#### Configuration Tracking

**Template**:
```
[Environment] uses [configuration] for [purpose]

Example:
buddy-remember "Production uses AWS RDS PostgreSQL t3.large with 500GB SSD for main database, Multi-AZ for high availability"
```

---

### Search Strategies

#### Keyword Search

**Use domain terms**:
```bash
# ✅ Good: Specific domain keywords
buddy-remember "JWT token expiry policy"
buddy-remember "database migration process"
buddy-remember "error handling patterns"
```

#### Temporal Search

**Include timeframe hints**:
```bash
buddy-remember "recent authentication changes"
buddy-remember "last week's bug fixes"
buddy-remember "current API version"
```

#### Problem-Solution Search

**Frame as question or problem**:
```bash
buddy-remember "how to handle session timeout"
buddy-remember "why login fails intermittently"
buddy-remember "database connection pool sizing"
```

---

### Memory Hygiene

#### Regular Reviews

**Weekly review pattern**:
```bash
# Monday: Review last week's decisions
buddy-remember "decisions last week"

# Friday: Document this week's learnings
buddy-remember "Store summary: This week we implemented X, learned Y, decided Z"
```

#### Consolidation

**Merge related memories**:
```bash
# After several auth-related memories
buddy-remember "Authentication system overview: Uses JWT with 24h expiry, refresh tokens stored in Redis, bcrypt for passwords, rate limiting on /login"
```

#### Archival

**Mark outdated knowledge**:
```bash
buddy-remember "DEPRECATED: Old auth system used sessions. Now using JWT as of 2026-01-20"
```

---

## Effective Task Descriptions

### Task Decomposition

**Break down complex tasks**:
```bash
# ❌ Bad: Single massive task
buddy-do "implement complete user management system with auth, profiles, permissions, and admin dashboard"

# ✅ Good: Decomposed tasks
buddy-do "plan user management system architecture"
# Review plan
buddy-do "implement user authentication with JWT"
buddy-do "implement user profile CRUD operations"
buddy-do "implement role-based permissions"
buddy-do "implement admin dashboard UI"
```

**Benefits**:
- Clearer routing to specialized capabilities
- Easier to track progress
- Better context for each subtask
- More manageable complexity

---

### Task Description Quality

**Effective task descriptions**:

✅ **Good Examples**:
```bash
# Specific and goal-oriented
buddy-do "refactor user service to use dependency injection for better testability"

# Includes constraints
buddy-do "implement rate limiting middleware that allows 100 requests per minute per IP"

# Provides context
buddy-do "fix login bug where sessions expire immediately - likely related to cookie domain configuration"
```

❌ **Bad Examples**:
```bash
# Too vague
buddy-do "make the app better"

# Multiple unrelated tasks
buddy-do "fix login, add dark mode, update docs, and deploy to staging"

# Missing context
buddy-do "implement the thing we discussed"
```

---

### Capability Hints

**Guide routing with keywords**:
```bash
# Frontend-focused
buddy-do "create React component for user profile with Tailwind styling"

# Backend-focused
buddy-do "implement GraphQL API endpoint for user queries with authentication"

# DevOps-focused
buddy-do "setup GitHub Actions workflow for automated testing and deployment"

# Security-focused
buddy-do "audit authentication system for security vulnerabilities and SQL injection"
```

---

## Workflow Patterns

### Daily Development Workflow

```
Morning:
1. buddy-remember "yesterday's work"
2. buddy-remember "current sprint tasks"
3. Review and plan day's work

During Work:
4. buddy-do "<task>" for each feature/fix
5. buddy-remember "<decision>" after decisions
6. buddy-remember "<lesson>" after solving problems

End of Day:
7. buddy-remember "Today completed: <summary>"
8. buddy-remember "Blocked on: <issues>" (if any)
9. buddy-remember "Tomorrow: <plan>"
```

---

### Feature Development Workflow

```
Phase 1: Research & Planning
→ buddy-remember "similar features"
→ buddy-remember "architectural patterns"
→ buddy-do "plan <feature> architecture"
→ buddy-remember "Architectural decision: <reasoning>"

Phase 2: Implementation
→ buddy-do "implement <feature> backend"
→ buddy-remember "Implementation uses: <technology stack>"
→ buddy-do "implement <feature> frontend"
→ buddy-remember "UI pattern follows: <design system>"

Phase 3: Testing & Documentation
→ buddy-do "create tests for <feature>"
→ buddy-remember "Test coverage: <metrics>"
→ buddy-remember "Feature documentation: <summary>"

Phase 4: Review & Learn
→ buddy-do "review <feature> implementation"
→ buddy-remember "Lessons learned: <insights>"
```

---

### Bug Fix Workflow

```
Step 1: Research
→ buddy-remember "<error message>"
→ buddy-remember "similar bugs"

Step 2: Investigation
→ buddy-do "investigate <bug description>"
→ buddy-remember "Root cause: <analysis>"

Step 3: Fix Implementation
→ buddy-do "fix <bug> by <approach>"
→ buddy-remember "Bug fix: <problem> caused by <cause>. Fixed by <solution>"

Step 4: Prevention
→ buddy-do "add tests to prevent <bug> regression"
→ buddy-remember "Prevention: Added <tests> to catch <condition>"
```

---

### Code Review Workflow

```
Preparation:
→ buddy-remember "code review checklist"
→ buddy-remember "coding standards"

Review:
→ buddy-do "review <component> for <criteria>"
→ buddy-remember "Review findings: <issues found>"

Follow-up:
→ buddy-do "suggest improvements for <component>"
→ buddy-remember "Recommended improvements: <suggestions>"
```

---

## Team Collaboration

### Onboarding New Team Members

**Create onboarding guide**:
```bash
# Store essential information
buddy-remember "Project architecture: Microservices with React frontend, Node.js backend, PostgreSQL database"

buddy-remember "Development workflow: Feature branches → PR → Code review → Staging → Production"

buddy-remember "Key conventions: API uses /api/v1 prefix, all async functions use try-catch, tests required for PRs"
```

**Share common queries**:
```bash
# New team member can search
buddy-remember "how to setup development environment"
buddy-remember "testing practices"
buddy-remember "deployment process"
```

---

### Knowledge Sharing

**Document tribal knowledge**:
```bash
buddy-remember "Why we use Redis: Session storage needs high performance, Redis provides sub-millisecond latency and automatic expiry"

buddy-remember "Production deployment checklist: 1. Run migrations, 2. Deploy backend, 3. Verify health, 4. Deploy frontend, 5. Smoke tests"

buddy-remember "Common gotchas: Database connection pool exhaustion happens under load. Monitor pool size and connection count"
```

---

### Decision Documentation

**Record team decisions**:
```bash
buddy-remember "Team decision 2026-01-20: Migrate from REST to GraphQL for flexible querying. Agreed in sprint planning, starts Q2"

buddy-remember "Architecture decision: Microservices communicate via event bus (RabbitMQ) for loose coupling and scalability"
```

---

## Performance Optimization

### Efficient Searches

**Optimize query patterns**:
```bash
# ❌ Slow: Too broad
buddy-remember "everything about auth"

# ✅ Fast: Specific keywords
buddy-remember "JWT expiry policy"
```

---

### Batch Operations

**Group related queries**:
```bash
# ❌ Inefficient: Multiple separate queries
buddy-remember "API patterns"
buddy-remember "API versioning"
buddy-remember "API error handling"

# ✅ Efficient: Combined search or comprehensive storage
buddy-remember "API conventions: RESTful /api/v1 prefix, JSON responses, standard error format {error, message, code}"
```

---

### Storage Efficiency

**Be concise but complete**:
```bash
# ❌ Too verbose
buddy-remember "So we had this really long meeting and after discussing for hours we finally decided that maybe we should probably use PostgreSQL..."

# ✅ Concise and clear
buddy-remember "Chose PostgreSQL after evaluating MongoDB and MySQL. Decision factors: ACID compliance, JSON support, team expertise"
```

---

## Common Anti-Patterns

### Anti-Pattern 1: Memory Hoarding

**Problem**:
```bash
# Storing everything without filtering
buddy-remember "Clicked save button"
buddy-remember "Opened file"
buddy-remember "Took break"
```

**Solution**:
```bash
# Store meaningful information only
buddy-remember "Implemented save functionality with optimistic updates for better UX"
```

---

### Anti-Pattern 2: Vague Memories

**Problem**:
```bash
buddy-remember "Fixed bug"
buddy-remember "Updated code"
```

**Solution**:
```bash
buddy-remember "Fixed race condition in user service where concurrent requests created duplicate records. Added database constraint and request deduplication"
```

---

### Anti-Pattern 3: Never Searching

**Problem**:
```bash
# Always creating new, never recalling
buddy-do "implement authentication"
# Reinvents patterns that already exist
```

**Solution**:
```bash
# Search first
buddy-remember "authentication patterns"
buddy-remember "existing auth implementation"
# Then build with context
buddy-do "implement authentication following existing patterns"
```

---

### Anti-Pattern 4: Task Overloading

**Problem**:
```bash
buddy-do "implement entire e-commerce platform with cart, checkout, payments, shipping, inventory, admin panel"
```

**Solution**:
```bash
buddy-do "plan e-commerce platform architecture"
# Then break into manageable tasks
buddy-do "implement shopping cart functionality"
buddy-do "implement checkout process"
# etc.
```

---

### Anti-Pattern 5: Context-Free Storage

**Problem**:
```bash
buddy-remember "Using Redis"
buddy-remember "JWT expiry: 24h"
```

**Solution**:
```bash
buddy-remember "Using Redis for session storage because of sub-millisecond latency and built-in expiry"
buddy-remember "JWT expiry set to 24 hours balancing security (limited exposure) and UX (not requiring frequent re-login)"
```

---

## Advanced Techniques

### Templated Memories

**Create reusable templates**:
```bash
# Decision template
buddy-remember "DECISION: [What] because [Why]. Alternatives considered: [Options]. Trade-offs: [Pros/Cons]"

# Bug fix template
buddy-remember "BUG FIX: [Problem] caused by [Root Cause]. Fixed by [Solution]. Prevented by [Tests/Checks]"

# Pattern template
buddy-remember "PATTERN: All [Entity] follow [Pattern] for [Reason]. Example: [Code/Link]"
```

---

### Hierarchical Knowledge

**Build knowledge layers**:
```bash
# Layer 1: High-level architecture
buddy-remember "System architecture: Microservices - API Gateway, Auth Service, User Service, Order Service, Payment Service"

# Layer 2: Service details
buddy-remember "User Service: Node.js + Express, PostgreSQL, REST API, handles user CRUD and profile management"

# Layer 3: Implementation specifics
buddy-remember "User Service authentication: JWT middleware validates tokens, checks permissions, injects user context"
```

---

### Cross-Referencing

**Link related knowledge**:
```bash
buddy-remember "Authentication uses JWT (see: JWT configuration). Tokens stored in Redis (see: Redis setup). Refresh every 24h (see: Token expiry policy)"
```

---

### Version Tracking

**Track changes over time**:
```bash
buddy-remember "API v1: REST endpoints, deprecated 2026-01"
buddy-remember "API v2: GraphQL, launched 2026-01, current standard"
buddy-remember "API migration guide: v1→v2 mapping at /docs/api-migration"
```

---

### Problem-Solution Pairs

**Document troubleshooting**:
```bash
buddy-remember "PROBLEM: High database CPU usage. CAUSE: Missing index on users.email. SOLUTION: Added index, CPU dropped 80%"

buddy-remember "PROBLEM: Intermittent 500 errors. CAUSE: Connection pool exhaustion. SOLUTION: Increased pool size from 10 to 50, added connection monitoring"
```

---

## Workflow Checklists

### Daily Checklist

```
□ Morning recall: buddy-remember "yesterday's progress"
□ Check blockers: buddy-remember "known issues"
□ Plan day: buddy-do "plan today's tasks"
□ During work: Store decisions as they happen
□ End of day: buddy-remember "today's summary"
□ Document blockers: buddy-remember "tomorrow's priorities"
```

---

### Feature Completion Checklist

```
□ Feature implemented: buddy-do "implement <feature>"
□ Tests written: buddy-do "create tests for <feature>"
□ Documentation: buddy-remember "<feature> documentation"
□ Decisions recorded: buddy-remember "<key decisions>"
□ Patterns documented: buddy-remember "<reusable patterns>"
□ Lessons captured: buddy-remember "<learnings>"
```

---

### Sprint Planning Checklist

```
□ Review last sprint: buddy-remember "last sprint summary"
□ Recall lessons: buddy-remember "lessons learned"
□ Check patterns: buddy-remember "development patterns"
□ Plan architecture: buddy-do "plan sprint features"
□ Document plan: buddy-remember "sprint plan <summary>"
□ Set expectations: buddy-remember "sprint goals and estimates"
```

---

## Summary

### Key Takeaways

1. **Search First**: Always check existing knowledge before starting work
2. **Store Immediately**: Record decisions and learnings as they happen
3. **Provide Context**: Include the "why", not just the "what"
4. **Break Down Tasks**: Decompose complex work into manageable pieces
5. **Be Specific**: Clear, detailed descriptions lead to better results
6. **Review Regularly**: Weekly reviews keep knowledge fresh and relevant
7. **Share Knowledge**: Document for your team, not just yourself
8. **Template Consistently**: Use consistent formats for similar memories

### Quick Reference

```
┌────────────────────────────────────────────────┐
│          MeMesh Best Practices                  │
├────────────────────────────────────────────────┤
│ Memory Management                               │
│   ✓ Search before creating                     │
│   ✓ Store as you work                          │
│   ✓ Include context and reasoning              │
│   ✓ Review and consolidate weekly              │
│                                                 │
│ Task Descriptions                               │
│   ✓ Break down complex tasks                   │
│   ✓ Use specific, goal-oriented descriptions   │
│   ✓ Provide constraints and context            │
│   ✓ Guide with capability keywords             │
│                                                 │
│ Workflows                                       │
│   ✓ Follow structured patterns                 │
│   ✓ Document at each phase                     │
│   ✓ Capture lessons learned                    │
│   ✓ Share team knowledge                       │
└────────────────────────────────────────────────┘
```

---

**Next Steps**:

1. **Try a workflow**: Pick one pattern from this guide and use it today
2. **Review your memories**: Check if they follow best practices
3. **Share with team**: Establish team-wide conventions
4. **Iterate**: Refine your patterns based on what works

---

For more information:
- [User Guide](./USER_GUIDE.md) - Complete command reference
- [Quick Start](./QUICK_START.md) - Getting started guide
- [Troubleshooting](./TROUBLESHOOTING.md) - Common issues and solutions

**MeMesh** — Persistent memory for Claude Code
