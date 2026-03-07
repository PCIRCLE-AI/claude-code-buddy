/**
 * ProactiveRecaller Tests
 *
 * Tests for trigger-specific query building, recall with hybridSearch,
 * error handling, and output formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProactiveRecaller,
  type RecallTrigger,
  type RecallContext,
  type RecallResult,
} from '../ProactiveRecaller.js';
import type { KnowledgeGraph } from '../../knowledge-graph/index.js';
import type { SemanticSearchResult } from '../../knowledge-graph/KGSearchEngine.js';

function makeMockKG(results: SemanticSearchResult[] = []): KnowledgeGraph {
  return {
    hybridSearch: vi.fn().mockResolvedValue(results),
  } as unknown as KnowledgeGraph;
}

function makeSearchResult(
  name: string,
  observations: string[],
  similarity: number
): SemanticSearchResult {
  return {
    entity: {
      name,
      entityType: 'knowledge',
      observations,
    },
    similarity,
  };
}

describe('ProactiveRecaller', () => {
  let kg: KnowledgeGraph;
  let recaller: ProactiveRecaller;

  beforeEach(() => {
    kg = makeMockKG();
    recaller = new ProactiveRecaller(kg);
  });

  describe('buildQuery()', () => {
    describe('session-start trigger', () => {
      it('should combine projectName with cleaned commit messages', () => {
        const query = recaller.buildQuery('session-start', {
          projectName: 'memesh',
          recentCommits: [
            'fix(search): resolve FTS5 ranking issue',
            'feat: add hybrid search',
            'chore(deps): update dependencies',
          ],
        });

        expect(query).toContain('memesh');
        expect(query).toContain('resolve FTS5 ranking issue');
        expect(query).toContain('add hybrid search');
        expect(query).toContain('update dependencies');
        // Should strip conventional commit prefixes
        expect(query).not.toContain('fix(search):');
        expect(query).not.toContain('feat:');
        expect(query).not.toContain('chore(deps):');
      });

      it('should handle missing projectName', () => {
        const query = recaller.buildQuery('session-start', {
          recentCommits: ['fix: something'],
        });

        expect(query).toContain('something');
        expect(query).not.toContain('undefined');
      });

      it('should handle missing recentCommits', () => {
        const query = recaller.buildQuery('session-start', {
          projectName: 'myproject',
        });

        expect(query).toContain('myproject');
      });

      it('should handle empty context', () => {
        const query = recaller.buildQuery('session-start', {});
        expect(query).toBe('');
      });
    });

    describe('test-failure trigger', () => {
      it('should combine function name and error message', () => {
        const query = recaller.buildQuery('test-failure', {
          testName: 'src/utils/__tests__/parser.test.ts::should parse JSON',
          errorMessage: 'Expected null to equal { name: "test" }',
        });

        expect(query).toContain('should parse JSON');
        expect(query).toContain('Expected null to equal');
      });

      it('should use full testName if no :: separator', () => {
        const query = recaller.buildQuery('test-failure', {
          testName: 'simple test name',
          errorMessage: 'assertion failed',
        });

        expect(query).toContain('simple test name');
        expect(query).toContain('assertion failed');
      });

      it('should handle missing testName', () => {
        const query = recaller.buildQuery('test-failure', {
          errorMessage: 'timeout error',
        });

        expect(query).toContain('timeout error');
        expect(query).not.toContain('undefined');
      });
    });

    describe('error-detection trigger', () => {
      it('should combine errorType and first line of errorMessage', () => {
        const query = recaller.buildQuery('error-detection', {
          errorType: 'TypeError',
          errorMessage: 'Cannot read properties of null\n    at Object.<anonymous>\n    at Module._compile',
        });

        expect(query).toContain('TypeError');
        expect(query).toContain('Cannot read properties of null');
        expect(query).not.toContain('at Object.<anonymous>');
      });

      it('should handle single-line errorMessage', () => {
        const query = recaller.buildQuery('error-detection', {
          errorType: 'RangeError',
          errorMessage: 'Maximum call stack size exceeded',
        });

        expect(query).toContain('RangeError');
        expect(query).toContain('Maximum call stack size exceeded');
      });

      it('should handle missing errorType', () => {
        const query = recaller.buildQuery('error-detection', {
          errorMessage: 'Something broke',
        });

        expect(query).toContain('Something broke');
        expect(query).not.toContain('undefined');
      });
    });
  });

  describe('recall()', () => {
    const mockResults: SemanticSearchResult[] = [
      makeSearchResult('FTS5-fix', ['Fixed ranking bug in FTS5'], 0.85),
      makeSearchResult('hybrid-search', ['Added hybrid search combining FTS5 and vector'], 0.72),
    ];

    beforeEach(() => {
      kg = makeMockKG(mockResults);
      recaller = new ProactiveRecaller(kg);
    });

    it('should call hybridSearch with limit=5, minSimilarity=0.5 for session-start', async () => {
      await recaller.recall('session-start', { projectName: 'test' });

      expect(kg.hybridSearch).toHaveBeenCalledWith('test', {
        limit: 5,
        minSimilarity: 0.5,
      });
    });

    it('should call hybridSearch with limit=3, minSimilarity=0.6 for test-failure', async () => {
      await recaller.recall('test-failure', {
        testName: 'myTest',
        errorMessage: 'fail',
      });

      expect(kg.hybridSearch).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 3, minSimilarity: 0.6 }
      );
    });

    it('should call hybridSearch with limit=3, minSimilarity=0.6 for error-detection', async () => {
      await recaller.recall('error-detection', {
        errorType: 'Error',
        errorMessage: 'boom',
      });

      expect(kg.hybridSearch).toHaveBeenCalledWith(
        expect.any(String),
        { limit: 3, minSimilarity: 0.6 }
      );
    });

    it('should map SemanticSearchResult to RecallResult', async () => {
      const results = await recaller.recall('session-start', {
        projectName: 'test',
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        entityName: 'FTS5-fix',
        observations: ['Fixed ranking bug in FTS5'],
        similarity: 0.85,
      });
      expect(results[1]).toEqual({
        entityName: 'hybrid-search',
        observations: ['Added hybrid search combining FTS5 and vector'],
        similarity: 0.72,
      });
    });

    it('should return empty array when query is empty', async () => {
      const results = await recaller.recall('session-start', {});

      expect(results).toEqual([]);
      expect(kg.hybridSearch).not.toHaveBeenCalled();
    });

    it('should return empty array on KnowledgeGraph error', async () => {
      const errorKG = {
        hybridSearch: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      } as unknown as KnowledgeGraph;
      const errorRecaller = new ProactiveRecaller(errorKG);

      const results = await errorRecaller.recall('session-start', {
        projectName: 'test',
      });

      expect(results).toEqual([]);
    });
  });

  describe('formatForHookOutput()', () => {
    it('should format results with similarity percentage', () => {
      const results: RecallResult[] = [
        {
          entityName: 'FTS5-fix',
          observations: ['Fixed ranking bug', 'Use BM25 algorithm'],
          similarity: 0.85,
        },
        {
          entityName: 'search-config',
          observations: ['Default limit is 10'],
          similarity: 0.72,
        },
      ];

      const output = ProactiveRecaller.formatForHookOutput(results);

      expect(output).toContain('FTS5-fix');
      expect(output).toContain('85%');
      expect(output).toContain('Fixed ranking bug');
      expect(output).toContain('Use BM25 algorithm');
      expect(output).toContain('search-config');
      expect(output).toContain('72%');
      expect(output).toContain('Default limit is 10');
    });

    it('should return empty string for empty array', () => {
      const output = ProactiveRecaller.formatForHookOutput([]);
      expect(output).toBe('');
    });

    it('should limit observations to first 2 per entity', () => {
      const results: RecallResult[] = [
        {
          entityName: 'many-obs',
          observations: ['obs1', 'obs2', 'obs3', 'obs4'],
          similarity: 0.9,
        },
      ];

      const output = ProactiveRecaller.formatForHookOutput(results);
      expect(output).toContain('obs1');
      expect(output).toContain('obs2');
      expect(output).not.toContain('obs3');
      expect(output).not.toContain('obs4');
    });
  });
});
