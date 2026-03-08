import { z } from 'zod';
import type { ProjectMemoryManager } from '../../memory/ProjectMemoryManager.js';
import type { ResponseFormatter } from '../../ui/ResponseFormatter.js';
import type { KnowledgeGraph, SemanticSearchResult } from '../../knowledge-graph/index.js';
import type { Entity } from '../../knowledge-graph/types.js';
import { logger } from '../../utils/logger.js';
import { getRecoverySuggestion } from '../../utils/errorHandler.js';

/**
 * Search mode for buddy-remember
 * - semantic: Uses AI embeddings for similarity search (requires embeddings in DB)
 * - keyword: Traditional keyword matching (FTS5 + LIKE)
 * - hybrid: Combines semantic and keyword search (default)
 */
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

export const BuddyRememberInputSchema = z.object({
  query: z.string().trim().min(1).describe('Search query (natural language supported for semantic search)'),
  mode: z
    .enum(['semantic', 'keyword', 'hybrid'])
    .optional()
    .default('hybrid')
    .describe('Search mode: semantic (AI similarity), keyword (exact match), hybrid (both combined)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum number of results to return'),
  matchThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.3)
    .describe('Minimum match score (0-1). Higher values return fewer but more relevant results. Default: 0.3'),
  allProjects: z
    .boolean()
    .optional()
    .default(false)
    .describe('Search across all projects (default: false, searches only current project + global memories)'),
});

export type ValidatedBuddyRememberInput = z.infer<typeof BuddyRememberInputSchema>;

/**
 * Format search results for display
 */
function formatSearchResults(
  results: SemanticSearchResult[],
  searchMethod: string,
  query: string
): string {
  const lines = [`Found ${results.length} memories (${searchMethod}):\n`];

  results.forEach((r, index) => {
    const matchPercent = Math.round(r.similarity * 100);
    lines.push(`${index + 1}. **${r.entity.name}** (${matchPercent}% match)`);
    lines.push(`   Type: ${r.entity.entityType}`);

    if (r.entity.observations?.length) {
      lines.push(`   Observations:`);
      r.entity.observations.slice(0, 3).forEach(obs => {
        lines.push(`   - ${obs.slice(0, 100)}${obs.length > 100 ? '...' : ''}`);
      });
      if (r.entity.observations.length > 3) {
        lines.push(`   - ... and ${r.entity.observations.length - 3} more`);
      }
    }

    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Perform keyword search using the knowledge graph with project filtering
 */
async function keywordSearch(
  knowledgeGraph: KnowledgeGraph,
  query: string,
  limit: number,
  options?: { projectPath?: string; allProjects?: boolean }
): Promise<SemanticSearchResult[]> {
  const { projectPath, allProjects = false } = options || {};

  // If allProjects is true or no projectPath, search without tag filtering
  if (allProjects || !projectPath) {
    const entities = knowledgeGraph.searchEntities({
      namePattern: query,
      limit,
    });

    return entities.map(entity => ({
      entity,
      similarity: 1.0,
    }));
  }

  // Search with project scope filtering
  const projectResults = knowledgeGraph.searchEntities({
    namePattern: query,
    tag: 'scope:project',
    limit,
  });

  const globalResults = knowledgeGraph.searchEntities({
    namePattern: query,
    tag: 'scope:global',
    limit,
  });

  // Merge and deduplicate
  const merged = new Map<string, Entity>();
  for (const entity of [...projectResults, ...globalResults]) {
    if (!merged.has(entity.name)) {
      merged.set(entity.name, entity);
    }
  }

  // Return up to limit results
  const deduped = Array.from(merged.values()).slice(0, limit);
  return deduped.map(entity => ({
    entity,
    similarity: 1.0,
  }));
}

/**
 * Interface for knowledge graphs that support semantic search
 */
interface SemanticSearchCapable {
  semanticSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number; entityTypes?: string[] }
  ): Promise<SemanticSearchResult[]>;
}

/**
 * Check if knowledge graph supports semantic search
 */
function hasSemanticSearch(kg: KnowledgeGraph): kg is KnowledgeGraph & SemanticSearchCapable {
  return 'semanticSearch' in kg && typeof (kg as any).semanticSearch === 'function';
}

/**
 * Search result with metadata about which method was actually used
 */
interface SearchResultWithMethod {
  results: SemanticSearchResult[];
  actualMethod: string;
  fallbackNote?: string;
}

/**
 * Perform semantic search using embeddings with project filtering
 * Uses the knowledge graph's semanticSearch if available, otherwise falls back to keyword search.
 */
async function semanticSearch(
  knowledgeGraph: KnowledgeGraph,
  query: string,
  limit: number,
  minSimilarity: number,
  options?: { projectPath?: string; allProjects?: boolean }
): Promise<SearchResultWithMethod> {
  // Check if semantic search is available on this knowledge graph
  if (hasSemanticSearch(knowledgeGraph)) {
    logger.debug('[buddy-remember] Using native semantic search', {
      query,
      limit,
      minSimilarity,
      projectPath: options?.projectPath,
      allProjects: options?.allProjects,
    });

    try {
      // Note: semanticSearch may not support project filtering yet
      // For now, return all results and filter post-hoc if needed
      let results = await knowledgeGraph.semanticSearch(query, { limit: limit * 2, minSimilarity });

      // Post-filter by scope tags when project filtering is active
      if (options?.projectPath && !options?.allProjects) {
        results = results.filter(r => {
          const tags = r.entity.tags || [];
          return tags.some(t => t === 'scope:project' || t === 'scope:global');
        });
      }
      results = results.slice(0, limit);

      return { results, actualMethod: 'semantic' };
    } catch (error) {
      logger.warn('[buddy-remember] Semantic search failed, falling back to keyword', {
        query,
        error: error instanceof Error ? error.message : error,
      });
      // Fall through to keyword search
    }
  } else {
    logger.debug('[buddy-remember] Semantic search not available, using keyword fallback', {
      query,
      limit,
      minSimilarity,
      reason: 'KnowledgeGraph does not support semanticSearch method',
    });
  }

  // Fall back to keyword search with project filtering
  const results = await keywordSearch(knowledgeGraph, query, limit, options);
  return {
    results,
    actualMethod: 'keyword',
    fallbackNote: 'Semantic search unavailable, using keyword search',
  };
}

/**
 * Interface for knowledge graphs that support hybrid search
 */
interface HybridSearchCapable {
  hybridSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number }
  ): Promise<SemanticSearchResult[]>;
}

/**
 * Check if knowledge graph supports hybrid search
 */
function hasHybridSearch(kg: KnowledgeGraph): kg is KnowledgeGraph & HybridSearchCapable {
  return 'hybridSearch' in kg && typeof (kg as any).hybridSearch === 'function';
}

/**
 * Perform hybrid search combining semantic and keyword matching with project filtering
 * Uses the knowledge graph's hybridSearch if available, otherwise falls back to semantic or keyword.
 */
async function hybridSearch(
  knowledgeGraph: KnowledgeGraph,
  query: string,
  limit: number,
  minSimilarity: number,
  options?: { projectPath?: string; allProjects?: boolean }
): Promise<SearchResultWithMethod> {
  // Check if hybrid search is available on this knowledge graph
  if (hasHybridSearch(knowledgeGraph)) {
    logger.debug('[buddy-remember] Using native hybrid search', {
      query,
      limit,
      minSimilarity,
      projectPath: options?.projectPath,
      allProjects: options?.allProjects,
    });

    try {
      // Note: hybridSearch may not support project filtering yet
      // For now, return all results and filter post-hoc if needed
      let results = await knowledgeGraph.hybridSearch(query, { limit: limit * 2, minSimilarity });

      // Post-filter by scope tags when project filtering is active
      if (options?.projectPath && !options?.allProjects) {
        results = results.filter(r => {
          const tags = r.entity.tags || [];
          return tags.some(t => t === 'scope:project' || t === 'scope:global');
        });
      }
      results = results.slice(0, limit);

      return { results, actualMethod: 'hybrid' };
    } catch (error) {
      logger.warn('[buddy-remember] Hybrid search failed, falling back to semantic', {
        query,
        error: error instanceof Error ? error.message : error,
      });
      // Fall through to semantic search
    }
  } else {
    logger.debug('[buddy-remember] Hybrid search not available, trying semantic search', {
      query,
      limit,
      minSimilarity,
    });
  }

  // Try semantic search as fallback (which may itself fall back to keyword)
  const fallback = await semanticSearch(knowledgeGraph, query, limit, minSimilarity, options);
  // If semantic also fell back, keep its note; otherwise note hybrid fallback
  return {
    results: fallback.results,
    actualMethod: fallback.actualMethod,
    fallbackNote: fallback.fallbackNote || `Hybrid search unavailable, used ${fallback.actualMethod} search`,
  };
}

/**
 * buddy_remember tool - Recall project memory with semantic search support
 *
 * Searches knowledge graph for:
 * - Past decisions and architecture choices
 * - API design decisions
 * - Bug fixes and solutions
 * - Project patterns and conventions
 *
 * Search modes:
 * - semantic: AI-powered similarity search (finds conceptually related content)
 * - keyword: Traditional exact/fuzzy keyword matching
 * - hybrid: Combines both approaches for best results (default)
 *
 * Examples:
 *   buddy-remember "how do we handle authentication" → finds JWT, OAuth, session memories
 *   buddy-remember "database" mode=keyword → exact keyword match only
 *   buddy-remember "user login" mode=semantic matchThreshold=0.5 → high-quality semantic matches
 */
export async function executeBuddyRemember(
  input: ValidatedBuddyRememberInput,
  projectMemory: ProjectMemoryManager,
  formatter: ResponseFormatter,
  knowledgeGraph?: KnowledgeGraph
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { query, mode = 'hybrid', limit = 10, matchThreshold: minSimilarity = 0.3, allProjects = false } = input;

  try {
    let results: SemanticSearchResult[];
    let searchMethod: string;

    // Get current project path for filtering (unless allProjects is true)
    const projectPath = allProjects ? undefined : process.cwd();

    let fallbackNote: string | undefined;

    // If no knowledgeGraph provided, fall back to keyword search via projectMemory
    if (!knowledgeGraph) {
      logger.debug('[buddy-remember] No knowledge graph provided, using projectMemory.search', {
        projectPath,
        allProjects,
      });
      const memories = await projectMemory.search(query, {
        limit,
        projectPath,
        allProjects,
      });
      results = memories.map(entity => ({ entity, similarity: 1.0 }));
      searchMethod = allProjects ? 'keyword search (all projects)' : 'keyword search (current project)';
    } else {
      // Prepare search options for project filtering
      const searchOptions = { projectPath, allProjects };
      const scopeLabel = allProjects ? 'all projects' : 'current project';

      // Use the appropriate search method based on mode
      switch (mode) {
        case 'semantic': {
          const searchResult = await semanticSearch(knowledgeGraph, query, limit, minSimilarity, searchOptions);
          results = searchResult.results;
          searchMethod = `${searchResult.actualMethod} search (${scopeLabel})`;
          fallbackNote = searchResult.fallbackNote;
          break;
        }
        case 'keyword':
          results = await keywordSearch(knowledgeGraph, query, limit, searchOptions);
          searchMethod = `keyword search (${scopeLabel})`;
          break;
        case 'hybrid':
        default: {
          const searchResult = await hybridSearch(knowledgeGraph, query, limit, minSimilarity, searchOptions);
          results = searchResult.results;
          searchMethod = `${searchResult.actualMethod} search (${scopeLabel})`;
          fallbackNote = searchResult.fallbackNote;
          break;
        }
      }
    }

    // Handle no results
    if (results.length === 0) {
      const formattedResponse = formatter.format({
        agentType: 'buddy-remember',
        taskDescription: `Search project memory: ${query}`,
        status: 'success',
        results: {
          query,
          mode,
          searchMethod,
          ...(fallbackNote && { fallbackNote }),
          count: 0,
          suggestions: [
            'Try a broader search term',
            'Check if memories were stored for this topic',
            'Use different keywords',
            mode === 'semantic' ? 'Try mode=keyword for exact matches' : 'Try mode=semantic for conceptual matches',
          ],
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: formattedResponse,
          },
        ],
      };
    }

    // Format results with similarity scores
    const formattedResults = formatSearchResults(results, searchMethod, query);

    const formattedResponse = formatter.format({
      agentType: 'buddy-remember',
      taskDescription: `Search project memory: ${query}`,
      status: 'success',
      results: {
        query,
        mode,
        searchMethod,
        ...(fallbackNote && { fallbackNote }),
        count: results.length,
        memories: results.map(r => ({
          ...r.entity,
          similarity: Math.round(r.similarity * 100),
        })),
        formattedOutput: formattedResults,
      },
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: formattedResponse,
        },
      ],
    };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));

    logger.error('[buddy-remember] Search failed', {
      query,
      mode,
      error: errorObj.message,
    });

    const recovery = getRecoverySuggestion(errorObj);

    const formattedError = formatter.format({
      agentType: 'buddy-remember',
      taskDescription: `Search project memory: ${query}`,
      status: 'error',
      error: errorObj,
      ...(recovery && {
        results: {
          recoverySuggestion: recovery.suggestion,
          recoveryCategory: recovery.category,
        },
      }),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: formattedError,
        },
      ],
    };
  }
}
