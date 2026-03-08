export const createEntitiesTool = {
    name: 'create-entities',
    description: 'Create new entities in the Knowledge Graph. Record decisions, features, bug fixes, code changes, and other knowledge for future recall.',
    inputSchema: {
        type: 'object',
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
    async handler(args, knowledgeGraph) {
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
        const results = knowledgeGraph.createEntitiesBatch(preparedEntities);
        const created = results.filter(r => r.success).map(r => r.name);
        const errors = results
            .filter(r => !r.success)
            .map(r => ({ name: r.name, error: r.error }));
        // --- Auto-relation inference ---
        // After entity creation, infer and create relations between new entities
        // and existing entities that share topic keywords.
        // Wrapped in try/catch so it NEVER breaks entity creation.
        let autoRelationsCreated = 0;
        try {
            if (created.length > 0) {
                autoRelationsCreated = _inferAndCreateRelations(created, preparedEntities, knowledgeGraph);
            }
        }
        catch (_autoRelErr) {
            // Silently ignore - auto-relations are best-effort
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

// Known project/topic prefixes for keyword extraction
const KNOWN_PREFIXES = ['memesh', 'a2a', 'agentgigdao', 'nba', 'polytrador'];

// Entity types to exclude from relation matching (session-specific, not core knowledge)
const EXCLUDED_TYPES = new Set([
    'session_keypoint', 'session_identity', 'task_start', 'session_summary'
]);

/**
 * Extract topic keywords from an entity name.
 * Takes the first 1-2 significant words, lowercased.
 * E.g., "MeMesh Auto-Relation Feature" -> ["memesh", "auto-relation"]
 */
function _extractTopicKeywords(name) {
    // Remove date suffixes like "2026-01-03"
    const cleaned = name.replace(/\d{4}-\d{2}-\d{2}/g, '').trim();
    // Split on spaces, hyphens, underscores
    const words = cleaned.split(/[\s_-]+/).filter(w => w.length > 1);
    // Take first 2 significant words
    const keywords = words.slice(0, 2).map(w => w.toLowerCase());
    return keywords;
}

/**
 * Check if two sets of keywords share at least one topic keyword.
 */
function _sharesTopic(keywordsA, keywordsB) {
    return keywordsA.some(k => keywordsB.includes(k));
}

/**
 * Determine the relation type between two entities based on their types.
 * Returns { from, to, relationType } or null if no relation applies.
 */
function _determineRelation(entityA, entityB) {
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

    // feature + feature (already covered by same-type above)
    // For different types not covered above, no auto-relation
    return null;
}

/**
 * Infer and create relations between newly created entities and existing ones.
 * Returns the number of relations successfully created.
 */
function _inferAndCreateRelations(createdNames, preparedEntities, knowledgeGraph) {
    let relationsCreated = 0;

    // Build a map of created entities: name -> { name, entityType, keywords }
    const createdMap = new Map();
    for (const entity of preparedEntities) {
        if (createdNames.includes(entity.name)) {
            createdMap.set(entity.name, {
                name: entity.name,
                entityType: entity.entityType,
                keywords: _extractTopicKeywords(entity.name),
            });
        }
    }

    // 1. Create relations between entities in the same batch (same topic)
    const createdList = Array.from(createdMap.values());
    for (let i = 0; i < createdList.length; i++) {
        for (let j = i + 1; j < createdList.length; j++) {
            const a = createdList[i];
            const b = createdList[j];
            if (a.keywords.length === 0 || b.keywords.length === 0) continue;
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
                }
                catch (_e) {
                    // Ignore individual relation creation failures (e.g., UNIQUE constraint)
                }
            }
        }
    }

    // 2. For each new entity, find existing entities with matching topic keywords
    for (const newEntity of createdList) {
        if (newEntity.keywords.length === 0) continue;

        // Search for existing entities matching each keyword
        const candidateNames = new Set();
        for (const keyword of newEntity.keywords) {
            try {
                const matches = knowledgeGraph.searchEntities({
                    namePattern: keyword,
                    limit: 20,
                });
                for (const match of matches) {
                    // Skip self, skip excluded types, skip other newly created entities
                    if (match.name === newEntity.name) continue;
                    if (EXCLUDED_TYPES.has(match.entityType)) continue;
                    if (createdMap.has(match.name)) continue; // already handled in batch relations
                    candidateNames.add(match.name);
                }
            }
            catch (_e) {
                // Ignore search failures
            }
        }

        // Try to create relations with each candidate
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
            }
            catch (_e) {
                // Ignore individual relation creation failures
            }
        }
    }

    return relationsCreated;
}
//# sourceMappingURL=create-entities.js.map