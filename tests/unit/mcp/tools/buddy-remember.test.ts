/**
 * buddy-remember tool unit tests
 *
 * Tests for scope post-filtering (lines 182-193) added to semanticSearch()
 * and hybridSearch() to filter results by scope:project / scope:global tags
 * when projectPath filtering is active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeBuddyRemember } from '../../../../src/mcp/tools/buddy-remember.js';
import { ResponseFormatter } from '../../../../src/ui/ResponseFormatter.js';
import type { ValidatedBuddyRememberInput } from '../../../../src/mcp/tools/buddy-remember.js';
import type { KnowledgeGraph, SemanticSearchResult } from '../../../../src/knowledge-graph/index.js';
import type { ProjectMemoryManager } from '../../../../src/memory/ProjectMemoryManager.js';

// ---------------------------------------------------------------------------
// Helpers — mock factories
// ---------------------------------------------------------------------------

function makeEntity(
  name: string,
  tags: string[] = []
): SemanticSearchResult {
  return {
    entity: {
      name,
      entityType: 'concept',
      observations: [`observation for ${name}`],
      tags,
    },
    similarity: 0.9,
  };
}

/**
 * Build a mock KnowledgeGraph that has semanticSearch support.
 * The semanticSearch mock returns `results` by default.
 */
function createMockKGWithSemantic(
  semanticResults: SemanticSearchResult[],
  options: { throwOnSemantic?: boolean } = {}
): KnowledgeGraph & {
  semanticSearch: ReturnType<typeof vi.fn>;
  hybridSearch: ReturnType<typeof vi.fn>;
  searchEntities: ReturnType<typeof vi.fn>;
} {
  const semanticSearch = options.throwOnSemantic
    ? vi.fn().mockRejectedValue(new Error('Semantic search engine unavailable'))
    : vi.fn().mockResolvedValue(semanticResults);

  const hybridSearch = vi.fn().mockResolvedValue(semanticResults);

  const searchEntities = vi.fn().mockReturnValue(
    semanticResults.map(r => r.entity)
  );

  return {
    semanticSearch,
    hybridSearch,
    searchEntities,
  } as unknown as KnowledgeGraph & {
    semanticSearch: ReturnType<typeof vi.fn>;
    hybridSearch: ReturnType<typeof vi.fn>;
    searchEntities: ReturnType<typeof vi.fn>;
  };
}

/**
 * Build a mock KnowledgeGraph WITHOUT semanticSearch (keyword-only).
 */
function createMockKGKeywordOnly(
  entities: SemanticSearchResult[]
): KnowledgeGraph & { searchEntities: ReturnType<typeof vi.fn> } {
  return {
    searchEntities: vi.fn().mockReturnValue(entities.map(r => r.entity)),
  } as unknown as KnowledgeGraph & { searchEntities: ReturnType<typeof vi.fn> };
}

function createMockProjectMemory(): ProjectMemoryManager {
  return {
    search: vi.fn().mockResolvedValue([]),
  } as unknown as ProjectMemoryManager;
}

function defaultInput(overrides: Partial<ValidatedBuddyRememberInput> = {}): ValidatedBuddyRememberInput {
  return {
    query: 'authentication',
    mode: 'semantic',
    limit: 10,
    matchThreshold: 0.3,
    allProjects: false,
    ...overrides,
  };
}

async function run(
  input: ValidatedBuddyRememberInput,
  kg?: KnowledgeGraph
): Promise<string> {
  const formatter = new ResponseFormatter();
  const pm = createMockProjectMemory();
  const result = await executeBuddyRemember(input, pm, formatter, kg);
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeBuddyRemember — scope post-filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Semantic mode — scope filtering
  // -------------------------------------------------------------------------

  describe('semantic mode with projectPath set (allProjects=false)', () => {
    it('should retain only results that have scope:project or scope:global tags', async () => {
      const results = [
        makeEntity('scoped-to-project', ['scope:project']),
        makeEntity('global-memory', ['scope:global']),
        makeEntity('untagged-result', []),           // should be filtered out
        makeEntity('other-tag-only', ['author:kt']), // should be filtered out
      ];

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'semantic', allProjects: false }), kg);

      // The formatter embeds result names in the output
      expect(text).toContain('scoped-to-project');
      expect(text).toContain('global-memory');
      expect(text).not.toContain('untagged-result');
      expect(text).not.toContain('other-tag-only');
    });

    it('should return zero results when no results have scope tags', async () => {
      const results = [
        makeEntity('no-scope-a', []),
        makeEntity('no-scope-b', ['author:kt']),
      ];

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'semantic', allProjects: false }), kg);

      // With 0 results after filtering, formatter shows "Found 0 memories" branch
      expect(text).not.toContain('no-scope-a');
      expect(text).not.toContain('no-scope-b');
    });

    it('should respect the limit after scope filtering', async () => {
      // Create 15 scoped results — limit is 5
      const results = Array.from({ length: 15 }, (_, i) =>
        makeEntity(`entity-${i}`, ['scope:project'])
      );

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'semantic', limit: 5, allProjects: false }), kg);

      // At most 5 results should appear; entity-0 through entity-4
      let count = 0;
      for (let i = 0; i < 15; i++) {
        if (text.includes(`entity-${i}`)) count++;
      }
      expect(count).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // allProjects=true — no scope filtering
  // -------------------------------------------------------------------------

  describe('when allProjects is true', () => {
    it('should include all results regardless of scope tags', async () => {
      const results = [
        makeEntity('scoped-result', ['scope:project']),
        makeEntity('unscoped-result', []),
        makeEntity('global-result', ['scope:global']),
      ];

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'semantic', allProjects: true }), kg);

      expect(text).toContain('scoped-result');
      expect(text).toContain('unscoped-result');
      expect(text).toContain('global-result');
    });
  });

  // -------------------------------------------------------------------------
  // Hybrid mode — scope filtering
  // -------------------------------------------------------------------------

  describe('hybrid mode with projectPath set', () => {
    it('should filter hybrid search results to scope:project and scope:global only', async () => {
      const results = [
        makeEntity('hybrid-scoped', ['scope:project']),
        makeEntity('hybrid-unscoped', []),
      ];

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'hybrid', allProjects: false }), kg);

      expect(text).toContain('hybrid-scoped');
      expect(text).not.toContain('hybrid-unscoped');
    });

    it('should pass all results through when allProjects is true in hybrid mode', async () => {
      const results = [
        makeEntity('hybrid-scoped', ['scope:project']),
        makeEntity('hybrid-unscoped', []),
      ];

      const kg = createMockKGWithSemantic(results);
      const text = await run(defaultInput({ mode: 'hybrid', allProjects: true }), kg);

      expect(text).toContain('hybrid-scoped');
      expect(text).toContain('hybrid-unscoped');
    });
  });

  // -------------------------------------------------------------------------
  // No projectPath (allProjects path via undefined projectPath)
  // -------------------------------------------------------------------------

  describe('keyword mode — no scope filtering applied', () => {
    it('should return all keyword results without scope filtering', async () => {
      const entities = [
        makeEntity('keyword-scoped', ['scope:project']),
        makeEntity('keyword-unscoped', []),
      ];

      const kg = createMockKGKeywordOnly(entities);
      // keyword mode does its own project filtering via searchEntities tag param;
      // when allProjects=true it skips tag filtering entirely
      const text = await run(defaultInput({ mode: 'keyword', allProjects: true }), kg);

      expect(text).toContain('keyword-scoped');
      expect(text).toContain('keyword-unscoped');
    });
  });

  // -------------------------------------------------------------------------
  // Fallback: semantic search throws → should include fallbackNote
  // -------------------------------------------------------------------------

  describe('fallbackNote when semantic search throws', () => {
    it('should include fallback information in the response when semantic search fails', async () => {
      const fallbackEntities = [
        makeEntity('fallback-entity', ['scope:project']),
      ];

      // KG has semanticSearch but it throws; searchEntities provides fallback data
      const kg = {
        semanticSearch: vi.fn().mockRejectedValue(new Error('embedding service down')),
        searchEntities: vi.fn().mockReturnValue(fallbackEntities.map(r => r.entity)),
      } as unknown as KnowledgeGraph;

      const text = await run(defaultInput({ mode: 'semantic', allProjects: false }), kg);

      // The response should mention the fallback
      expect(text).toContain('fallback');
    });

    it('should still return keyword results when semantic search throws', async () => {
      const fallbackEntities = [
        makeEntity('keyword-fallback', ['scope:project']),
      ];

      const kg = {
        semanticSearch: vi.fn().mockRejectedValue(new Error('embedding unavailable')),
        searchEntities: vi.fn().mockReturnValue(fallbackEntities.map(r => r.entity)),
      } as unknown as KnowledgeGraph;

      const text = await run(defaultInput({ mode: 'semantic', allProjects: false }), kg);

      // keyword-fallback has scope:project tag so it passes the filter
      expect(text).toContain('keyword-fallback');
    });
  });

  // -------------------------------------------------------------------------
  // No knowledgeGraph provided — uses projectMemory.search
  // -------------------------------------------------------------------------

  describe('when no knowledgeGraph is provided', () => {
    it('should fall back to projectMemory.search', async () => {
      const formatter = new ResponseFormatter();
      const pm = {
        search: vi.fn().mockResolvedValue([
          { name: 'pm-entity', entityType: 'concept', observations: ['obs1'] },
        ]),
      } as unknown as ProjectMemoryManager;

      const result = await executeBuddyRemember(
        defaultInput({ mode: 'hybrid', allProjects: false }),
        pm,
        formatter,
        undefined // no KG
      );

      const text = result.content[0].text;
      expect(text).toContain('pm-entity');
      expect(pm.search).toHaveBeenCalledWith('authentication', expect.objectContaining({
        limit: 10,
        allProjects: false,
      }));
    });
  });
});
