import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { SmartMemoryQuery } from './SmartMemoryQuery.js';
export class MemorySearchEngine {
    smartQuery;
    constructor() {
        this.smartQuery = new SmartMemoryQuery();
    }
    filterByQuery(memories, query) {
        if (!query || !query.trim()) {
            return memories;
        }
        const lowerQuery = query.toLowerCase();
        return memories.filter((m) => m.content.toLowerCase().includes(lowerQuery) ||
            m.context?.toLowerCase().includes(lowerQuery));
    }
    applySearchFilters(memories, options) {
        let filtered = memories;
        if (options?.timeRange && options.timeRange !== 'all') {
            const now = new Date();
            let cutoffDate;
            switch (options.timeRange) {
                case 'last-24h':
                    cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case 'last-7-days':
                    cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case 'last-30-days':
                    cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                default:
                    cutoffDate = new Date(0);
            }
            filtered = filtered.filter((m) => m.timestamp.getTime() >= cutoffDate.getTime());
        }
        if (options?.minImportance !== undefined) {
            filtered = filtered.filter((m) => m.importance >= options.minImportance);
        }
        if (options?.types && options.types.length > 0) {
            filtered = filtered.filter((m) => options.types.includes(m.type));
        }
        if (options?.limit && filtered.length > options.limit) {
            filtered = filtered.slice(0, options.limit);
        }
        return filtered;
    }
    deduplicateResults(memories) {
        if (memories.length <= 1) {
            return memories;
        }
        const seen = new Map();
        for (const memory of memories) {
            const contentHash = memory.content === ''
                ? `empty:${memory.id ?? uuidv4()}`
                : createHash('sha256').update(memory.content).digest('hex');
            const existing = seen.get(contentHash);
            if (!existing) {
                seen.set(contentHash, memory);
            }
            else {
                const memoryImportance = Number.isFinite(memory.importance) ? memory.importance : 0;
                const existingImportance = Number.isFinite(existing.importance)
                    ? existing.importance
                    : 0;
                const shouldReplace = memoryImportance > existingImportance ||
                    (memoryImportance === existingImportance &&
                        memory.timestamp.getTime() > existing.timestamp.getTime());
                if (shouldReplace) {
                    seen.set(contentHash, memory);
                }
            }
        }
        return Array.from(seen.values());
    }
    rankByRelevance(query, memories, options) {
        return this.smartQuery.search(query, memories, options);
    }
    processSearchResults(query, candidates, options, finalLimit) {
        const deduplicated = this.deduplicateResults(candidates);
        const ranked = this.rankByRelevance(query, deduplicated, options);
        if (finalLimit && finalLimit > 0) {
            return ranked.slice(0, finalLimit);
        }
        return ranked;
    }
}
//# sourceMappingURL=MemorySearchEngine.js.map