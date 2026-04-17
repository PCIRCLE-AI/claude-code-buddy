// =============================================================================
// Shared Zod validation schemas for all transports (MCP, HTTP, CLI)
// Single source of truth — imported by handlers.ts and server.ts
// =============================================================================

import { z } from 'zod';

export const RememberSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
  observations: z.array(z.string().max(10000)).max(100).optional(),
  tags: z.array(z.string().max(255)).max(50).optional(),
  relations: z
    .array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) }))
    .max(50)
    .optional(),
  namespace: z.enum(['personal', 'team', 'global']).optional(),
});

export const RecallSchema = z.object({
  query: z.string().max(1000).optional(),
  tag: z.string().max(255).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  include_archived: z.boolean().optional(),
  namespace: z.enum(['personal', 'team', 'global']).optional(),
  cross_project: z.boolean().optional(),
});

export const ForgetSchema = z.object({
  name: z.string().min(1).max(255),
  observation: z.string().max(10000).optional(),
});

export const ConsolidateSchema = z.object({
  name: z.string().max(255).optional(),
  tag: z.string().max(255).optional(),
  min_observations: z.number().int().min(1).optional(),
});

export const ExportSchema = z.object({
  tag: z.string().max(255).optional(),
  namespace: z.string().max(50).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const ExportResultSchema = z.object({
  version: z.string(),
  exported_at: z.string(),
  entity_count: z.number(),
  entities: z.array(z.object({
    name: z.string().min(1).max(255),
    type: z.string().min(1).max(100),
    namespace: z.string(),
    observations: z.array(z.string().max(10000)),
    tags: z.array(z.string().max(255)),
    relations: z.array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) })),
  })),
});

export const ImportSchema = z.object({
  data: ExportResultSchema,
  namespace: z.string().max(50).optional(),
  merge_strategy: z.enum(['skip', 'overwrite', 'append']),
});

export const LearnSchema = z.object({
  error: z.string().min(1).max(5000),
  fix: z.string().min(1).max(5000),
  root_cause: z.string().max(5000).optional(),
  prevention: z.string().max(5000).optional(),
  severity: z.enum(['critical', 'major', 'minor']).optional(),
});
