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
        return {
            created,
            count: created.length,
            errors: errors.length > 0 ? errors : undefined,
        };
    },
};
//# sourceMappingURL=create-entities.js.map