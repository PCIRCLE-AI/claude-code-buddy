export { openDatabase, closeDatabase, getDatabase } from './db.js';
export { KnowledgeGraph } from './knowledge-graph.js';
export type { Entity, Relation, CreateEntityInput, SearchOptions } from './knowledge-graph.js';

// Anthropic memory tool (`memory_20250818`). Exported from the package root
// because the audience is an application calling the Messages API directly —
// it has no reason to know MeMesh's internal module layout, and the documented
// example imports from here.
export {
  handleMemoryCommand,
  MEMORY_TOOL_DEFINITION,
  MEMORY_ROOT,
} from './core/memory-tool.js';
export type { MemoryCommand, MemoryToolResult } from './core/memory-tool.js';
