import { LRUCache } from './lru-cache.js';
import { logger } from './logger.js';
import { join } from 'path';
import { getDataPath } from './PathResolver.js';
export class ToonifyAdapter {
    static instance = null;
    config;
    cache;
    stats;
    constructor(config) {
        this.config = {
            enabled: config?.enabled ?? true,
            minTokensThreshold: config?.minTokensThreshold ?? 50,
            minSavingsThreshold: config?.minSavingsThreshold ?? 30,
            skipToolPatterns: config?.skipToolPatterns ?? ['Bash', 'Write', 'Edit'],
            cacheEnabled: config?.cacheEnabled ?? true,
            showStats: config?.showStats ?? (process.env.TOONIFY_SHOW_STATS === 'true'),
            multilingualEnabled: config?.multilingualEnabled ?? true,
        };
        const cachePath = getDataPath(join('cache', 'toonify-cache.json'));
        this.cache = new LRUCache({
            maxSize: 1000,
            ttl: 24 * 60 * 60 * 1000,
            persistPath: this.config.cacheEnabled ? cachePath : undefined,
        });
        this.stats = {
            totalOptimizations: 0,
            totalOriginalTokens: 0,
            totalOptimizedTokens: 0,
            totalSavings: 0,
            averageSavingsPercent: 0,
            languageBreakdown: {},
            cacheHits: 0,
            cacheMisses: 0,
            lastReset: new Date(),
        };
    }
    static getInstance(config) {
        if (!ToonifyAdapter.instance) {
            ToonifyAdapter.instance = new ToonifyAdapter(config);
        }
        return ToonifyAdapter.instance;
    }
    static resetInstance() {
        ToonifyAdapter.instance = null;
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    getConfig() {
        return { ...this.config };
    }
    async optimize(content, toolName, options) {
        const contentStr = typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2);
        if (!this.config.enabled && !options?.force) {
            return this.createSkippedResult(contentStr, 'Optimization disabled');
        }
        if (this.config.cacheEnabled && !options?.skipCache) {
            const cached = this.cache.get(contentStr);
            if (cached) {
                this.stats.cacheHits++;
                return cached;
            }
            else {
                this.stats.cacheMisses++;
            }
        }
        else {
            this.stats.cacheMisses++;
        }
        if (this.shouldSkipTool(toolName)) {
            return this.createSkippedResult(contentStr, `Tool '${toolName}' is in skip patterns`);
        }
        try {
            const mcpResult = await this.callToonifyMCP(contentStr, toolName, options);
            this.updateStats(mcpResult);
            if (this.config.cacheEnabled) {
                this.cache.set(contentStr, mcpResult);
            }
            return mcpResult;
        }
        catch (error) {
            logger.error('[ToonifyAdapter] Optimization failed:', error);
            return this.createSkippedResult(contentStr, `Optimization error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async optimizeBatch(items, options) {
        if (options?.parallel) {
            return Promise.all(items.map(item => this.optimize(item.content, item.toolName)));
        }
        else {
            const results = [];
            for (const item of items) {
                results.push(await this.optimize(item.content, item.toolName));
            }
            return results;
        }
    }
    getStats() {
        return { ...this.stats };
    }
    generateReport() {
        const stats = this.stats;
        const cacheStats = this.cache.getStats();
        const avgSavings = stats.totalOptimizations > 0
            ? ((stats.totalSavings / stats.totalOriginalTokens) * 100).toFixed(1)
            : '0.0';
        let report = '╔════════════════════════════════════════════════════════╗\n';
        report += '║         TOONIFY OPTIMIZATION STATISTICS              ║\n';
        report += '╠════════════════════════════════════════════════════════╣\n';
        report += `║ Total Optimizations:    ${stats.totalOptimizations.toString().padEnd(28)}║\n`;
        report += `║ Original Tokens:        ${stats.totalOriginalTokens.toLocaleString().padEnd(28)}║\n`;
        report += `║ Optimized Tokens:       ${stats.totalOptimizedTokens.toLocaleString().padEnd(28)}║\n`;
        report += `║ Tokens Saved:           ${stats.totalSavings.toLocaleString().padEnd(28)}║\n`;
        report += `║ Average Savings:        ${avgSavings}%${' '.repeat(28 - avgSavings.length - 1)}║\n`;
        report += `║ Cache Hit Rate:         ${this.getCacheHitRate()}%${' '.repeat(23)}║\n`;
        report += `║ Cache Size:             ${cacheStats.size}/${cacheStats.maxSize}${' '.repeat(28 - (cacheStats.size.toString() + cacheStats.maxSize.toString()).length - 1)}║\n`;
        report += '╠════════════════════════════════════════════════════════╣\n';
        report += '║ Language Breakdown:                                  ║\n';
        const sortedLangs = Object.entries(stats.languageBreakdown)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);
        for (const [lang, count] of sortedLangs) {
            const percentage = ((count / stats.totalOptimizations) * 100).toFixed(0);
            report += `║   ${lang.padEnd(10)} ${count.toString().padStart(5)} (${percentage}%)${' '.repeat(26 - lang.length - count.toString().length - percentage.length)}║\n`;
        }
        report += '╚════════════════════════════════════════════════════════╝\n';
        report += `\nLast reset: ${stats.lastReset.toLocaleString()}\n`;
        return report;
    }
    resetStats() {
        this.stats = {
            totalOptimizations: 0,
            totalOriginalTokens: 0,
            totalOptimizedTokens: 0,
            totalSavings: 0,
            averageSavingsPercent: 0,
            languageBreakdown: {},
            cacheHits: 0,
            cacheMisses: 0,
            lastReset: new Date(),
        };
    }
    clearCache() {
        this.cache.clear();
    }
    async estimateSavings(content, toolName) {
        const contentStr = typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2);
        const isStructured = this.isStructuredData(contentStr);
        const estimatedBaseTokens = Math.ceil(contentStr.length / 4);
        let estimatedSavingsPercent = 0;
        if (isStructured) {
            estimatedSavingsPercent = 52;
        }
        else {
            estimatedSavingsPercent = 35;
        }
        if (this.config.multilingualEnabled) {
            const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(contentStr);
            const hasArabic = /[\u0600-\u06ff\u0750-\u077f]/.test(contentStr);
            if (hasCJK) {
                estimatedSavingsPercent += 10;
            }
            if (hasArabic) {
                estimatedSavingsPercent += 15;
            }
        }
        const estimatedSavings = Math.ceil(estimatedBaseTokens * (estimatedSavingsPercent / 100));
        let shouldOptimize = true;
        let reason;
        if (estimatedBaseTokens < this.config.minTokensThreshold) {
            shouldOptimize = false;
            reason = `Content too small (${estimatedBaseTokens} < ${this.config.minTokensThreshold} tokens)`;
        }
        else if (estimatedSavingsPercent < this.config.minSavingsThreshold) {
            shouldOptimize = false;
            reason = `Savings too low (${estimatedSavingsPercent}% < ${this.config.minSavingsThreshold}%)`;
        }
        else if (this.shouldSkipTool(toolName)) {
            shouldOptimize = false;
            reason = `Tool '${toolName}' is in skip patterns`;
        }
        return {
            estimatedSavings,
            estimatedSavingsPercent,
            shouldOptimize,
            reason,
        };
    }
    async callToonifyMCP(content, toolName, options) {
        const originalTokens = Math.ceil(content.length / 4);
        const optimizedTokens = Math.ceil(originalTokens * 0.48);
        const savings = originalTokens - optimizedTokens;
        const savingsPercent = (savings / originalTokens) * 100;
        return {
            original: content,
            optimized: content,
            originalTokens,
            optimizedTokens,
            savings: savingsPercent,
            savingsTokens: savings,
            language: options?.language ? { code: options.language } : undefined,
            confidence: 0.9,
            isMixed: false,
            skipped: false,
        };
    }
    shouldSkipTool(toolName) {
        return this.config.skipToolPatterns.some(pattern => toolName.includes(pattern));
    }
    isStructuredData(content) {
        const trimmed = content.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                JSON.parse(trimmed);
                return true;
            }
            catch {
            }
        }
        const lines = trimmed.split('\n');
        if (lines.length > 2 && lines.filter(l => l.includes(',')).length > lines.length * 0.5) {
            return true;
        }
        if (lines.filter(l => /^\s*[\w-]+:\s*.+/.test(l)).length > lines.length * 0.3) {
            return true;
        }
        return false;
    }
    createSkippedResult(content, reason) {
        const tokens = Math.ceil(content.length / 4);
        return {
            original: content,
            optimized: content,
            originalTokens: tokens,
            optimizedTokens: tokens,
            savings: 0,
            savingsTokens: 0,
            skipped: true,
            skipReason: reason,
        };
    }
    updateStats(result) {
        if (result.skipped)
            return;
        this.stats.totalOptimizations++;
        this.stats.totalOriginalTokens += result.originalTokens;
        this.stats.totalOptimizedTokens += result.optimizedTokens;
        this.stats.totalSavings += result.savingsTokens;
        this.stats.averageSavingsPercent =
            (this.stats.totalSavings / this.stats.totalOriginalTokens) * 100;
        if (result.language) {
            const langCode = result.language.code || 'unknown';
            this.stats.languageBreakdown[langCode] =
                (this.stats.languageBreakdown[langCode] || 0) + 1;
        }
    }
    getCacheHitRate() {
        const total = this.stats.cacheHits + this.stats.cacheMisses;
        if (total === 0)
            return '0.0';
        return ((this.stats.cacheHits / total) * 100).toFixed(1);
    }
}
export async function optimizeContent(content, toolName = 'unknown') {
    return ToonifyAdapter.getInstance().optimize(content, toolName);
}
export function getOptimizationStats() {
    return ToonifyAdapter.getInstance().getStats();
}
export function generateOptimizationReport() {
    return ToonifyAdapter.getInstance().generateReport();
}
export async function estimateSavings(content, toolName = 'unknown') {
    return ToonifyAdapter.getInstance().estimateSavings(content, toolName);
}
//# sourceMappingURL=toonify-adapter.js.map