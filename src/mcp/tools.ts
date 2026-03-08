import { z } from 'zod';
import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';

// ---------------------------------------------------------------------------
// Zod validation schemas
// ---------------------------------------------------------------------------

const RememberSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  observations: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  relations: z
    .array(z.object({ to: z.string().min(1), type: z.string().min(1) }))
    .optional(),
});

const RecallSchema = z.object({
  query: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ForgetSchema = z.object({
  name: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Tool definitions (raw JSON Schema for MCP registration)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: 'remember',
    description:
      'Store knowledge as an entity with observations, tags, and relations. Use this to remember decisions, patterns, lessons learned, and important context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Unique entity name (e.g., "auth-decision", "jwt-pattern")',
        },
        type: {
          type: 'string',
          description:
            'Entity type (e.g., "decision", "pattern", "lesson", "commit")',
        },
        observations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key facts or observations about this entity',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tags for filtering (e.g., "project:myapp", "type:decision")',
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Target entity name' },
              type: {
                type: 'string',
                description:
                  'Relation type (e.g., "implements", "related-to")',
              },
            },
            required: ['to', 'type'],
          },
          description: 'Relations to other entities',
        },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'recall',
    description:
      'Search and retrieve stored knowledge. Uses full-text search with optional project tag filtering. Call with no query to list recent memories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search query (uses FTS5 full-text search). Leave empty to list recent.',
        },
        tag: {
          type: 'string',
          description: 'Filter by tag (e.g., "project:myapp")',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 20, max: 100)',
        },
      },
    },
  },
  {
    name: 'forget',
    description:
      'Delete an entity and all its associated observations, relations, and tags.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Entity name to delete' },
      },
      required: ['name'],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleRemember(args: z.infer<typeof RememberSchema>): ToolResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const entityId = kg.createEntity(args.name, args.type, {
    observations: args.observations,
    tags: args.tags,
  });

  // Create relations (target entities must already exist)
  const relationsCreated: Array<{ to: string; type: string }> = [];
  const relationErrors: string[] = [];

  if (args.relations) {
    for (const rel of args.relations) {
      try {
        kg.createRelation(args.name, rel.to, rel.type);
        relationsCreated.push(rel);
      } catch (err: any) {
        relationErrors.push(
          `Relation to "${rel.to}" failed: ${err.message}`
        );
      }
    }
  }

  return ok({
    stored: true,
    entityId,
    name: args.name,
    type: args.type,
    observations: args.observations?.length ?? 0,
    tags: args.tags?.length ?? 0,
    relations: relationsCreated.length,
    ...(relationErrors.length > 0 ? { relationErrors } : {}),
  });
}

function handleRecall(args: z.infer<typeof RecallSchema>): ToolResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const entities = kg.search(args.query, {
    tag: args.tag,
    limit: args.limit,
  });

  return ok(entities);
}

function handleForget(args: z.infer<typeof ForgetSchema>): ToolResult {
  const db = getDatabase();
  const kg = new KnowledgeGraph(db);

  const result = kg.deleteEntity(args.name);

  if (!result.deleted) {
    return ok({ deleted: false, message: `Entity "${args.name}" not found` });
  }

  return ok({ deleted: true, name: args.name });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const schemas: Record<string, z.ZodType> = {
  remember: RememberSchema,
  recall: RecallSchema,
  forget: ForgetSchema,
};

const handlers: Record<string, (args: any) => ToolResult> = {
  remember: handleRemember,
  recall: handleRecall,
  forget: handleForget,
};

export function handleTool(name: string, args: any): ToolResult {
  const schema = schemas[name];
  const handler = handlers[name];

  if (!schema || !handler) {
    return fail(`Unknown tool: ${name}`);
  }

  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const message =
      parsed.error instanceof z.ZodError
        ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(parsed.error);
    return fail(message);
  }

  return handler(parsed.data);
}
