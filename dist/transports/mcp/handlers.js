import { z } from 'zod';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { getDatabase } from '../../db.js';
import { computePatterns } from '../../core/patterns.js';
import { assembleBriefing } from '../../core/briefing.js';
import { getTaskState, setTaskState } from '../../core/task-state-store.js';
import { RememberSchema, RecallSchema, ForgetSchema, BriefingSchema, ExportSchema, ImportSchema, LearnSchema, TaskStateSchema, UserPatternsSchema, } from '../schemas.js';
export const TOOL_DEFINITIONS = [
    {
        name: 'remember',
        description: 'Store knowledge as an entity with observations, tags, and relations. Use this to remember decisions, patterns, lessons learned, and important context.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Unique entity name (e.g., "auth-decision", "jwt-pattern"). Reusing a name appends observations and dedupes tags instead of replacing the entity.',
                },
                type: {
                    type: 'string',
                    description: 'Entity type (e.g., "decision", "pattern", "lesson", "commit")',
                },
                title: {
                    type: 'string',
                    description: 'Short human-readable label for this memory (e.g. "Use PKCE over implicit flow for auth"), distinct from name (which stays a stable machine key). Shown as the headline in the dashboard and in memory recalled by an agent, instead of the raw name. Reusing an existing name with a different title UPDATES the title; omit to leave an existing title untouched.',
                },
                observations: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Key facts or observations about this entity',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags for filtering (e.g., "project:myapp", "type:decision")',
                },
                relations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            to: { type: 'string', description: 'Target entity name' },
                            type: {
                                type: 'string',
                                description: 'Relation type. Free-form label (e.g. "implements", "related-to"), except for two that change behaviour: ' +
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
        description: 'Search and retrieve stored knowledge. Uses full-text search with optional project tag filtering. Call with no query to list recent memories. Query words are OR-ed and results ranked by relevance, so a question phrased naturally works — adding words narrows the ranking, not the result set.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query. Words are OR-ed and ranked by relevance (BM25); only the first 32 terms are used, and words present in most of the corpus are ignored as noise. Leave empty to list recent.',
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
        description: 'Archive an entity (soft-delete) or remove a specific observation. Archived entities are hidden from recall but preserved in the database. To remove just one observation, pass the observation parameter.',
        inputSchema: {
            type: 'object',
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
            type: 'object',
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
            type: 'object',
            properties: {
                data: { type: 'object', description: 'Export JSON data (from the export tool)' },
                namespace: { type: 'string', description: 'Override namespace for all imported entities' },
                merge_strategy: {
                    type: 'string',
                    enum: ['skip', 'overwrite', 'append'],
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
            type: 'object',
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
        description: 'Read or update where the work stands on this project: the goal, what is next, what is blocked, what was just finished. Call with no arguments to read it. Injected at the start of the next session, so record ONLY what the user actually stated — never infer a goal or a next step from files edited or commands run, and leave a field out if it was not said. Pass an empty string to clear a field (e.g. blocked: "" once a blocker is resolved).',
        inputSchema: {
            type: 'object',
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
        description: 'The work topology for a project, assembled and ready to use: where the work was left off (goal / next / blocked / done), decisions and direction, lessons not to repeat, what is known, and recent activity — the same block Claude Code receives at session start. Call once at the START of a session to load project context; use recall for specific questions after that. Content is wrapped as untrusted background data.',
        inputSchema: {
            type: 'object',
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
        description: 'Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use at session start for context about the user.',
        inputSchema: {
            type: 'object',
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
];
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function fail(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}
function stripNullProps(value) {
    if (Array.isArray(value))
        return value.map(stripNullProps);
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (v !== null)
                out[k] = stripNullProps(v);
        }
        return out;
    }
    return value;
}
function parseOrFail(schema, args) {
    const raw = args ?? {};
    const strictPass = schema.safeParse(raw);
    if (!strictPass.success && strictPass.error instanceof z.ZodError) {
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
        const message = parsed.error instanceof z.ZodError
            ? parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : String(parsed.error);
        return { ok: false, result: fail(message) };
    }
    return { ok: true, data: parsed.data };
}
export function normalizeClientHost(name) {
    return (name ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 64) || 'mcp';
}
export async function handleTool(name, args, sourceHost) {
    try {
        if (name === 'remember') {
            const r = parseOrFail(RememberSchema, args);
            if (!r.ok)
                return r.result;
            return ok(remember({ ...r.data, sourceHost }));
        }
        if (name === 'recall') {
            const r = parseOrFail(RecallSchema, args);
            if (!r.ok)
                return r.result;
            const { entities, conflicts, retrieval } = await recallWithConflicts(r.data);
            return ok(conflicts.length > 0 ? { entities, retrieval, conflicts } : { entities, retrieval });
        }
        if (name === 'forget') {
            const r = parseOrFail(ForgetSchema, args);
            if (!r.ok)
                return r.result;
            return ok(forget(r.data));
        }
        if (name === 'export') {
            const r = parseOrFail(ExportSchema, args);
            if (!r.ok)
                return r.result;
            return ok(exportMemories(r.data));
        }
        if (name === 'import') {
            const r = parseOrFail(ImportSchema, args);
            if (!r.ok)
                return r.result;
            return ok(importMemories(r.data));
        }
        if (name === 'learn') {
            const r = parseOrFail(LearnSchema, args);
            if (!r.ok)
                return r.result;
            return ok(learn({ ...r.data, sourceHost }));
        }
        if (name === 'task_state') {
            const r = parseOrFail(TaskStateSchema, args);
            if (!r.ok)
                return r.result;
            const { project, ...patch } = r.data;
            if (Object.keys(patch).length === 0)
                return ok(getTaskState(project));
            return ok(setTaskState({ project, patch, sourceHost }));
        }
        if (name === 'briefing') {
            const r = parseOrFail(BriefingSchema, args);
            if (!r.ok)
                return r.result;
            return ok(assembleBriefing(r.data.project));
        }
        if (name === 'user_patterns') {
            const r = parseOrFail(UserPatternsSchema, args);
            if (!r.ok)
                return r.result;
            const db = getDatabase();
            const cats = r.data.categories;
            const allCategories = !cats || cats.length === 0;
            const data = computePatterns(db, cats);
            const lines = ['## User Patterns'];
            if (allCategories || cats.includes('workSchedule')) {
                lines.push('', '### Work Schedule');
                const peakHours = [...data.workSchedule.hourDistribution]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 3)
                    .map(h => `${String(h.hour).padStart(2, '0')}:00 (${h.count})`)
                    .join(', ');
                lines.push(`Peak hours: ${peakHours || 'No data'}`);
                const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const busiestDays = [...data.workSchedule.dayDistribution]
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 3)
                    .map(d => `${DAY_NAMES[d.dayNum] ?? d.dayNum} (${d.count})`)
                    .join(', ');
                lines.push(`Busiest days: ${busiestDays || 'No data'}`);
            }
            if (allCategories || cats.includes('focusAreas')) {
                lines.push('', '### Focus Areas');
                if (data.focusAreas.length > 0) {
                    data.focusAreas.forEach(f => {
                        lines.push(`- ${f.type} (${f.count})`);
                    });
                }
                else {
                    lines.push('No focus area data yet.');
                }
            }
            if (allCategories || cats.includes('workflow')) {
                lines.push('', '### Workflow');
                lines.push(`Commits per session: ${data.workflow.commitsPerSession}`);
                lines.push(`Total sessions: ${data.workflow.totalSessions} | Total commits: ${data.workflow.totalCommits}`);
            }
            if (allCategories || cats.includes('strengths')) {
                lines.push('', '### Strengths (high confidence areas)');
                if (data.strengths.length > 0) {
                    lines.push('- ' + data.strengths.map(s => `${s.type} (${s.avgConfidence})`).join(', '));
                }
                else {
                    lines.push('No strength data yet.');
                }
            }
            if (allCategories || cats.includes('learningAreas')) {
                lines.push('', '### Learning Areas');
                if (data.learningAreas.length > 0) {
                    lines.push('- ' + data.learningAreas.map(l => l.tag).join(', '));
                }
                else {
                    lines.push('No learning area data yet.');
                }
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        return fail(`Unknown tool: ${name}`);
    }
    catch (err) {
        return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=handlers.js.map