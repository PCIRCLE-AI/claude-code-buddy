// =============================================================================
// MCP Transport Handlers — thin wrapper over core operations
// Responsibilities: Zod validation, MCP result formatting, error wrapping
// Business logic lives in: src/core/operations.ts
// =============================================================================

import { z } from 'zod';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { getDatabase } from '../../db.js';
import { computePatterns } from '../../core/patterns.js';
import { assembleBriefing } from '../../core/briefing.js';
import { getTaskState, setTaskState } from '../../core/task-state-store.js';
import {
  RememberSchema, RecallSchema, ForgetSchema,
  BriefingSchema, ExportSchema, ImportSchema, LearnSchema, TaskStateSchema, UserPatternsSchema,
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
        title: {
          type: 'string',
          description:
            'Short human-readable label for this memory (e.g. "Use PKCE over implicit flow for auth"), distinct from name (which stays a stable machine key). Shown as the headline in the dashboard and in memory recalled by an agent, instead of the raw name. Reusing an existing name with a different title UPDATES the title; omit to leave an existing title untouched.',
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
                  '"contradicts" flags both memories as a conflict every time either is recalled — use it when two memories cannot both be true. ' +
                  'For causal links between decisions and outcomes, use "caused" or "influenced" (inert labels, but the shared vocabulary makes causal chains traversable): ' +
                  'state causality explicitly when you KNOW it — MeMesh never infers it from timestamps or co-occurrence, so an unstated cause is an unrecorded one.',
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
        limit: { type: 'number', description: 'Max entities to export (default: 1000). The default is a SUBSET, not a backup — check `truncated` in the response, and for a full backup pass a limit above the graph size.' },
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
    name: 'task_state',
    // The description carries the one rule that keeps this honest, in the
    // place the model actually reads it. These four fields are injected at the
    // top of the next session and acted on as fact, so a value the model
    // GUESSED — "they edited the parser, the goal must be the parser" — is a
    // wrong instruction to a future session with nothing to contradict it.
    // Only what someone actually said belongs here.
    description:
      'Read or update where the work stands on this project: the goal, what is next, what is blocked, what was just finished. Call with no arguments to read it. Injected at the start of the next session, so record ONLY what the user actually stated — never infer a goal or a next step from files edited or commands run, and leave a field out if it was not said. Pass an empty string to clear a field (e.g. blocked: "" once a blocker is resolved).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: {
          type: 'string',
          description: 'Project name. Omit to use the current working directory’s project.',
        },
        goal: { type: 'string', description: 'What this work is FOR — the outcome being aimed at' },
        next: { type: 'string', description: 'The next concrete step' },
        blocked: { type: 'string', description: 'What is standing in the way, if anything' },
        done: { type: 'string', description: 'What was just finished' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'briefing',
    description:
      'The work topology for a project, assembled and ready to use: where the work was left off (goal / next / blocked / done), decisions and direction, lessons not to repeat, what is known, and recent activity — the same block Claude Code receives at session start. Call once at the START of a session to load project context; use recall for specific questions after that. Content is wrapped as untrusted background data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: {
          type: 'string',
          description: 'Project name. Omit to use the current working directory’s project.',
        },
      },
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
            enum: ['workSchedule', 'focusAreas', 'workflow', 'strengths', 'learningAreas'],
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

/**
 * Gemini CLI sends `null` for optional parameters its model leaves blank,
 * where Claude Code and Codex omit the key entirely. Zod's `.optional()`
 * accepts the missing key but rejects the explicit null, so the exact same
 * recall that succeeds from Codex fails from Gemini with a type error. At
 * this boundary a null-valued property can only mean "left blank" — no
 * memesh tool uses null as a sentinel — so it is dropped before validation.
 * Array ELEMENTS are left alone: a null inside `observations` is malformed
 * data and must still be rejected, not silently swallowed.
 */
function stripNullProps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullProps);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null) out[k] = stripNullProps(v);
    }
    return out;
  }
  return value;
}

function parseOrFail<T>(schema: z.ZodType<T>, args: unknown): { ok: true; data: T } | { ok: false; result: ToolResult } {
  const raw = args ?? {};

  // Unknown keys are rejected BEFORE any null-stripping.
  //
  // `stripNullProps` deletes every null-valued property, and it used to run
  // first — so `.strict()` never saw a key whose value happened to be null.
  // `forget({name, observations: null})` (plural: the word `remember` uses)
  // therefore lost the key entirely, fell through to the archive-the-entity
  // branch, and reported `{archived:true}`. That is the exact destructive
  // behaviour `.strict()` was introduced to end, reached by a different door.
  //
  // The null-stripping itself stays, and its premise is unchanged: for a
  // KNOWN optional field, a null from a client that fills blanks with null
  // (Gemini CLI does) means "left blank". That premise says nothing about a
  // field the schema does not declare, which is why the check is split.
  const strictPass = schema.safeParse(raw);
  if (!strictPass.success) {
    const unknownKeys = strictPass.error.issues.filter((i) => i.code === 'unrecognized_keys');
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        result: fail(unknownKeys.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')),
      };
    }
  }

  const parsed = schema.safeParse(stripNullProps(raw));
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
      //
      // The MCP payload is ALWAYS an object, never a bare array. Gemini CLI's
      // transport JSON-parses the first text content item and, when it parses,
      // assigns the value to the result's `structuredContent` — which the MCP
      // SDK requires to be an object. A bare-array payload therefore failed
      // every Gemini recall with "structuredContent: expected record, received
      // array" while Claude Code and Codex, which don't do that rewrite, read
      // the same payload fine. An object envelope also removes the old bimodal
      // shape (array normally, object when conflicts exist) that every
      // consumer otherwise has to special-case.
      // `retrieval` rides every envelope: how the results were found (fts vs
      // hybrid), whether the vector side silently degraded, and whether the
      // window filled — the three things a caller cannot see from the rows.
      const { entities, conflicts, retrieval } = await recallWithConflicts(r.data);
      return ok(conflicts.length > 0 ? { entities, retrieval, conflicts } : { entities, retrieval });
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
    if (name === 'task_state') {
      const r = parseOrFail(TaskStateSchema, args);
      if (!r.ok) return r.result;
      const { project, ...patch } = r.data;
      // No field mentioned at all = a read. Distinguished by which KEYS
      // arrived, not by their values: `blocked: ""` is a write that clears,
      // and treating it as "nothing to do" would make a blocker unremovable.
      if (Object.keys(patch).length === 0) return ok(getTaskState(project));
      return ok(setTaskState({ project, patch, sourceHost }));
    }
    if (name === 'briefing') {
      const r = parseOrFail(BriefingSchema, args);
      if (!r.ok) return r.result;
      return ok(assembleBriefing(r.data.project));
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
        lines.push(`Commits per session: ${data.workflow.commitsPerSession}`);
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
    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
