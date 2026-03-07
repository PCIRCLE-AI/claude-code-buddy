/**
 * Memory Module Index
 *
 * Exports the unified memory system components.
 *
 * Phase 0.7.0 Memory System Upgrade:
 * - UnifiedMemoryStore: Single storage layer using KnowledgeGraph
 * - Fixes the FATAL FLAW where buddy-record-mistake and buddy-remember
 *   stored/searched in different places
 */

// Core unified memory store
export { UnifiedMemoryStore } from './UnifiedMemoryStore.js';

// Memory search engine (search, filter, rank, dedup)
export { MemorySearchEngine } from './MemorySearchEngine.js';

// Proactive memory recall (session-start, test-failure, error-detection triggers)
export { ProactiveRecaller } from './ProactiveRecaller.js';
export type { RecallTrigger, RecallContext, RecallResult } from './ProactiveRecaller.js';

// Mistake Pattern Engine for prevention rules
export { MistakePatternEngine } from './MistakePatternEngine.js';

// Enhanced retrieval with basic search (exact + tag match)
// Intelligence (semantic understanding, relevance ranking) delegated to Claude via MCP tool descriptions
export { EnhancedRetrieval } from './EnhancedRetrieval.js';
export type { EnhancedSearchOptions, EnhancedSearchResult, MatchType } from './EnhancedRetrieval.js';

// User preference engine for learning from mistakes
export { UserPreferenceEngine } from './UserPreferenceEngine.js';

// Memory types
export type {
  MemoryType,
  UnifiedMemory,
  SearchOptions,
  SearchResult,
} from './types/index.js';

export {
  MEMORY_TYPE_TO_ENTITY_TYPE,
  ENTITY_TYPE_TO_MEMORY_TYPE,
} from './types/index.js';

// Preference types
export type {
  PreferenceCategory,
  PreferenceConfidence,
  UserPreference,
  PreferenceViolation,
  PreferencePattern,
} from './types/index.js';

// Legacy exports (for backward compatibility)
export { EntityType, isValidEntityType, getAllEntityTypes } from './EntityTypes.js';
export { ProjectAutoTracker } from './ProjectAutoTracker.js';
export { ProjectMemoryManager } from './ProjectMemoryManager.js';
export { ProjectMemoryCleanup } from './ProjectMemoryCleanup.js';
