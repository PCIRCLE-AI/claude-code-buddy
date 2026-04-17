// =============================================================================
// MCP Transport Handlers — thin wrapper over core operations
// Responsibilities: Zod validation, MCP result formatting, error wrapping
// Business logic lives in: src/core/operations.ts
// =============================================================================

import { z } from 'zod';
import { remember, recall, forget } from '../../core/operations.js';

// ---------------------------------------------------------------------------
// Zod validation schemas (transport-layer responsibility)
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
  include_archived: z.boolean().optional(),
});

const ForgetSchema = z.object({
  name: z.string().min(1),
  observation: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool definitions (MCP-specific format)
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
            'Unique entity name (e.g., "auth-decision", "jwt-pattern"). Reusing a name appends observations and dedupes tags instead of replacing the entity.',
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
            additionalProperties: false,
          },
          description: 'Relations to other entities',
        },
      },
      required: ['name', 'type'],
      additionalProperties: false,
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
        include_archived: {
          type: 'boolean',
          description: 'Include archived (forgotten) entities in results. Default: false.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'forget',
    description:
      'Archive an entity (soft-delete) or remove a specific observation. Archived entities are hidden from recall but preserved in the database. To remove just one observation, pass the observation parameter.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Entity name to archive or modify' },
        observation: {
          type: 'string',
          description: 'If provided, only this specific observation is removed (entity stays active). If omitted, the entire entity is archived.',
        },
      },
      required: ['name'],
      additionalProperties: false,
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
// Dispatcher — validates with Zod, delegates to core, wraps result
// ---------------------------------------------------------------------------

function parseOrFail<T>(schema: z.ZodType<T>, args: unknown): { ok: true; data: T } | { ok: false; result: ToolResult } {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const message =
      parsed.error instanceof z.ZodError
        ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(parsed.error);
    return { ok: false, result: fail(message) };
  }
  return { ok: true, data: parsed.data };
}

export function handleTool(name: string, args: any): ToolResult {
  try {
    if (name === 'remember') {
      const r = parseOrFail(RememberSchema, args);
      if (!r.ok) return r.result;
      return ok(remember(r.data));
    }
    if (name === 'recall') {
      const r = parseOrFail(RecallSchema, args);
      if (!r.ok) return r.result;
      return ok(recall(r.data));
    }
    if (name === 'forget') {
      const r = parseOrFail(ForgetSchema, args);
      if (!r.ok) return r.result;
      return ok(forget(r.data));
    }
    return fail(`Unknown tool: ${name}`);
  } catch (err: any) {
    return fail(`Tool "${name}" failed: ${err.message}`);
  }
}
