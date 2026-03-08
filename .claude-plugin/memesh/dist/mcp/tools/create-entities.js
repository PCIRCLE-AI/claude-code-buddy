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
        let autoRelationsCreated = 0;
        try {
            if (created.length > 0) {
                autoRelationsCreated = _inferAndCreateRelations(created, preparedEntities, knowledgeGraph);
            }
        }
        catch (autoRelErr) {
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
const EXCLUDED_TYPES = new Set([
    'session_keypoint', 'session_identity', 'task_start', 'session_summary'
]);
const MAX_AUTO_RELATIONS = 50;
function _extractTopicKeywords(name) {
    const cleaned = name.replace(/\d{4}-\d{2}-\d{2}/g, '').trim();
    const words = cleaned.split(/[\s_-]+/).filter(w => w.length >= 3);
    return words.slice(0, 2).map(w => w.toLowerCase());
}
function _sharesTopic(keywordsA, keywordsB) {
    return keywordsA.some(k => keywordsB.includes(k));
}
const EXPECTED_RELATION_ERRORS = [
    /not found/i,
    /UNIQUE constraint/i,
    /already exists/i,
];
function _isExpectedRelationError(message) {
    return EXPECTED_RELATION_ERRORS.some(pattern => pattern.test(message));
}
function _determineRelation(entityA, entityB) {
    const typeA = entityA.entityType;
    const typeB = entityB.entityType;
    if (typeA === 'bug_fix' && typeB === 'feature') {
        return { from: entityA.name, to: entityB.name, relationType: 'solves' };
    }
    if (typeB === 'bug_fix' && typeA === 'feature') {
        return { from: entityB.name, to: entityA.name, relationType: 'solves' };
    }
    if (typeA === 'decision' && typeB === 'feature') {
        return { from: entityB.name, to: entityA.name, relationType: 'enabled_by' };
    }
    if (typeB === 'decision' && typeA === 'feature') {
        return { from: entityA.name, to: entityB.name, relationType: 'enabled_by' };
    }
    if (typeA === 'lesson_learned' && typeB === 'bug_fix') {
        return { from: entityA.name, to: entityB.name, relationType: 'caused_by' };
    }
    if (typeB === 'lesson_learned' && typeA === 'bug_fix') {
        return { from: entityB.name, to: entityA.name, relationType: 'caused_by' };
    }
    if (typeA === typeB) {
        return { from: entityA.name, to: entityB.name, relationType: 'similar_to' };
    }
    return null;
}
function _inferAndCreateRelations(createdNames, preparedEntities, knowledgeGraph) {
    let relationsCreated = 0;
    const createdMap = new Map();
    for (const entity of preparedEntities) {
        if (createdNames.includes(entity.name) && !EXCLUDED_TYPES.has(entity.entityType)) {
            createdMap.set(entity.name, {
                name: entity.name,
                entityType: entity.entityType,
                keywords: _extractTopicKeywords(entity.name),
            });
        }
    }
    const createdList = Array.from(createdMap.values());
    for (let i = 0; i < createdList.length && relationsCreated < MAX_AUTO_RELATIONS; i++) {
        for (let j = i + 1; j < createdList.length && relationsCreated < MAX_AUTO_RELATIONS; j++) {
            const a = createdList[i];
            const b = createdList[j];
            if (!_sharesTopic(a.keywords, b.keywords))
                continue;
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
                catch (e) {
                    if (e instanceof Error && !_isExpectedRelationError(e.message)) {
                        process.stderr.write(`[auto-relation] unexpected error: ${e.message}\n`);
                    }
                }
            }
        }
    }
    for (const newEntity of createdList) {
        if (relationsCreated >= MAX_AUTO_RELATIONS)
            break;
        if (newEntity.keywords.length === 0)
            continue;
        const candidateNames = new Set();
        for (const keyword of newEntity.keywords) {
            try {
                const matches = knowledgeGraph.searchEntities({
                    namePattern: keyword,
                    limit: 20,
                });
                for (const match of matches) {
                    if (match.name === newEntity.name)
                        continue;
                    if (EXCLUDED_TYPES.has(match.entityType))
                        continue;
                    if (createdMap.has(match.name))
                        continue;
                    candidateNames.add(match.name);
                }
            }
            catch (e) {
                if (e instanceof Error && !e.message.includes('not found')) {
                    process.stderr.write(`[auto-relation] search error: ${e.message}\n`);
                }
            }
        }
        for (const candidateName of candidateNames) {
            try {
                const candidate = knowledgeGraph.getEntity(candidateName);
                if (!candidate)
                    continue;
                const candidateKeywords = _extractTopicKeywords(candidate.name);
                if (!_sharesTopic(newEntity.keywords, candidateKeywords))
                    continue;
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
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!_isExpectedRelationError(msg)) {
                    process.stderr.write(`[auto-relation] unexpected error: ${msg}\n`);
                }
            }
        }
    }
    return relationsCreated;
}
//# sourceMappingURL=create-entities.js.map