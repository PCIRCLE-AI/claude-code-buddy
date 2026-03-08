import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { getRecoverySuggestion } from '../../utils/errorHandler.js';
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
function formatSearchResults(results, searchMethod, query) {
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
async function keywordSearch(knowledgeGraph, query, limit, options) {
    const { projectPath, allProjects = false } = options || {};
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
    const merged = new Map();
    for (const entity of [...projectResults, ...globalResults]) {
        if (!merged.has(entity.name)) {
            merged.set(entity.name, entity);
        }
    }
    const deduped = Array.from(merged.values()).slice(0, limit);
    return deduped.map(entity => ({
        entity,
        similarity: 1.0,
    }));
}
function hasSemanticSearch(kg) {
    return 'semanticSearch' in kg && typeof kg.semanticSearch === 'function';
}
async function semanticSearch(knowledgeGraph, query, limit, minSimilarity, options) {
    if (hasSemanticSearch(knowledgeGraph)) {
        logger.debug('[buddy-remember] Using native semantic search', {
            query,
            limit,
            minSimilarity,
            projectPath: options?.projectPath,
            allProjects: options?.allProjects,
        });
        try {
            let results = await knowledgeGraph.semanticSearch(query, { limit: limit * 2, minSimilarity });
            if (options?.projectPath && !options?.allProjects) {
                results = results.filter(r => {
                    const tags = r.entity.tags || [];
                    return tags.some(t => t === 'scope:project' || t === 'scope:global');
                });
            }
            results = results.slice(0, limit);
            return { results, actualMethod: 'semantic' };
        }
        catch (error) {
            logger.warn('[buddy-remember] Semantic search failed, falling back to keyword', {
                query,
                error: error instanceof Error ? error.message : error,
            });
        }
    }
    else {
        logger.debug('[buddy-remember] Semantic search not available, using keyword fallback', {
            query,
            limit,
            minSimilarity,
            reason: 'KnowledgeGraph does not support semanticSearch method',
        });
    }
    const results = await keywordSearch(knowledgeGraph, query, limit, options);
    return {
        results,
        actualMethod: 'keyword',
        fallbackNote: 'Semantic search unavailable, using keyword search',
    };
}
function hasHybridSearch(kg) {
    return 'hybridSearch' in kg && typeof kg.hybridSearch === 'function';
}
async function hybridSearch(knowledgeGraph, query, limit, minSimilarity, options) {
    if (hasHybridSearch(knowledgeGraph)) {
        logger.debug('[buddy-remember] Using native hybrid search', {
            query,
            limit,
            minSimilarity,
            projectPath: options?.projectPath,
            allProjects: options?.allProjects,
        });
        try {
            let results = await knowledgeGraph.hybridSearch(query, { limit: limit * 2, minSimilarity });
            if (options?.projectPath && !options?.allProjects) {
                results = results.filter(r => {
                    const tags = r.entity.tags || [];
                    return tags.some(t => t === 'scope:project' || t === 'scope:global');
                });
            }
            results = results.slice(0, limit);
            return { results, actualMethod: 'hybrid' };
        }
        catch (error) {
            logger.warn('[buddy-remember] Hybrid search failed, falling back to semantic', {
                query,
                error: error instanceof Error ? error.message : error,
            });
        }
    }
    else {
        logger.debug('[buddy-remember] Hybrid search not available, trying semantic search', {
            query,
            limit,
            minSimilarity,
        });
    }
    const fallback = await semanticSearch(knowledgeGraph, query, limit, minSimilarity, options);
    return {
        results: fallback.results,
        actualMethod: fallback.actualMethod,
        fallbackNote: fallback.fallbackNote || `Hybrid search unavailable, used ${fallback.actualMethod} search`,
    };
}
export async function executeBuddyRemember(input, projectMemory, formatter, knowledgeGraph) {
    const { query, mode = 'hybrid', limit = 10, matchThreshold: minSimilarity = 0.3, allProjects = false } = input;
    try {
        let results;
        let searchMethod;
        const projectPath = allProjects ? undefined : process.cwd();
        let fallbackNote;
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
        }
        else {
            const searchOptions = { projectPath, allProjects };
            const scopeLabel = allProjects ? 'all projects' : 'current project';
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
                        type: 'text',
                        text: formattedResponse,
                    },
                ],
            };
        }
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
                    type: 'text',
                    text: formattedResponse,
                },
            ],
        };
    }
    catch (error) {
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
                    type: 'text',
                    text: formattedError,
                },
            ],
        };
    }
}
//# sourceMappingURL=buddy-remember.js.map