import { createHash } from 'crypto';

/**
 * Content hashing utilities for embedding deduplication.
 * Produces deterministic hashes for entity content to detect
 * when embeddings need regeneration.
 */
export class ContentHasher {
  /**
   * Hash the source text that would be used for embedding generation.
   * Uses SHA-256 truncated to 16 hex chars for compact storage.
   *
   * @param entityName - Entity name
   * @param observations - Entity observations
   * @returns 16-char hex hash string
   */
  static hashEmbeddingSource(entityName: string, observations: string[] = []): string {
    const text = [entityName, ...observations].join(' ');
    return createHash('sha256').update(text).digest('hex').substring(0, 16);
  }
}
