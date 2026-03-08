import { logger } from '../utils/logger.js';
const CONVENTIONAL_COMMIT_PREFIX = /^[a-z]+(?:\([^)]*\))?:\s*/;
const TRIGGER_SEARCH_OPTIONS = {
    'session-start': { limit: 5, minSimilarity: 0.5 },
    'test-failure': { limit: 3, minSimilarity: 0.6 },
    'error-detection': { limit: 3, minSimilarity: 0.6 },
};
export class ProactiveRecaller {
    knowledgeGraph;
    constructor(knowledgeGraph) {
        this.knowledgeGraph = knowledgeGraph;
    }
    buildQuery(trigger, context) {
        switch (trigger) {
            case 'session-start':
                return this.buildSessionStartQuery(context);
            case 'test-failure':
                return this.buildTestFailureQuery(context);
            case 'error-detection':
                return this.buildErrorDetectionQuery(context);
        }
    }
    async recall(trigger, context) {
        const query = this.buildQuery(trigger, context);
        if (!query) {
            return [];
        }
        try {
            const options = TRIGGER_SEARCH_OPTIONS[trigger];
            const results = await this.knowledgeGraph.hybridSearch(query, options);
            return results.map(this.mapToRecallResult);
        }
        catch (error) {
            logger.warn('ProactiveRecaller.recall failed', { trigger, error });
            return [];
        }
    }
    static formatForHookOutput(results) {
        if (results.length === 0) {
            return '';
        }
        const lines = [];
        for (const result of results) {
            const pct = Math.round(result.similarity * 100);
            lines.push(`- ${result.entityName} (${pct}% match)`);
            for (const obs of result.observations.slice(0, 2)) {
                lines.push(`  - ${obs}`);
            }
        }
        return lines.join('\n');
    }
    buildSessionStartQuery(context) {
        const parts = [];
        if (context.projectName) {
            parts.push(context.projectName);
        }
        if (context.recentCommits?.length) {
            const cleaned = context.recentCommits.map((msg) => msg.replace(CONVENTIONAL_COMMIT_PREFIX, '').trim());
            parts.push(...cleaned);
        }
        return parts.join(' ');
    }
    buildTestFailureQuery(context) {
        const parts = [];
        if (context.testName) {
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
    buildErrorDetectionQuery(context) {
        const parts = [];
        if (context.errorType) {
            parts.push(context.errorType);
        }
        if (context.errorMessage) {
            const firstLine = context.errorMessage.split('\n')[0].trim();
            parts.push(firstLine);
        }
        return parts.join(' ');
    }
    mapToRecallResult(result) {
        return {
            entityName: result.entity.name,
            observations: result.entity.observations,
            similarity: result.similarity,
        };
    }
}
//# sourceMappingURL=ProactiveRecaller.js.map