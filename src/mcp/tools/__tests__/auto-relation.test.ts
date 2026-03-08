/**
 * Tests for auto-relation inference in create-entities MCP tool
 *
 * The helper functions (_extractTopicKeywords, _sharesTopic, _determineRelation,
 * _inferAndCreateRelations) are not exported, so we test them indirectly through
 * the public createEntitiesTool.handler by observing the relations created on
 * the mocked KnowledgeGraph.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEntitiesTool } from '../create-entities';

describe('Auto-relation inference', () => {
  let mockKnowledgeGraph: any;
  let createdRelations: Array<{ from: string; to: string; relationType: string; metadata?: any }>;

  beforeEach(() => {
    createdRelations = [];
    mockKnowledgeGraph = {
      createEntity: vi.fn().mockReturnValue(undefined),
      createEntitiesBatch: vi.fn().mockImplementation((entities: any[]) => {
        return entities.map((entity: any) => {
          try {
            mockKnowledgeGraph.createEntity(entity);
            return { name: entity.name, success: true };
          } catch (error: any) {
            return { name: entity.name, success: false, error: error.message };
          }
        });
      }),
      createRelation: vi.fn().mockImplementation((rel: any) => {
        createdRelations.push(rel);
      }),
      searchEntities: vi.fn().mockReturnValue([]),
      getEntity: vi.fn().mockReturnValue(null),
    };
  });

  // ========================================================================
  // _extractTopicKeywords (tested indirectly via topic matching behavior)
  // ========================================================================

  describe('topic keyword extraction (_extractTopicKeywords)', () => {
    it('should extract keywords from space-separated names', async () => {
      // Two entities of the same type sharing the keyword "authentication" should get similar_to
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Authentication Service',
              entityType: 'feature',
              observations: ['First auth feature'],
            },
            {
              name: 'Authentication Middleware',
              entityType: 'feature',
              observations: ['Second auth feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations).toHaveLength(1);
      expect(createdRelations[0].relationType).toBe('similar_to');
    });

    it('should extract keywords from hyphen-separated names', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'auto-relation feature',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'auto-scaling feature',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // "auto" is a keyword shared between both (4 chars, extracted)
      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('similar_to');
    });

    it('should extract keywords from underscore-separated names', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'vector_search implementation',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'vector_store implementation',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // "vector" is shared
      expect(result.autoRelationsCreated).toBe(1);
    });

    it('should filter out words shorter than 3 characters', async () => {
      // "do" is only 2 chars, "it" is 2 chars — no keywords extracted
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'do it ab',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'do it cd',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // No keywords >= 3 chars, so no topic sharing, no relations
      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should strip date patterns (YYYY-MM-DD) from names', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature 2026-03-01',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'Caching Improvement 2026-03-09',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // "caching" is shared after stripping dates
      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('similar_to');
    });

    it('should only take first 2 keywords', async () => {
      // Both share "database" as the first keyword
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Database Migration Upgrade Refactor',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'Database Connection Pooling Setup',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // "database" keyword is shared
      expect(result.autoRelationsCreated).toBe(1);
    });

    it('should handle empty name gracefully', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: '',
              entityType: 'feature',
              observations: ['Empty name'],
            },
            {
              name: 'Something Else',
              entityType: 'feature',
              observations: ['Other'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Empty name yields no keywords, so no topic match
      expect(result.autoRelationsCreated).toBe(0);
    });
  });

  // ========================================================================
  // _sharesTopic (tested indirectly via matching behavior)
  // ========================================================================

  describe('topic sharing (_sharesTopic)', () => {
    it('should detect shared keywords (case-insensitive via lowercasing)', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Logging Feature',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'LOGGING Improvement',
              entityType: 'feature',
              observations: ['Second'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Both yield keyword "logging" after toLowerCase
      expect(result.autoRelationsCreated).toBe(1);
    });

    it('should not match when keywords do not overlap', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Authentication Module',
              entityType: 'feature',
              observations: ['Auth'],
            },
            {
              name: 'Database Migration',
              entityType: 'feature',
              observations: ['DB'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(0);
    });
  });

  // ========================================================================
  // _determineRelation — all relation type rules
  // ========================================================================

  describe('relation type determination (_determineRelation)', () => {
    it('should create "solves" relation for bug_fix + feature', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed caching issue'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('solves');
      // bug_fix is "from", feature is "to"
      expect(createdRelations[0].from).toBe('Caching Bugfix');
      expect(createdRelations[0].to).toBe('Caching Feature');
    });

    it('should create "solves" relation regardless of entity order (feature first)', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed'],
            },
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('solves');
      expect(createdRelations[0].from).toBe('Caching Bugfix');
      expect(createdRelations[0].to).toBe('Caching Feature');
    });

    it('should create "enabled_by" relation for decision + feature', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Routing Decision',
              entityType: 'decision',
              observations: ['Decided on routing'],
            },
            {
              name: 'Routing Feature',
              entityType: 'feature',
              observations: ['Implemented routing'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('enabled_by');
      // feature enabled_by decision => from=feature, to=decision
      expect(createdRelations[0].from).toBe('Routing Feature');
      expect(createdRelations[0].to).toBe('Routing Decision');
    });

    it('should create "enabled_by" relation with feature first in input', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Routing Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
            {
              name: 'Routing Decision',
              entityType: 'decision',
              observations: ['Decision'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('enabled_by');
      expect(createdRelations[0].from).toBe('Routing Feature');
      expect(createdRelations[0].to).toBe('Routing Decision');
    });

    it('should create "caused_by" relation for lesson_learned + bug_fix', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Memory Lesson',
              entityType: 'lesson_learned',
              observations: ['Learned about memory leaks'],
            },
            {
              name: 'Memory Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed memory issue'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('caused_by');
      // lesson_learned caused_by bug_fix => from=lesson, to=bug_fix
      expect(createdRelations[0].from).toBe('Memory Lesson');
      expect(createdRelations[0].to).toBe('Memory Bugfix');
    });

    it('should create "caused_by" relation with bug_fix first in input', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Memory Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed'],
            },
            {
              name: 'Memory Lesson',
              entityType: 'lesson_learned',
              observations: ['Learned'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('caused_by');
      expect(createdRelations[0].from).toBe('Memory Lesson');
      expect(createdRelations[0].to).toBe('Memory Bugfix');
    });

    it('should create "similar_to" relation for same type + shared topic', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Strategy Alpha',
              entityType: 'decision',
              observations: ['Decision A'],
            },
            {
              name: 'Caching Strategy Beta',
              entityType: 'decision',
              observations: ['Decision B'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('similar_to');
    });

    it('should return null (no relation) for non-matching type combinations', async () => {
      // bug_fix + decision — not in the rules
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed'],
            },
            {
              name: 'Caching Decision',
              entityType: 'decision',
              observations: ['Decided'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // bug_fix + decision is NOT handled by _determineRelation => null => no relation
      expect(result.autoRelationsCreated).toBe(0);
      expect(createdRelations).toHaveLength(0);
    });

    it('should return null for lesson_learned + feature (not in rules)', async () => {
      // Per source: lesson_learned + feature is NOT matched (only lesson_learned + bug_fix)
      // Actually, re-reading the source — after the specific rules, if typeA === typeB it returns similar_to,
      // otherwise it returns null. lesson_learned + feature => null
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Lesson',
              entityType: 'lesson_learned',
              observations: ['Learned'],
            },
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should set metadata source to "auto-relation"', async () => {
      await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Logging Feature',
              entityType: 'feature',
              observations: ['First'],
            },
            {
              name: 'Logging Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed logging'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(createdRelations).toHaveLength(1);
      expect(createdRelations[0].metadata).toEqual({ source: 'auto-relation' });
    });
  });

  // ========================================================================
  // Excluded entity types
  // ========================================================================

  describe('excluded entity types', () => {
    const excludedTypes = ['session_keypoint', 'session_identity', 'task_start', 'session_summary'];

    for (const excludedType of excludedTypes) {
      it(`should skip ${excludedType} entities from relation inference`, async () => {
        const result = await createEntitiesTool.handler(
          {
            entities: [
              {
                name: 'Caching Feature',
                entityType: 'feature',
                observations: ['Feature'],
              },
              {
                name: 'Caching Summary',
                entityType: excludedType,
                observations: ['Summary'],
              },
            ],
          },
          mockKnowledgeGraph
        );

        // The excluded type should be filtered out, so no relation despite topic match
        expect(result.autoRelationsCreated).toBe(0);
      });
    }

    it('should still create relations between non-excluded types', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
            {
              name: 'Caching Summary',
              entityType: 'session_summary',
              observations: ['Excluded'],
            },
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Bug fix'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // feature + bug_fix should match (solves), session_summary excluded
      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('solves');
    });
  });

  // ========================================================================
  // Full _inferAndCreateRelations flow
  // ========================================================================

  describe('full inference flow (_inferAndCreateRelations)', () => {
    it('should create relations between new entities in the same batch', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Search Feature',
              entityType: 'feature',
              observations: ['Implemented search'],
            },
            {
              name: 'Search Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed search'],
            },
            {
              name: 'Search Decision',
              entityType: 'decision',
              observations: ['Decided on search'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // feature + bug_fix => solves
      // feature + decision => enabled_by
      // bug_fix + decision => no rule => null
      expect(result.autoRelationsCreated).toBe(2);
      const types = createdRelations.map(r => r.relationType).sort();
      expect(types).toEqual(['enabled_by', 'solves']);
    });

    it('should match new entities against existing entities from search', async () => {
      // Mock searchEntities to return an existing entity
      mockKnowledgeGraph.searchEntities.mockImplementation((query: any) => {
        if (query.namePattern === 'search') {
          return [
            { name: 'Search Infrastructure', entityType: 'feature' },
          ];
        }
        return [];
      });
      mockKnowledgeGraph.getEntity.mockImplementation((name: string) => {
        if (name === 'Search Infrastructure') {
          return { name: 'Search Infrastructure', entityType: 'feature' };
        }
        return null;
      });

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Search Improvement',
              entityType: 'feature',
              observations: ['Improved search'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // new feature + existing feature with shared "search" => similar_to
      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('similar_to');
      expect(createdRelations[0].from).toBe('Search Improvement');
      expect(createdRelations[0].to).toBe('Search Infrastructure');
    });

    it('should skip existing entities with excluded types from search results', async () => {
      mockKnowledgeGraph.searchEntities.mockReturnValue([
        { name: 'Caching Session', entityType: 'session_summary' },
      ]);
      mockKnowledgeGraph.getEntity.mockReturnValue(null);

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // session_summary is excluded in search results filtering
      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should skip existing entities that are also in the current batch', async () => {
      // If searchEntities returns an entity that is already in the batch,
      // it should be skipped (already handled by within-batch matching)
      mockKnowledgeGraph.searchEntities.mockReturnValue([
        { name: 'Caching Feature', entityType: 'feature' },
        { name: 'Caching Bugfix', entityType: 'bug_fix' },
      ]);

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Bugfix'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Within-batch: feature + bug_fix => solves (1 relation)
      // Search results return the same names — should skip both
      expect(result.autoRelationsCreated).toBe(1);
      expect(createdRelations[0].relationType).toBe('solves');
    });

    it('should not break entity creation when auto-relation throws', async () => {
      // Make createRelation throw an error
      mockKnowledgeGraph.createRelation.mockImplementation(() => {
        throw new Error('Relation creation failed');
      });

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
            {
              name: 'Caching Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed caching'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Entities should still be created successfully
      expect(result.created).toHaveLength(2);
      expect(result.count).toBe(2);
      // Relations failed but silently
      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should handle search failures gracefully', async () => {
      mockKnowledgeGraph.searchEntities.mockImplementation(() => {
        throw new Error('Search failed');
      });

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Entity created, search failure should not propagate
      expect(result.created).toHaveLength(1);
      expect(result.count).toBe(1);
    });

    it('should handle UNIQUE constraint errors silently', async () => {
      // Simulate duplicate relation scenario
      mockKnowledgeGraph.searchEntities.mockReturnValue([
        { name: 'Caching Existing', entityType: 'feature' },
      ]);
      mockKnowledgeGraph.getEntity.mockReturnValue(
        { name: 'Caching Existing', entityType: 'feature' }
      );
      mockKnowledgeGraph.createRelation.mockImplementation(() => {
        throw new Error('UNIQUE constraint failed');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Improvement',
              entityType: 'feature',
              observations: ['Better caching'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Should not log for UNIQUE constraint errors
      const uniqueErrorLogs = consoleSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('auto-relation') && String(call[1] || call[0]).includes('UNIQUE')
      );
      expect(uniqueErrorLogs).toHaveLength(0);

      expect(result.created).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it('should return autoRelationsCreated count of 0 when no entities created', async () => {
      mockKnowledgeGraph.createEntity.mockImplementation(() => {
        throw new Error('All fail');
      });

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Failing Entity',
              entityType: 'feature',
              observations: ['Will fail'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      expect(result.created).toHaveLength(0);
      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should create multiple relations in a complex batch', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Embedding Feature',
              entityType: 'feature',
              observations: ['Feature for embeddings'],
            },
            {
              name: 'Embedding Bugfix',
              entityType: 'bug_fix',
              observations: ['Fixed embedding crash'],
            },
            {
              name: 'Embedding Decision',
              entityType: 'decision',
              observations: ['Decided to use embeddings'],
            },
            {
              name: 'Embedding Lesson',
              entityType: 'lesson_learned',
              observations: ['Learned from embedding issue'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // All share keyword "embedding"
      // feature + bug_fix => solves
      // feature + decision => enabled_by
      // feature + lesson_learned => null (no rule)
      // bug_fix + decision => null (no rule)
      // bug_fix + lesson_learned => caused_by
      // decision + lesson_learned => null (no rule)
      expect(result.autoRelationsCreated).toBe(3);
      const types = createdRelations.map(r => r.relationType).sort();
      expect(types).toEqual(['caused_by', 'enabled_by', 'solves']);
    });

    it('should not create relations when entities have no keywords', async () => {
      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'A B',
              entityType: 'feature',
              observations: ['Short words only'],
            },
            {
              name: 'C D',
              entityType: 'bug_fix',
              observations: ['More short words'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // All words < 4 chars => no keywords => no topic match
      expect(result.autoRelationsCreated).toBe(0);
    });

    it('should skip self-matching from search results', async () => {
      mockKnowledgeGraph.searchEntities.mockReturnValue([
        { name: 'Caching Feature', entityType: 'feature' },
      ]);

      const result = await createEntitiesTool.handler(
        {
          entities: [
            {
              name: 'Caching Feature',
              entityType: 'feature',
              observations: ['Feature'],
            },
          ],
        },
        mockKnowledgeGraph
      );

      // Should skip itself from search results
      expect(result.autoRelationsCreated).toBe(0);
    });
  });
});
