// =============================================================================
// MCP Transport Handlers — thin wrapper over core operations
// Responsibilities: Zod validation, MCP result formatting, error wrapping
// Business logic lives in: src/core/operations.ts
// =============================================================================

import { z } from 'zod';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { getDatabase } from '../../db.js';
import {
  RememberSchema, RecallSchema, ForgetSchema, ConsolidateSchema,
  ExportSchema, ImportSchema, LearnSchema, UserPatternsSchema,
} from '../schemas.js';

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
        namespace: {
          type: 'string',
          enum: ['personal', 'team', 'global'],
          description: 'Namespace for organizing the entity (default: "personal")',
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
        namespace: {
          type: 'string',
          enum: ['personal', 'team', 'global'],
          description: 'Filter results by namespace. Omit to search all namespaces.',
        },
        cross_project: {
          type: 'boolean',
          description: 'Search across all project tags (ignores tag filter). Default: false.',
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
  {
    name: 'consolidate',
    description:
      'Compress verbose entity observations using an LLM into 2–3 dense sentences that preserve all key facts. Requires Smart Mode (run: memesh setup). Original observations are replaced by the LLM summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Specific entity name to consolidate' },
        tag: { type: 'string', description: 'Consolidate all entities with this tag' },
        min_observations: {
          type: 'number',
          description: 'Minimum observations required to trigger consolidation (default: 5)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'export',
    description: 'Export memories as JSON for sharing or backup. Returns a portable snapshot of entities and their observations, tags, and relations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tag: { type: 'string', description: 'Export only entities with this tag' },
        namespace: { type: 'string', description: 'Export only from this namespace (personal, team, global)' },
        limit: { type: 'number', description: 'Max entities to export (default: 1000)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'import',
    description: 'Import memories from a JSON export snapshot. Supports skip, append, or overwrite strategies for handling existing entities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        data: { type: 'object', description: 'Export JSON data (from the export tool)' },
        namespace: { type: 'string', description: 'Override namespace for all imported entities' },
        merge_strategy: {
          type: 'string',
          enum: ['skip', 'overwrite', 'append'],
          description: 'How to handle existing entities: skip (default) = leave untouched, append = add observations, overwrite = archive existing and recreate',
        },
      },
      required: ['data', 'merge_strategy'],
      additionalProperties: false,
    },
  },
  {
    name: 'learn',
    description: 'Record a structured lesson from a mistake or discovery. Creates a lesson_learned entity with error, root cause, fix, and prevention.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        error: { type: 'string', description: 'What went wrong' },
        fix: { type: 'string', description: 'What fixed it' },
        root_cause: { type: 'string', description: 'Why it happened (optional)' },
        prevention: { type: 'string', description: 'How to prevent it next time (optional)' },
        severity: {
          type: 'string',
          enum: ['critical', 'major', 'minor'],
          description: 'Severity level (default: minor)',
        },
      },
      required: ['error', 'fix'],
      additionalProperties: false,
    },
  },
  {
    name: 'user_patterns',
    description:
      'Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use at session start for context about the user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['workSchedule', 'toolPreferences', 'focusAreas', 'workflow', 'strengths', 'learningAreas'],
          },
          description: 'Specific categories to return. Omit for all.',
        },
      },
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

export async function handleTool(name: string, args: any): Promise<ToolResult> {
  try {
    if (name === 'remember') {
      const r = parseOrFail(RememberSchema, args);
      if (!r.ok) return r.result;
      return ok(remember(r.data));
    }
    if (name === 'recall') {
      const r = parseOrFail(RecallSchema, args);
      if (!r.ok) return r.result;
      // Use recallEnhanced — internally falls back to sync recall if no LLM configured
      const entities = await recallEnhanced(r.data);
      const kg = new KnowledgeGraph(getDatabase());
      const conflicts = kg.findConflicts(entities.map(e => e.name));
      if (conflicts.length > 0) {
        return ok({ entities, conflicts });
      }
      return ok(entities);
    }
    if (name === 'forget') {
      const r = parseOrFail(ForgetSchema, args);
      if (!r.ok) return r.result;
      return ok(forget(r.data));
    }
    if (name === 'consolidate') {
      const r = parseOrFail(ConsolidateSchema, args);
      if (!r.ok) return r.result;
      return ok(await consolidate(r.data));
    }
    if (name === 'export') {
      const r = parseOrFail(ExportSchema, args);
      if (!r.ok) return r.result;
      return ok(exportMemories(r.data));
    }
    if (name === 'import') {
      const r = parseOrFail(ImportSchema, args);
      if (!r.ok) return r.result;
      return ok(importMemories(r.data));
    }
    if (name === 'learn') {
      const r = parseOrFail(LearnSchema, args);
      if (!r.ok) return r.result;
      return ok(learn(r.data));
    }
    if (name === 'user_patterns') {
      const r = parseOrFail(UserPatternsSchema, args);
      if (!r.ok) return r.result;

      const db = getDatabase();
      const cats = r.data.categories;
      const allCategories = !cats || cats.length === 0;
      const lines: string[] = ['## User Patterns'];

      // --- Work Schedule ---
      if (allCategories || cats!.includes('workSchedule')) {
        const hourDist = db.prepare(`
          SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
          FROM entities GROUP BY hour ORDER BY count DESC
        `).all() as Array<{ hour: number; count: number }>;

        const dayDist = db.prepare(`
          SELECT CASE CAST(strftime('%w', created_at) AS INTEGER)
            WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
            WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
            WHEN 6 THEN 'Saturday' END as day,
            COUNT(*) as count
          FROM entities GROUP BY day ORDER BY count DESC
        `).all() as Array<{ day: string; count: number }>;

        lines.push('', '### Work Schedule');
        const peakHours = hourDist.slice(0, 3).map(h => `${String(h.hour).padStart(2, '0')}:00 (${h.count})`).join(', ');
        lines.push(`Peak hours: ${peakHours || 'No data'}`);
        const busiestDays = dayDist.slice(0, 3).map(d => `${d.day} (${d.count})`).join(', ');
        lines.push(`Busiest days: ${busiestDays || 'No data'}`);
      }

      // --- Tool Preferences ---
      if (allCategories || cats!.includes('toolPreferences')) {
        const sessionObs = db.prepare(`
          SELECT o.content FROM observations o
          JOIN entities e ON o.entity_id = e.id
          WHERE e.type = 'session_keypoint' AND o.content LIKE '[FOCUS]%'
          LIMIT 500
        `).all() as Array<{ content: string }>;

        const toolCounts: Record<string, number> = {};
        for (const row of sessionObs) {
          const match = row.content.match(/Top tools: (.+)/);
          if (match) {
            for (const part of match[1].split(', ')) {
              const toolName = part.split('(')[0].trim();
              if (toolName) toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
            }
          }
        }
        const toolPrefs = Object.entries(toolCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        lines.push('', '### Tool Preferences');
        if (toolPrefs.length > 0) {
          toolPrefs.forEach(([tool, sessions], i) => {
            lines.push(`${i + 1}. ${tool} (${sessions} sessions)`);
          });
        } else {
          lines.push('No tool usage data yet.');
        }
      }

      // --- Focus Areas ---
      if (allCategories || cats!.includes('focusAreas')) {
        const autoTypes = ['session_keypoint', 'commit', 'session_identity', 'workflow_checkpoint'];
        const focusAreas = db.prepare(`
          SELECT type, COUNT(*) as count FROM entities
          WHERE status = 'active' AND type NOT IN (${autoTypes.map(() => '?').join(',')})
          GROUP BY type ORDER BY count DESC LIMIT 10
        `).all(...autoTypes) as Array<{ type: string; count: number }>;

        lines.push('', '### Focus Areas');
        if (focusAreas.length > 0) {
          focusAreas.forEach(f => {
            lines.push(`- ${f.type} (${f.count})`);
          });
        } else {
          lines.push('No focus area data yet.');
        }
      }

      // --- Workflow ---
      if (allCategories || cats!.includes('workflow')) {
        const sessionDurations = db.prepare(`
          SELECT o.content FROM observations o
          JOIN entities e ON o.entity_id = e.id
          WHERE e.type = 'session_keypoint' AND o.content LIKE '[SESSION]%'
          LIMIT 200
        `).all() as Array<{ content: string }>;

        let totalMinutes = 0;
        let sessionCount = 0;
        for (const row of sessionDurations) {
          const match = row.content.match(/Duration: (\d+)m/);
          if (match) {
            totalMinutes += parseInt(match[1]);
            sessionCount++;
          }
        }
        const avgSessionMinutes = sessionCount > 0 ? Math.round(totalMinutes / sessionCount) : 0;

        const commitCount = (db.prepare(
          "SELECT COUNT(*) as c FROM entities WHERE type = 'commit'"
        ).get() as { c: number }).c;
        const totalSessions = (db.prepare(
          "SELECT COUNT(*) as c FROM entities WHERE type = 'session_keypoint'"
        ).get() as { c: number }).c;
        const commitsPerSession = totalSessions > 0 ? Math.round((commitCount / totalSessions) * 10) / 10 : 0;

        lines.push('', '### Workflow');
        lines.push(`Avg session: ${avgSessionMinutes} min | Commits per session: ${commitsPerSession}`);
        lines.push(`Total sessions: ${totalSessions} | Total commits: ${commitCount}`);
      }

      // --- Strengths ---
      if (allCategories || cats!.includes('strengths')) {
        const autoTypes = ['session_keypoint', 'commit', 'session_identity', 'workflow_checkpoint'];
        const strengths = db.prepare(`
          SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
          FROM entities WHERE status = 'active' AND type NOT IN (${autoTypes.map(() => '?').join(',')})
          GROUP BY type HAVING count >= 2
          ORDER BY avgConfidence DESC LIMIT 5
        `).all(...autoTypes) as Array<{ type: string; avgConfidence: number; count: number }>;

        lines.push('', '### Strengths (high confidence areas)');
        if (strengths.length > 0) {
          lines.push('- ' + strengths.map(s => `${s.type} (${s.avgConfidence})`).join(', '));
        } else {
          lines.push('No strength data yet.');
        }
      }

      // --- Learning Areas ---
      if (allCategories || cats!.includes('learningAreas')) {
        const learningTypes = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];
        const learningAreas = db.prepare(`
          SELECT t.tag, COUNT(*) as count FROM tags t
          JOIN entities e ON t.entity_id = e.id
          WHERE e.type IN (${learningTypes.map(() => '?').join(',')})
            AND t.tag NOT LIKE 'date:%' AND t.tag NOT LIKE 'auto%' AND t.tag NOT LIKE 'session%'
            AND t.tag != 'scope:project'
          GROUP BY t.tag ORDER BY count DESC LIMIT 10
        `).all(...learningTypes) as Array<{ tag: string; count: number }>;

        lines.push('', '### Learning Areas');
        if (learningAreas.length > 0) {
          lines.push('- ' + learningAreas.map(l => l.tag).join(', '));
        } else {
          lines.push('No learning area data yet.');
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    return fail(`Unknown tool: ${name}`);
  } catch (err: any) {
    return fail(`Tool "${name}" failed: ${err.message}`);
  }
}
