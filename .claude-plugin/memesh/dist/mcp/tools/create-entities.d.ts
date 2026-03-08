import type { KnowledgeGraph } from '../../knowledge-graph/index.js';
export interface CreateEntitiesArgs {
    entities: Array<{
        name: string;
        entityType: string;
        observations: string[];
        tags?: string[];
        metadata?: Record<string, unknown>;
    }>;
}
export declare const createEntitiesTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            entities: {
                type: string;
                description: string;
                items: {
                    type: string;
                    properties: {
                        name: {
                            type: string;
                            description: string;
                        };
                        entityType: {
                            type: string;
                            description: string;
                        };
                        observations: {
                            type: string;
                            items: {
                                type: string;
                            };
                            description: string;
                        };
                        tags: {
                            type: string;
                            items: {
                                type: string;
                            };
                            description: string;
                        };
                        metadata: {
                            type: string;
                            description: string;
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
    handler(args: CreateEntitiesArgs, knowledgeGraph: KnowledgeGraph): Promise<{
        created: string[];
        count: number;
        autoRelationsCreated: number;
        errors: {
            name: string;
            error: string;
        }[] | undefined;
    }>;
};
//# sourceMappingURL=create-entities.d.ts.map