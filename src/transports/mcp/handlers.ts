// =============================================================================
// MCP Transport Handlers — thin wrapper over core operations
// Responsibilities: Zod validation, MCP result formatting, error wrapping
// Business logic lives in: src/core/operations.ts
// =============================================================================

import { z } from 'zod';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { getDatabase } from '../../db.js';
import { computePatterns } from '../../core/patterns.js';
import { verifyAgentWork } from '../../core/verifier.js';
import {
  RememberSchema, RecallSchema, ForgetSchema,
  ExportSchema, ImportSchema, LearnSchema, UserPatternsSchema,
  VerifyAgentWorkSchema,
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
                // Any string is accepted and most are inert labels, but two
                // types make MeMesh DO something and one of them archives an
                // entity. They are named here because this description is the
                // only thing a model ever reads about relation types — the
                // previous examples ("implements", "related-to") were both
                // inert, so the behavioural pair was undiscoverable and
                // conflict detection ran on every recall with nothing it could
                // ever find. Kept in step with the code by
                // tests/relation-types-documented.test.ts.
                description:
                  'Relation type. Free-form label (e.g. "implements", "related-to"), except for two that change behaviour: ' +
                  '"supersedes" archives the target entity — use it when this memory replaces an older one; ' +
                  '"contradicts" flags both memories as a conflict every time either is recalled — use it when two memories cannot both be true.',
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
          description: 'Namespace for organizing the entity. Omit it to leave an existing memory where it is — supplying it MOVES a memory that already exists, and it drops out of every other scoped view. New memories default to "personal".',
        },
      },
      required: ['name', 'type'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description:
      'Search and retrieve stored knowledge. Uses full-text search with optional project tag filtering. Call with no query to list recent memories. Query words are OR-ed and results ranked by relevance, so a question phrased naturally works — adding words narrows the ranking, not the result set.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Words are OR-ed and ranked by relevance (BM25); only the first 32 terms are used, and words present in most of the corpus are ignored as noise. Leave empty to list recent.',
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
          // "archive existing and recreate" was a lie the agent could not
          // check. `clearEntityData` runs `DELETE FROM observations` and
          // `DELETE FROM tags` — nothing is archived and nothing is
          // recoverable, unlike `forget`, which really does soft-archive and
          // is what an agent reading "archive" would expect. And
          // `merge_strategy` is in `required` two lines below, so "(default)"
          // sent callers to omit a field the schema rejects.
          // API_REFERENCE.md has said the truth all along; this string is what
          // the agent actually reads.
          description: 'Required. How to handle an entity that already exists: skip = leave it untouched, append = add these observations to it, overwrite = REPLACE its observations and tags (the old ones are deleted, not archived — this cannot be undone)',
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
  {
    name: 'verify_agent_work',
    description:
      'Record a verification report for work done by a background agent. Runs a deterministic git reality-check on the workdir (files changed vs claim) and persists the result as a verification_record entity. Returns verdict: "pass" | "fail" | "unverified". IMPORTANT: calling this with neither `claim` nor `report` checks nothing and returns "unverified" — it counts changed files, which is not a verification. To get a "pass" you must give it something to check: `claim.expected_files`, a `report`, or both. Heavier checks (typecheck/tests/lint) are expected to be pre-computed by a local hook and passed in via report.*.pass — this tool focuses on persistence + cross-checking, not running test suites.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_id: {
          type: 'string',
          description: 'Identifier for the agent whose work is being verified.',
        },
        workdir: {
          type: 'string',
          description: 'Absolute path to the git working tree the agent edited.',
        },
        base: {
          type: 'string',
          description: 'Git ref/sha to diff against. Defaults to merge-base with origin/main.',
        },
        claim: {
          type: 'object',
          properties: {
            expected_files: { type: 'number', description: 'How MANY files the agent claimed to change — a count, not a list. Only committed changes are counted.' },
          },
          additionalProperties: false,
        },
        report: {
          type: 'object',
          description: 'Pre-computed external verification report (typecheck/tests/lint/build).',
          properties: {
            pass: { type: 'boolean' },
            typecheck: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['pass'] },
            tests: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['pass'] },
            lint: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['pass'] },
            build: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } }, required: ['pass'] },
            summary: { type: 'string' },
          },
          required: ['pass'],
        },
      },
      required: ['agent_id', 'workdir'],
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

/**
 * The client's self-declared `initialize` name is the ONE string that reaches
 * entity metadata without passing a zod schema — every other write field is
 * capped and validated in schemas.ts. A hostile or buggy client can declare a
 * multi-megabyte name (copied into every entity written that session) or one
 * full of control characters (rendered later by the dashboard and exports).
 * Clamp it at the boundary: strip control characters, cap at 64, and treat an
 * empty or all-control name the same as a missing one — `?? 'mcp'` alone
 * missed `name: ""`, which skipped both the fallback and the stamp.
 * Deliberately NOT identity verification: stdio has no authentication, the
 * value is self-declared by design, and any local process could write the
 * database directly anyway.
 */
export function normalizeClientHost(name: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return (name ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 64) || 'mcp';
}

/**
 * `sourceHost` is which MCP client is on the other end of stdio — the name it
 * declared in `initialize` (Claude Code, Codex and Gemini all send one),
 * normalized by `normalizeClientHost`. It is threaded through to the write
 * operations as provenance and is NOT a tool parameter: a provenance field
 * the model could set is not provenance.
 */
export async function handleTool(name: string, args: Record<string, unknown> | undefined, sourceHost?: string): Promise<ToolResult> {
  try {
    if (name === 'remember') {
      const r = parseOrFail(RememberSchema, args);
      if (!r.ok) return r.result;
      return ok(remember({ ...r.data, sourceHost }));
    }
    if (name === 'recall') {
      const r = parseOrFail(RecallSchema, args);
      if (!r.ok) return r.result;
      // recallWithConflicts: recall + conflict annotation, owned by core so the
      // three transports can't drift on the wrapping rule.
      const { entities, conflicts } = await recallWithConflicts(r.data);
      return ok(conflicts.length > 0 ? { entities, conflicts } : entities);
    }
    if (name === 'forget') {
      const r = parseOrFail(ForgetSchema, args);
      if (!r.ok) return r.result;
      return ok(forget(r.data));
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
      return ok(learn({ ...r.data, sourceHost }));
    }
    if (name === 'user_patterns') {
      const r = parseOrFail(UserPatternsSchema, args);
      if (!r.ok) return r.result;

      const db = getDatabase();
      const cats = r.data.categories;
      const allCategories = !cats || cats.length === 0;
      const data = computePatterns(db, cats);
      const lines: string[] = ['## User Patterns'];

      // --- Work Schedule ---
      if (allCategories || cats!.includes('workSchedule')) {
        lines.push('', '### Work Schedule');
        // Sort by count DESC for display (data is ordered by hour for consistency)
        const peakHours = [...data.workSchedule.hourDistribution]
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map(h => `${String(h.hour).padStart(2, '0')}:00 (${h.count})`)
          .join(', ');
        lines.push(`Peak hours: ${peakHours || 'No data'}`);
        // MCP output is agent-facing English text; dayNum (0 = Sunday) is
        // resolved here because computePatterns no longer bakes names in.
        const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const busiestDays = [...data.workSchedule.dayDistribution]
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map(d => `${DAY_NAMES[d.dayNum] ?? d.dayNum} (${d.count})`)
          .join(', ');
        lines.push(`Busiest days: ${busiestDays || 'No data'}`);
      }

      // --- Tool Preferences ---
      if (allCategories || cats!.includes('toolPreferences')) {
        lines.push('', '### Tool Preferences');
        if (data.toolPreferences.length > 0) {
          data.toolPreferences.forEach((tp, i) => {
            lines.push(`${i + 1}. ${tp.tool} (${tp.sessions} sessions)`);
          });
        } else {
          lines.push('No tool usage data yet.');
        }
      }

      // --- Focus Areas ---
      if (allCategories || cats!.includes('focusAreas')) {
        lines.push('', '### Focus Areas');
        if (data.focusAreas.length > 0) {
          data.focusAreas.forEach(f => {
            lines.push(`- ${f.type} (${f.count})`);
          });
        } else {
          lines.push('No focus area data yet.');
        }
      }

      // --- Workflow ---
      if (allCategories || cats!.includes('workflow')) {
        lines.push('', '### Workflow');
        lines.push(`Avg session: ${data.workflow.avgSessionMinutes} min | Commits per session: ${data.workflow.commitsPerSession}`);
        lines.push(`Total sessions: ${data.workflow.totalSessions} | Total commits: ${data.workflow.totalCommits}`);
      }

      // --- Strengths ---
      if (allCategories || cats!.includes('strengths')) {
        lines.push('', '### Strengths (high confidence areas)');
        if (data.strengths.length > 0) {
          lines.push('- ' + data.strengths.map(s => `${s.type} (${s.avgConfidence})`).join(', '));
        } else {
          lines.push('No strength data yet.');
        }
      }

      // --- Learning Areas ---
      if (allCategories || cats!.includes('learningAreas')) {
        lines.push('', '### Learning Areas');
        if (data.learningAreas.length > 0) {
          lines.push('- ' + data.learningAreas.map(l => l.tag).join(', '));
        } else {
          lines.push('No learning area data yet.');
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    if (name === 'verify_agent_work') {
      const r = parseOrFail(VerifyAgentWorkSchema, args);
      if (!r.ok) return r.result;
      return ok(verifyAgentWork(r.data));
    }
    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
