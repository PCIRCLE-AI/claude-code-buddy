# Memory API Reference

Complete API documentation for MeMesh Plugin memory system.

## Table of Contents

- [Overview](#overview)
- [UnifiedMemoryStore](#unifiedmemorystore)
- [MemorySearchEngine](#memorysearchengine)
- [AutoMemoryRecorder](#automemoryrecorder)
- [Types](#types)
- [Best Practices](#best-practices)
- [Error Handling](#error-handling)
- [Security Considerations](#security-considerations)
- [Performance Tips](#performance-tips)

---

## Overview

The MeMesh memory system provides intelligent storage, retrieval, and organization of development knowledge. All memory operations go through the `UnifiedMemoryStore`, which provides a consistent API for all memory types.

### Key Features

- **Unified Storage**: Single storage layer for all memory types
- **Smart Search**: Context-aware relevance ranking
- **Auto-Tagging**: Automatic technology and domain detection
- **Auto-Recording**: Automatic event detection and storage
- **Type Safety**: Full TypeScript support

---

## UnifiedMemoryStore

The core memory storage and retrieval class.

### Constructor

```typescript
import { UnifiedMemoryStore } from '@pcircle/memesh/memory/UnifiedMemoryStore';
import { KnowledgeGraph } from '@pcircle/memesh/knowledge-graph';

const knowledgeGraph = await KnowledgeGraph.create('/path/to/db');
const memoryStore = new UnifiedMemoryStore(knowledgeGraph);
```

### Methods

#### `store(memory, context?)`

Store a new memory.

**Parameters:**
- `memory: UnifiedMemory` - Memory object to store
- `context?: { projectPath?: string }` - Optional project context

**Returns:** `Promise<string>` - Memory ID

**Throws:**
- `ValidationError` - Invalid memory data
- `OperationError` - Storage operation failed

**Example:**

```typescript
const id = await memoryStore.store({
  type: 'mistake',
  content: 'Forgot to validate user input before processing',
  tags: ['security', 'validation'],
  importance: 0.9,
  timestamp: new Date(),
  metadata: {
    file: 'src/auth.ts',
    line: 42,
  },
}, {
  projectPath: '/my/project',
});

console.log(`Stored memory: ${id}`);
// Output: Stored memory: unified-memory-a1b2c3d4-...
```

**Security Features:**
- ✅ Memory ID validation (must start with `unified-memory-`)
- ✅ Metadata size limit (1MB max)
- ✅ Auto-generates secure ID if not provided

#### `get(id)`

Retrieve a memory by ID.

**Parameters:**
- `id: string` - Memory ID

**Returns:** `Promise<UnifiedMemory | null>` - Memory object or null if not found

**Example:**

```typescript
const memory = await memoryStore.get('unified-memory-123');
if (memory) {
  console.log(`Found memory: ${memory.content}`);
}
```

#### `search(query, options?)`

Search memories with context-aware ranking.

**Parameters:**
- `query: string` - Search query
- `options?: SearchOptions & { projectPath?: string; techStack?: string[] }` - Search options

**Returns:** `Promise<UnifiedMemory[]>` - Ranked memories by relevance

**Example:**

```typescript
const results = await memoryStore.search('authentication', {
  types: ['mistake', 'decision'],
  tags: ['security'],
  minImportance: 0.7,
  timeRange: 'last-30-days',
  limit: 10,
  techStack: ['typescript', 'nodejs'],
});

results.forEach(memory => {
  console.log(`${memory.type}: ${memory.content}`);
});
```

**Search Features:**
- Multi-level scoring (exact match, tag match, content TF)
- Tech stack boost (1.5x multiplier)
- Importance weighting
- Recency boost (1.2x for last 7 days, 1.1x for last 30 days)

#### `searchByType(type, options?)`

Search memories by type.

**Parameters:**
- `type: MemoryType` - Memory type to filter
- `options?: SearchOptions` - Additional search options

**Returns:** `Promise<UnifiedMemory[]>` - Memories of the specified type

**Example:**

```typescript
const mistakes = await memoryStore.searchByType('mistake', {
  minImportance: 0.8,
  limit: 20,
});
```

#### `searchByTags(tags, options?)`

Search memories by tags (OR logic).

**Parameters:**
- `tags: string[]` - Tags to match
- `options?: SearchOptions` - Additional search options

**Returns:** `Promise<UnifiedMemory[]>` - Memories matching any of the tags

**Example:**

```typescript
const securityMemories = await memoryStore.searchByTags(
  ['security', 'vulnerability', 'auth'],
  { minImportance: 0.7 }
);
```

#### `update(id, updates)`

Update an existing memory.

**Parameters:**
- `id: string` - Memory ID
- `updates: Partial<UnifiedMemory>` - Fields to update

**Returns:** `Promise<boolean>` - True if updated, false if not found

**Example:**

```typescript
const success = await memoryStore.update('unified-memory-123', {
  importance: 0.95,
  tags: ['security', 'critical'],
  metadata: { resolved: true },
});
```

#### `delete(id)`

Delete a memory.

**Parameters:**
- `id: string` - Memory ID

**Returns:** `Promise<boolean>` - True if deleted, false if not found

**Example:**

```typescript
const deleted = await memoryStore.delete('unified-memory-123');
```

---

## MemorySearchEngine

Search logic extracted from UnifiedMemoryStore. Handles content-based query filtering, search filter application, result deduplication, and relevance ranking.

### Usage

MemorySearchEngine is used internally by UnifiedMemoryStore. It is not instantiated directly — search operations are accessed through `UnifiedMemoryStore.search()`.

### Search Scoring

MemorySearchEngine uses a **multi-factor scoring system**:

```
Final Score = (Content Match + Tag Match + TF Score)
              × Tech Stack Boost
              × Importance
              × Recency Boost
```

**Scoring breakdown:**
- **Exact content match**: +100 points
- **Tag match**: +50 points per matching tag
- **TF score**: 0-20 points based on term frequency
- **Tech stack boost**: 1.5× if matches tech stack
- **Importance**: 0.0-1.0 multiplier
- **Recency boost**: 1.2× if <7 days, 1.1× if <30 days

### Features

- Content-based query filtering (substring match)
- Search filter application (time range, importance, type, limit)
- Result deduplication by content hash
- Relevance ranking via multi-factor scoring

### Tagging

Tags are generated inline during memory storage in UnifiedMemoryStore. The tagging logic detects:

- **Tech Stack (50+ technologies)**: Languages, frameworks, databases, tools
- **Domain Areas (8 categories)**: Frontend, Backend, Database, Auth, Security, Testing, Performance, DevOps
- **Design Patterns (11 patterns)**: Singleton, Factory, Repository, Observer, Strategy, etc.
- **Scope Tags**: `scope:project` (project-specific), `scope:global` (global knowledge)

---

## AutoMemoryRecorder

Automatic memory recording for significant events.

### Constructor

```typescript
import { AutoMemoryRecorder } from '@pcircle/memesh/memory/AutoMemoryRecorder';

const recorder = new AutoMemoryRecorder(memoryStore);
```

### Methods

#### `recordCodeChange(data)`

Record a code change event.

**Parameters:**
- `data.files: string[]` - Files changed
- `data.linesChanged: number` - Number of lines changed
- `data.description: string` - Change description
- `data.projectPath?: string` - Optional project path

**Returns:** `Promise<string | null>` - Memory ID if recorded, null if skipped

**Example:**

```typescript
const id = await recorder.recordCodeChange({
  files: ['src/auth.ts', 'src/user.ts'],
  linesChanged: 150,
  description: 'Refactor authentication system',
  projectPath: '/my/project',
});

if (id) {
  console.log(`Recorded code change: ${id}`);
}
```

**Importance Scoring:**
- Base: 0.3
- +0.2 if > 3 files
- +0.2 if > 50 lines
- +0.3 if > 100 lines

#### `recordTestEvent(data)`

Record a test event (pass or fail).

**Parameters:**
- `data.type: 'pass' | 'fail'` - Test result
- `data.testName: string` - Test name
- `data.error?: string` - Error message (for failures)
- `data.projectPath?: string` - Optional project path

**Returns:** `Promise<string | null>` - Memory ID if recorded, null if skipped

**Example:**

```typescript
const id = await recorder.recordTestEvent({
  type: 'fail',
  testName: 'should validate user input',
  error: 'Expected validation error, got null',
  projectPath: '/my/project',
});
```

**Importance:**
- Test failures: 0.9 (always important)
- Test passes: 0.5 (moderate)

#### `recordGitCommit(data)`

Record a git commit.

**Parameters:**
- `data.message: string` - Commit message
- `data.filesChanged: number` - Files changed
- `data.insertions: number` - Lines inserted
- `data.deletions: number` - Lines deleted
- `data.projectPath?: string` - Optional project path

**Returns:** `Promise<string | null>` - Memory ID if recorded, null if skipped

**Example:**

```typescript
const id = await recorder.recordGitCommit({
  message: 'feat: implement user authentication',
  filesChanged: 8,
  insertions: 250,
  deletions: 30,
  projectPath: '/my/project',
});
```

**Importance Scoring:**
- Base: 0.4
- +0.2 if > 5 files
- +0.2 if > 100 total changes
- +0.3 if > 200 total changes

#### `recordError(data)`

Record an error or exception.

**Parameters:**
- `data.message: string` - Error message
- `data.stack?: string` - Stack trace
- `data.context?: string` - Error context
- `data.projectPath?: string` - Optional project path

**Returns:** `Promise<string>` - Memory ID (always recorded)

**Example:**

```typescript
const id = await recorder.recordError({
  message: 'Database connection failed',
  stack: error.stack,
  context: 'During user login',
  projectPath: '/my/project',
});
```

**Importance:** Fixed at 0.95 (always critical)

#### `setImportanceThreshold(threshold)`

Set importance threshold for filtering.

**Parameters:**
- `threshold: number` - Threshold (0.0 - 1.0)

**Throws:** `Error` if threshold not in valid range

**Example:**

```typescript
recorder.setImportanceThreshold(0.7); // Only record events with importance >= 0.7
```

---

## Types

### UnifiedMemory

```typescript
interface UnifiedMemory {
  id?: string;                    // Auto-generated if not provided
  type: MemoryType;               // Type of memory
  content: string;                // Memory content (required)
  tags: string[];                 // Tags (auto-generated + manual)
  importance: number;             // Importance score (0.0 - 1.0)
  timestamp: Date;                // When memory was created
  context?: string;               // Additional context
  relations?: string[];           // Related memory IDs
  metadata?: Record<string, any>; // Arbitrary metadata (max 1MB)
}
```

### MemoryType

```typescript
type MemoryType =
  | 'mistake'           // Errors, bugs, failures
  | 'conversation'      // Session snapshots
  | 'knowledge'         // General knowledge
  | 'decision'          // Technical decisions
  | 'experience'        // Learning experiences
  | 'prevention-rule'   // Prevention rules
  | 'user-preference';  // User preferences
```

### SearchOptions

```typescript
interface SearchOptions {
  types?: MemoryType[];           // Filter by types
  tags?: string[];                // Filter by tags (OR)
  minImportance?: number;         // Minimum importance
  timeRange?: TimeRange;          // Time range filter
  limit?: number;                 // Max results
}

type TimeRange = 'last-24h' | 'last-7-days' | 'last-30-days' | 'all';
```

---

## Best Practices

### 1. Memory Importance Guidelines

**Critical (0.9 - 1.0):**
- Security vulnerabilities
- Data corruption issues
- Production failures
- Critical bugs

**High (0.7 - 0.9):**
- Important decisions
- Architecture changes
- Major refactoring
- Significant bugs

**Medium (0.5 - 0.7):**
- Routine decisions
- Code improvements
- Minor bugs
- Useful knowledge

**Low (0.0 - 0.5):**
- Trivial changes
- Formatting fixes
- Minor tweaks

### 2. Tagging Best Practices

**Do:**
- ✅ Use lowercase tags
- ✅ Use hyphens for multi-word tags
- ✅ Be specific (`react-hooks` not just `react`)
- ✅ Include domain tags (`domain:auth`, `domain:frontend`)
- ✅ Let the inline auto-tagging handle tech detection

**Don't:**
- ❌ Use spaces in tags
- ❌ Use special characters
- ❌ Create redundant tags
- ❌ Use inconsistent naming

### 3. Search Optimization

**For Best Results:**
```typescript
// Good: Specific query with context
const results = await memoryStore.search('JWT token expiry', {
  types: ['mistake', 'decision'],
  techStack: ['nodejs', 'express'],
  minImportance: 0.7,
  timeRange: 'last-30-days',
});

// Bad: Too generic
const results = await memoryStore.search('auth');
```

---

## Error Handling

### Error Types

```typescript
import { ValidationError, OperationError, NotFoundError } from '@pcircle/memesh/errors';
```

### Handling Errors

```typescript
try {
  const id = await memoryStore.store({
    id: 'invalid-id',
    type: 'knowledge',
    content: 'Test',
    tags: [],
    importance: 0.5,
    timestamp: new Date(),
  });
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Invalid memory data:', error.message);
    // Handle validation error
  } else if (error instanceof OperationError) {
    console.error('Storage operation failed:', error.message);
    // Handle operation error
  }
}
```

### Common Errors

**ValidationError:**
- Invalid memory ID (must start with `unified-memory-`)
- Empty memory ID
- Missing required fields
- Metadata too large (> 1MB)

**OperationError:**
- Database connection failed
- Storage operation failed
- Search query failed

**NotFoundError:**
- Memory ID not found
- Entity not found in knowledge graph

---

## Security Considerations

### 1. Memory ID Security

**✅ Secure:**
```typescript
// Auto-generated secure ID
await memoryStore.store({
  type: 'knowledge',
  content: 'Test',
  tags: [],
  importance: 0.5,
  timestamp: new Date(),
});

// Valid external ID
await memoryStore.store({
  id: 'unified-memory-a1b2c3d4-5678-90ab-cdef-1234567890ab',
  type: 'knowledge',
  content: 'Test',
  tags: [],
  importance: 0.5,
  timestamp: new Date(),
});
```

**❌ Insecure:**
```typescript
// Invalid prefix - will throw ValidationError
await memoryStore.store({
  id: 'malicious-id',
  type: 'knowledge',
  content: 'Test',
  tags: [],
  importance: 0.5,
  timestamp: new Date(),
});
```

### 2. Metadata Size Limits

**✅ Safe:**
```typescript
const metadata = {
  description: 'Small metadata object',
  files: ['file1.ts', 'file2.ts'],
};

await memoryStore.store({
  type: 'knowledge',
  content: 'Test',
  tags: [],
  importance: 0.5,
  timestamp: new Date(),
  metadata,
});
```

**❌ Unsafe:**
```typescript
const metadata = {
  largeData: 'x'.repeat(2 * 1024 * 1024), // 2MB
};

// Will throw ValidationError: Metadata size exceeds limit
await memoryStore.store({
  type: 'knowledge',
  content: 'Test',
  tags: [],
  importance: 0.5,
  timestamp: new Date(),
  metadata,
});
```

### 3. SQL Injection Prevention

The system uses parameterized queries and proper escaping:

```typescript
// Safe: All searches use parameterized queries
const results = await memoryStore.search("'; DROP TABLE --");
// Query is safely escaped, no SQL injection
```

---

## Performance Tips

### 1. Batch Operations

**❌ Slow:**
```typescript
for (const item of items) {
  await memoryStore.store(item);
}
```

**✅ Fast:**
```typescript
await Promise.all(items.map(item => memoryStore.store(item)));
```

### 2. Use Filters

**❌ Inefficient:**
```typescript
const all = await memoryStore.search('');
const filtered = all.filter(m => m.importance >= 0.8);
```

**✅ Efficient:**
```typescript
const filtered = await memoryStore.search('', {
  minImportance: 0.8,
});
```

### 3. Limit Results

**❌ Memory-intensive:**
```typescript
const all = await memoryStore.search('test');
```

**✅ Memory-efficient:**
```typescript
const top10 = await memoryStore.search('test', { limit: 10 });
```

### 4. Time Range Filtering

**❌ Slow:**
```typescript
const all = await memoryStore.search('');
const recent = all.filter(m => {
  const age = Date.now() - m.timestamp.getTime();
  return age < 7 * 24 * 60 * 60 * 1000;
});
```

**✅ Fast:**
```typescript
const recent = await memoryStore.search('', {
  timeRange: 'last-7-days',
});
```

---

## See Also

- [User Guide](../USER_GUIDE.md)
- [API Reference](./API_REFERENCE.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Contributing](../CONTRIBUTING.md)
