/**
 * MCP Tool: create-entities
 *
 * Creates new entities in the Knowledge Graph.
 * Allows manual recording of decisions, features, bug fixes, and other knowledge.
 *
 * Automatically tags entities with scope and tech tags based on project context.
 */

import type { KnowledgeGraph } from '../../knowledge-graph/index.js';
import type { EntityType, RelationType } from '../../knowledge-graph/types.js';

export interface CreateEntitiesArgs {
  /** Array of entities to create */
  entities: Array<{
    /** Entity name (unique identifier) */
    name: string;
    /** Entity type (e.g., 'decision', 'feature', 'bug_fix', 'code_change', 'test_result') */
    entityType: string;
    /** Array of observations (facts, notes, details) */
    observations: string[];
    /** Optional tags (scope and tech tags will be automatically added) */
    tags?: string[];
    /** Optional metadata */
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * MCP Tool definition for creating entities
 */
export const createEntitiesTool = {
  name: 'create-entities',
  description: 'Create new entities in the Knowledge Graph. Record decisions, features, bug fixes, code changes, and other knowledge for future recall.',

  inputSchema: {
    type: 'object' as const,
    properties: {
      entities: {
        type: 'array',
        description: 'Array of entities to create',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Entity name (unique identifier, e.g., "OAuth Integration 2026-01-03")',
            },
            entityType: {
              type: 'string',
              description: 'Entity type (e.g., "decision", "feature", "bug_fix", "code_change", "test_result", "architecture_decision")',
            },
            observations: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of observations (facts, notes, details about this entity)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags. Scope tags (scope:project:xxx) and tech tags (tech:xxx) will be automatically added based on current project context.',
            },
            metadata: {
              type: 'object',
              description: 'Optional metadata',
            },
          },
          required: ['name', 'entityType', 'observations'],
        },
      },
    },
    required: ['entities'],
  },

  /**
   * Handler for create-entities tool
   *
   * Automatically adds scope and tech tags to all created entities.
   *
   * @param args - Tool arguments
   * @param knowledgeGraph - KnowledgeGraph instance
   * @returns Summary of created entities
   */
  async handler(
    args: CreateEntitiesArgs,
    knowledgeGraph: KnowledgeGraph
  ) {
    // Pre-process tags: add scope:project if no scope tag present
    const preparedEntities = args.entities.map(entity => {
      const tags = entity.tags || [];
      const hasScope = tags.some(tag => tag.startsWith('scope:'));
      if (!hasScope) {
        tags.push('scope:project');
      }
      return {
        name: entity.name,
        entityType: entity.entityType,
        observations: entity.observations,
        tags,
        metadata: entity.metadata,
      };
    });

    // Use batch method for single-transaction performance
    const results = knowledgeGraph.createEntitiesBatch(preparedEntities);

    const created = results.filter(r => r.success).map(r => r.name);
    const errors = results
      .filter(r => !r.success)
      .map(r => ({ name: r.name, error: r.error! }));

    // --- Auto-relation inference ---
    // After entity creation, infer and create relations between new entities
    // and existing entities that share topic keywords.
    // Wrapped in try/catch so it NEVER breaks entity creation.
    let autoRelationsCreated = 0;
    try {
      if (created.length > 0) {
        autoRelationsCreated = _inferAndCreateRelations(created, preparedEntities, knowledgeGraph);
      }
    } catch (autoRelErr: unknown) {
      // Log but don't break entity creation
      const msg = autoRelErr instanceof Error ? autoRelErr.message : String(autoRelErr);
      process.stderr.write(`[create-entities] auto-relation inference failed: ${msg}\n`);
    }

    return {
      created,
      count: created.length,
      autoRelationsCreated,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};

// --- Auto-relation helper functions ---

// Entity types to exclude from relation matching (session-specific, not core knowledge)
const EXCLUDED_TYPES = new Set([
  'session_keypoint', 'session_identity', 'task_start', 'session_summary'
]);

/** Maximum number of auto-relations to create per batch to prevent unbounded growth */
const MAX_AUTO_RELATIONS = 50;

/**
 * Extract topic keywords from an entity name.
 * Takes the first 1-2 words that are at least 4 characters long, lowercased.
 * E.g., "MeMesh Auto-Relation Feature" -> ["memesh", "auto"]
 */
function _extractTopicKeywords(name: string): string[] {
  const cleaned = name.replace(/\d{4}-\d{2}-\d{2}/g, '').trim();
  const words = cleaned.split(/[\s_-]+/).filter(w => w.length >= 3);
  return words.slice(0, 2).map(w => w.toLowerCase());
}

/**
 * Check if two sets of keywords share at least one topic keyword.
 */
function _sharesTopic(keywordsA: string[], keywordsB: string[]): boolean {
  return keywordsA.some(k => keywordsB.includes(k));
}

/** Expected error patterns for relation creation (not worth logging) */
const EXPECTED_RELATION_ERRORS = [
  /not found/i,
  /UNIQUE constraint/i,
  /already exists/i,
];

/**
 * Check if an error message is an expected relation-creation error.
 * Uses regex patterns instead of fragile string matching.
 */
function _isExpectedRelationError(message: string): boolean {
  return EXPECTED_RELATION_ERRORS.some(pattern => pattern.test(message));
}

interface RelationResult {
  from: string;
  to: string;
  relationType: RelationType;
}

interface EntityInfo {
  name: string;
  entityType: string;
}

/**
 * Determine the relation type between two entities based on their types.
 * Returns { from, to, relationType } or null if no relation applies.
 */
function _determineRelation(entityA: EntityInfo, entityB: EntityInfo): RelationResult | null {
  const typeA = entityA.entityType;
  const typeB = entityB.entityType;

  // bug_fix + feature -> bug_fix solves feature
  if (typeA === 'bug_fix' && typeB === 'feature') {
    return { from: entityA.name, to: entityB.name, relationType: 'solves' };
  }
  if (typeB === 'bug_fix' && typeA === 'feature') {
    return { from: entityB.name, to: entityA.name, relationType: 'solves' };
  }

  // decision + feature -> feature enabled_by decision
  if (typeA === 'decision' && typeB === 'feature') {
    return { from: entityB.name, to: entityA.name, relationType: 'enabled_by' };
  }
  if (typeB === 'decision' && typeA === 'feature') {
    return { from: entityA.name, to: entityB.name, relationType: 'enabled_by' };
  }

  // lesson_learned + bug_fix -> lesson_learned caused_by bug_fix
  if (typeA === 'lesson_learned' && typeB === 'bug_fix') {
    return { from: entityA.name, to: entityB.name, relationType: 'caused_by' };
  }
  if (typeB === 'lesson_learned' && typeA === 'bug_fix') {
    return { from: entityB.name, to: entityA.name, relationType: 'caused_by' };
  }

  // Same type + same topic -> similar_to
  if (typeA === typeB) {
    return { from: entityA.name, to: entityB.name, relationType: 'similar_to' };
  }

  return null;
}

/**
 * Infer and create relations between newly created entities and existing ones.
 * Returns the number of relations successfully created.
 */
function _inferAndCreateRelations(
  createdNames: string[],
  preparedEntities: Array<{ name: string; entityType: string; observations: string[]; tags?: string[] }>,
  knowledgeGraph: KnowledgeGraph,
): number {
  let relationsCreated = 0;

  // Build lookup for created entities
  const createdMap = new Map<string, { name: string; entityType: string; keywords: string[] }>();
  for (const entity of preparedEntities) {
    if (createdNames.includes(entity.name) && !EXCLUDED_TYPES.has(entity.entityType as EntityType)) {
      createdMap.set(entity.name, {
        name: entity.name,
        entityType: entity.entityType,
        keywords: _extractTopicKeywords(entity.name),
      });
    }
  }

  const createdList = Array.from(createdMap.values());

  // 1. Relate new entities to each other (within the batch)
  for (let i = 0; i < createdList.length && relationsCreated < MAX_AUTO_RELATIONS; i++) {
    for (let j = i + 1; j < createdList.length && relationsCreated < MAX_AUTO_RELATIONS; j++) {
      const a = createdList[i];
      const b = createdList[j];
      if (!_sharesTopic(a.keywords, b.keywords)) continue;
      const rel = _determineRelation(a, b);
      if (rel) {
        try {
          knowledgeGraph.createRelation({
            from: rel.from,
            to: rel.to,
            relationType: rel.relationType,
            metadata: { source: 'auto-relation' },
          });
          relationsCreated++;
        } catch (e: unknown) {
          // Expected: NotFoundError, UNIQUE constraint (duplicate relation)
          // Unexpected: anything else — log it
          if (e instanceof Error && !_isExpectedRelationError(e.message)) {
            process.stderr.write(`[auto-relation] unexpected error: ${e.message}\n`);
          }
        }
      }
    }
  }

  // 2. For each new entity, find existing entities with matching topic keywords
  for (const newEntity of createdList) {
    if (relationsCreated >= MAX_AUTO_RELATIONS) break;
    if (newEntity.keywords.length === 0) continue;

    const candidateNames = new Set<string>();
    for (const keyword of newEntity.keywords) {
      try {
        const matches = knowledgeGraph.searchEntities({
          namePattern: keyword,
          limit: 20,
        });
        for (const match of matches) {
          if (match.name === newEntity.name) continue;
          if (EXCLUDED_TYPES.has(match.entityType as EntityType)) continue;
          if (createdMap.has(match.name)) continue;
          candidateNames.add(match.name);
        }
      } catch (e: unknown) {
        // Search failures are non-critical; log unexpected ones
        if (e instanceof Error && !e.message.includes('not found')) {
          process.stderr.write(`[auto-relation] search error: ${e.message}\n`);
        }
      }
    }

    for (const candidateName of candidateNames) {
      try {
        const candidate = knowledgeGraph.getEntity(candidateName);
        if (!candidate) continue;

        const candidateKeywords = _extractTopicKeywords(candidate.name);
        if (!_sharesTopic(newEntity.keywords, candidateKeywords)) continue;

        const rel = _determineRelation(newEntity, {
          name: candidate.name,
          entityType: candidate.entityType,
        });
        if (rel) {
          knowledgeGraph.createRelation({
            from: rel.from,
            to: rel.to,
            relationType: rel.relationType,
            metadata: { source: 'auto-relation' },
          });
          relationsCreated++;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!_isExpectedRelationError(msg)) {
          process.stderr.write(`[auto-relation] unexpected error: ${msg}\n`);
        }
      }
    }
  }

  return relationsCreated;
}
