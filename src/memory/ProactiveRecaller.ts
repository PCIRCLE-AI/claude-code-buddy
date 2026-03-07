/**
 * ProactiveRecaller - Automatically surfaces relevant memories
 *
 * Builds optimized search queries based on trigger type (session-start,
 * test-failure, error-detection) and recalls relevant entities from the
 * knowledge graph using hybrid search.
 */

import type { KnowledgeGraph } from '../knowledge-graph/index.js';
import type { SemanticSearchResult } from '../knowledge-graph/KGSearchEngine.js';
import { logger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type RecallTrigger = 'session-start' | 'test-failure' | 'error-detection';

export interface RecallContext {
  projectName?: string;
  recentCommits?: string[];
  testName?: string;
  errorMessage?: string;
  errorType?: string;
}

export interface RecallResult {
  entityName: string;
  observations: string[];
  similarity: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Matches conventional commit prefixes like "fix:", "feat(scope):", "chore(deps):"
 */
const CONVENTIONAL_COMMIT_PREFIX = /^[a-z]+(?:\([^)]*\))?:\s*/;

/**
 * Search parameters per trigger type.
 */
const TRIGGER_SEARCH_OPTIONS: Record<RecallTrigger, { limit: number; minSimilarity: number }> = {
  'session-start': { limit: 5, minSimilarity: 0.5 },
  'test-failure': { limit: 3, minSimilarity: 0.6 },
  'error-detection': { limit: 3, minSimilarity: 0.6 },
};

// ── Class ──────────────────────────────────────────────────────────────

export class ProactiveRecaller {
  private readonly knowledgeGraph: KnowledgeGraph;

  constructor(knowledgeGraph: KnowledgeGraph) {
    this.knowledgeGraph = knowledgeGraph;
  }

  /**
   * Build an optimized search query for the given trigger and context.
   */
  buildQuery(trigger: RecallTrigger, context: RecallContext): string {
    switch (trigger) {
      case 'session-start':
        return this.buildSessionStartQuery(context);
      case 'test-failure':
        return this.buildTestFailureQuery(context);
      case 'error-detection':
        return this.buildErrorDetectionQuery(context);
    }
  }

  /**
   * Recall relevant memories from the knowledge graph.
   * Returns empty array on error (never throws).
   */
  async recall(trigger: RecallTrigger, context: RecallContext): Promise<RecallResult[]> {
    const query = this.buildQuery(trigger, context);
    if (!query) {
      return [];
    }

    try {
      const options = TRIGGER_SEARCH_OPTIONS[trigger];
      const results = await this.knowledgeGraph.hybridSearch(query, options);
      return results.map(this.mapToRecallResult);
    } catch (error) {
      logger.warn('ProactiveRecaller.recall failed', { trigger, error });
      return [];
    }
  }

  /**
   * Format recall results as human-readable text for hook output.
   */
  static formatForHookOutput(results: RecallResult[]): string {
    if (results.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const result of results) {
      const pct = Math.round(result.similarity * 100);
      lines.push(`- ${result.entityName} (${pct}% match)`);
      for (const obs of result.observations.slice(0, 2)) {
        lines.push(`  - ${obs}`);
      }
    }
    return lines.join('\n');
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildSessionStartQuery(context: RecallContext): string {
    const parts: string[] = [];

    if (context.projectName) {
      parts.push(context.projectName);
    }

    if (context.recentCommits?.length) {
      const cleaned = context.recentCommits.map((msg) =>
        msg.replace(CONVENTIONAL_COMMIT_PREFIX, '').trim()
      );
      parts.push(...cleaned);
    }

    return parts.join(' ');
  }

  private buildTestFailureQuery(context: RecallContext): string {
    const parts: string[] = [];

    if (context.testName) {
      // Extract function/test name after :: separator
      const separatorIdx = context.testName.indexOf('::');
      const name = separatorIdx >= 0
        ? context.testName.slice(separatorIdx + 2)
        : context.testName;
      parts.push(name.trim());
    }

    if (context.errorMessage) {
      parts.push(context.errorMessage);
    }

    return parts.join(' ');
  }

  private buildErrorDetectionQuery(context: RecallContext): string {
    const parts: string[] = [];

    if (context.errorType) {
      parts.push(context.errorType);
    }

    if (context.errorMessage) {
      // Use only the first line of the error message
      const firstLine = context.errorMessage.split('\n')[0].trim();
      parts.push(firstLine);
    }

    return parts.join(' ');
  }

  private mapToRecallResult(result: SemanticSearchResult): RecallResult {
    return {
      entityName: result.entity.name,
      observations: result.entity.observations,
      similarity: result.similarity,
    };
  }
}
