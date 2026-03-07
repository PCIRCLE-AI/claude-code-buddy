/**
 * Embeddings Module
 *
 * Provides text-to-vector embedding capabilities for semantic search in MeMesh.
 * Uses the all-MiniLM-L6-v2 ONNX model for generating 384-dimensional embeddings.
 *
 * Components:
 * - ModelManager: Downloads and manages the ONNX embedding model
 * - EmbeddingService: Text-to-vector conversion with LRU cache
 * - VectorSearchAdapter: Strategy interface for vector search backends
 * - SqliteVecAdapter: sqlite-vec implementation of VectorSearchAdapter
 * - InMemoryVectorAdapter: Pure TS implementation for testing
 * - VectorExtension: Legacy static class (kept for backward compatibility)
 */

export { ModelManager } from './ModelManager.js';
export { EmbeddingService, LazyEmbeddingService } from './EmbeddingService.js';

// Vector search abstraction (Strategy pattern)
export type { VectorSearchAdapter } from './VectorSearchAdapter.js';
export { DEFAULT_EMBEDDING_DIMENSIONS } from './VectorSearchAdapter.js';
export type { KnnSearchResult } from './VectorSearchAdapter.js';
export { SqliteVecAdapter } from './SqliteVecAdapter.js';
export { InMemoryVectorAdapter } from './InMemoryVectorAdapter.js';

// Legacy (backward compatibility)
export { VectorExtension } from './VectorExtension.js';
