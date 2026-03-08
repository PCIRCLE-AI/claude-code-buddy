# Memory System Best Practices

**Complete guide for effective memory management with MeMesh Plugin memory features**

This guide covers battle-tested strategies for maximizing the value of your memory system through smart tagging, importance scoring, search optimization, and auto-memory configuration.

---

## Table of Contents

- [Memory Importance Guidelines](#memory-importance-guidelines)
- [Effective Tagging Strategy](#effective-tagging-strategy)
- [Search Optimization](#search-optimization)
- [Auto-Memory Configuration](#auto-memory-configuration)
- [Performance Best Practices](#performance-best-practices)
- [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
- [Team Collaboration](#team-collaboration)
- [Migration and Maintenance](#migration-and-maintenance)

---

## Memory Importance Guidelines

### Understanding Importance Scores

Importance determines memory priority in search results and retention policies. Use this scale:

**0.9 - 1.0: Critical Knowledge**
- Fundamental architecture decisions
- Security vulnerabilities and fixes
- Production incidents and root causes
- Breaking changes and migrations
- Core business logic and constraints

\`\`\`typescript
await memoryStore.store({
  type: 'mistake',
  content: 'SQL injection vulnerability in user search endpoint',
  tags: ['security', 'vulnerability', 'sql-injection'],
  importance: 0.95,
  metadata: {
    severity: 'critical',
    cve: 'CVE-2024-12345',
    fixedIn: 'v2.1.0'
  }
}, { projectPath: '/api' });
\`\`\`

**0.7 - 0.89: High Value**
- Design patterns and best practices
- Performance optimizations with significant impact
- Integration guidelines for major services
- Complex bug fixes with detailed RCA
- API design decisions

\`\`\`typescript
await memoryStore.store({
  type: 'decision',
  content: 'Use repository pattern for all database access to enable testing and swapping implementations',
  tags: ['architecture', 'design-pattern', 'repository', 'database'],
  importance: 0.8,
  metadata: {
    impact: 'high',
    affectedModules: ['user-service', 'auth-service', 'order-service']
  }
});
\`\`\`

**0.5 - 0.69: Moderate Value**
- Common development workflows
- Code review feedback patterns
- Minor optimizations
- Team conventions
- Tool usage guidelines

\`\`\`typescript
await memoryStore.store({
  type: 'knowledge',
  content: 'Always run linter before committing to avoid CI failures',
  tags: ['workflow', 'linter', 'ci'],
  importance: 0.6
});
\`\`\`

**0.3 - 0.49: Low Value**
- One-off fixes
- Temporary workarounds
- Documentation updates
- Personal notes
- Learning experiments

\`\`\`typescript
await memoryStore.store({
  type: 'experience',
  content: 'Tried CSS Grid for dashboard layout - works well but switched to Flexbox for better browser support',
  tags: ['frontend', 'css', 'experiment'],
  importance: 0.4
});
\`\`\`

**Below 0.3: Noise**
Avoid storing low-value information that clutters search results.

### Importance Calibration Over Time

**Review and adjust** - Importance isn't static:
- Downgrade temporary workarounds after proper fixes (0.6 → 0.3)
- Upgrade recurring patterns that prove valuable (0.5 → 0.7)
- Critical incidents become less relevant over time (0.95 → 0.7)

---

## Effective Tagging Strategy

### Tag Taxonomy

**Technology Tags** (auto-generated + manual refinement):
\`\`\`typescript
['typescript', 'react', 'nextjs', 'postgresql', 'redis', 'aws']
\`\`\`

**Domain Tags** (categorize by area):
\`\`\`typescript
['authentication', 'api', 'frontend', 'database', 'security', 'performance']
\`\`\`

**Pattern Tags** (highlight design patterns):
\`\`\`typescript
['repository', 'singleton', 'observer', 'factory', 'middleware']
\`\`\`

**Context Tags** (project/team specific):
\`\`\`typescript
['v2-migration', 'legacy-code', 'tech-debt', 'spike', 'poc']
\`\`\`

### Tagging Guidelines

**✅ DO:**
- Use lowercase for all tags (\`typescript\`, not \`TypeScript\`)
- Use hyphens for multi-word tags (\`user-authentication\`, not \`user_authentication\`)
- Include both broad and specific tags (\`['database', 'postgresql', 'query-optimization']\`)
- Add version tags for framework-specific knowledge (\`['react', 'react-18', 'hooks']\`)
- Tag with common search terms (\`['auth', 'authentication', 'login']\`)

**❌ DON'T:**
- Use inconsistent casing (\`TypeScript\`, \`typescript\`, \`TYPESCRIPT\`)
- Over-tag with redundant information (\`['bug', 'issue', 'problem', 'error']\` → \`['bug', 'error']\`)
- Create single-use tags that will never be searched
- Use abbreviations unless they're industry-standard (\`auth\` ✅, \`usr\` ❌)

---

## Search Optimization

### Understanding Search Ranking

MemorySearchEngine uses a **multi-factor scoring system**:

\`\`\`
Final Score = (Content Match + Tag Match + TF Score)
              × Tech Stack Boost
              × Importance
              × Recency Boost
\`\`\`

**Scoring breakdown:**
- **Exact content match**: +100 points
- **Tag match**: +50 points per matching tag
- **TF score**: 0-20 points based on term frequency
- **Tech stack boost**: 1.5× if matches tech stack
- **Importance**: 0.0-1.0 multiplier
- **Recency boost**: 1.2× if <7 days, 1.1× if <30 days

### Search Strategies

**1. Use specific, technical queries:**
\`\`\`typescript
// ❌ Vague
await memoryStore.search('database problem');

// ✅ Specific
await memoryStore.search('PostgreSQL connection pool exhaustion');
\`\`\`

**2. Leverage tech stack context:**
\`\`\`typescript
// Without tech stack - generic results
await memoryStore.search('state management');

// With tech stack - React-specific results
await memoryStore.search('state management', {
  techStack: ['react', 'redux']
});
\`\`\`

**3. Filter by type for targeted results:**
\`\`\`typescript
// Only architectural decisions
await memoryStore.searchByType('decision', 'microservices');

// Only past mistakes to avoid
await memoryStore.searchByType('mistake', 'security');
\`\`\`

---

## Auto-Memory Configuration

### Auto-Tagging Configuration

**Default behavior:**
- Detects 50+ technologies automatically
- Identifies 8 domain areas
- Recognizes 11 design patterns

**Customize tag generation:**
\`\`\`typescript
// Tags are generated inline during memory storage in UnifiedMemoryStore.
// Custom tags you provide are preserved and merged with auto-detected tags.
await memoryStore.store({
  type: 'knowledge',
  content: content,
  tags: ['custom-tag', 'team-specific'], // Preserved; auto-detected tags are added
  importance: 0.7,
  timestamp: new Date(),
}, { projectPath: '/frontend' });
\`\`\`

### Auto-Memory Recorder Configuration

**Default thresholds:**
- Code changes: ≥0.6 importance (4+ files OR 50+ lines)
- Test failures: 0.9 importance (always recorded)
- Test passes: 0.5 importance (usually skipped)
- Git commits: ≥0.6 importance (6+ files OR 100+ changes)
- Errors: 0.95 importance (always recorded)

**Adjust importance threshold:**
\`\`\`typescript
const recorder = new AutoMemoryRecorder(memoryStore);

// Lower threshold to capture more events
recorder.setImportanceThreshold(0.4);

// Higher threshold to reduce noise
recorder.setImportanceThreshold(0.7);
\`\`\`

**Strategic threshold adjustment:**

**Learning Phase** (new project/team member):
\`\`\`typescript
recorder.setImportanceThreshold(0.4);
// Capture more events to build knowledge base quickly
\`\`\`

**Maturity Phase** (established project):
\`\`\`typescript
recorder.setImportanceThreshold(0.7);
// Only significant events to avoid clutter
\`\`\`

---

## Performance Best Practices

### Memory Storage Optimization

**Batch operations** when storing multiple memories:
\`\`\`typescript
// ❌ Slow - multiple transactions
for (const item of items) {
  await memoryStore.store(item);
}

// ✅ Fast - single transaction
await knowledgeGraph.db.transaction(() => {
  for (const item of items) {
    memoryStore.store(item);
  }
})();
\`\`\`

**Metadata size limits:**
- Maximum 10KB per metadata field
- Compress large objects before storing

### Search Performance

**Use type filtering to reduce search space:**
\`\`\`typescript
// ❌ Searches all memories
await memoryStore.search('architecture decision');

// ✅ Searches only decisions
await memoryStore.searchByType('decision', 'architecture');
\`\`\`

**Limit result sets early:**
\`\`\`typescript
// Better: use built-in filters to reduce search space early
const results = await memoryStore.search('query', {
  minImportance: 0.6,
  limit: 20,
});
\`\`\`

---

## Common Pitfalls and Solutions

### Pitfall 1: Over-tagging

**Problem:**
\`\`\`typescript
tags: ['bug', 'issue', 'problem', 'error', 'fix', 'solved', 'resolved']
\`\`\`

**Solution:**
\`\`\`typescript
tags: ['bug-fix', 'authentication', 'csrf']
\`\`\`

### Pitfall 2: Inconsistent Tag Naming

**Problem:**
\`\`\`typescript
tags: ['PostgreSQL', 'postgres', 'pg', 'POSTGRESQL']
\`\`\`

**Solution:**
\`\`\`typescript
tags: ['postgresql']
// Auto-tagger helps with normalization
\`\`\`

### Pitfall 3: Generic Content

**Problem:**
\`\`\`typescript
content: 'Fixed a bug'
\`\`\`

**Solution:**
\`\`\`typescript
content: 'Fixed CSRF vulnerability in login endpoint by validating origin header'
\`\`\`

### Pitfall 4: Ignoring Importance

**Problem:**
\`\`\`typescript
importance: 0.5 // All memories same importance
\`\`\`

**Solution:**
\`\`\`typescript
// Critical security issue
importance: 0.95

// Nice-to-know tip
importance: 0.4
\`\`\`

---

## Summary

**Key Takeaways:**

1. **Importance is critical** - Calibrate importance scores to ensure high-value memories surface first
2. **Tag consistently** - Use lowercase, hyphens, include both broad and specific tags
3. **Leverage auto-memory** - Configure thresholds appropriately for your project phase
4. **Search with context** - Always provide tech stack context for better results
5. **Maintain regularly** - Review, clean up, and optimize your memory store periodically
6. **Metadata matters** - Include rich metadata for better context and searchability

**Resources:**
- [API Reference](./MEMORY_API.md)
- [Integration Testing](../../tests/integration/)

---

**Questions or suggestions?** Open an issue or contribute to this guide!
