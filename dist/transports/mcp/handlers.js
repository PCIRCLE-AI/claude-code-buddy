import { z } from 'zod';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { getDatabase } from '../../db.js';
import { computePatterns } from '../../core/patterns.js';
import { assembleBriefing } from '../../core/briefing.js';
import { getTaskState, setTaskState } from '../../core/task-state-store.js';
import { getProductImprovementStatus, stageProductImprovement, } from '../../core/product-improvements.js';
import { executeAgentMessageAction } from '../agent-messaging.js';
import { RememberSchema, RecallSchema, ForgetSchema, BriefingSchema, ExportSchema, ImportSchema, LearnSchema, TaskStateSchema, UserPatternsSchema, ImprovementSchema, MessageSchema, } from '../schemas.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES, AGENT_NATIVE_MESSAGE_MAX_BYTES } from '../../core/agent-messaging.js';
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
                namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Export only from this namespace' },
                limit: { type: 'number', description: 'Max entities to export (default: 1000). The default is a SUBSET, not a backup — check `truncated` in the response, and for a full backup pass a limit above the graph size.' },
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
                namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Override namespace for all imported entities' },
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
                recipient: {
                    type: 'string',
                    description: 'Exact logical recipient. Required to surface actionable unread messages; omit for generic context.',
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
    {
        name: 'improvement',
        description: 'Turn active memories or lessons into a governed product-improvement proposal, or inspect a proposal status. Agents may only propose and read status; a human must inspect and accept/reject through `memesh dream show|accept|reject` or the dashboard. Acceptance means approved for product work, not implemented or effective.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['propose', 'status'],
                    description: 'propose stages an idempotent human-review item; status reads one existing proposal.',
                },
                project: {
                    type: 'string',
                    description: 'Required for propose. Project whose product work should receive the improvement.',
                },
                source_names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Required for propose. Stable names of 1-20 active memories that provide evidence.',
                },
                title: { type: 'string', description: 'Required for propose. Human-readable improvement title.' },
                problem: { type: 'string', description: 'Required for propose. Evidence-backed problem observed.' },
                proposed_change: { type: 'string', description: 'Required for propose. Bounded product change to consider.' },
                verification_scenario: { type: 'string', description: 'Required for propose. A scenario capable of falsifying the change.' },
                success_criteria: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Required for propose. One or more observable success criteria.',
                },
                priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Optional proposed priority; defaults to p1.' },
                proposal_id: { type: 'number', description: 'Required for status. Positive proposal ID returned by propose.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'message',
        description: `Use this to contact or discover another local agent on the same MeMesh instance. discover is a bounded, project-scoped live-directory read of active leases and returns only the router result; it performs no send, fetch, ACK, replay, or receipt work. send durably stores one untrusted JSON-encoded payload of at most ${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB) idempotently. Native delivery has a separate ${AGENT_NATIVE_MESSAGE_MAX_BYTES}-byte (16 KiB) cap for the complete envelope, including routing metadata and payload. For target_kind=session, success requires the exact active native host to accept that full envelope. An oversized envelope returns native_message_too_large; other unavailable or rejected sessions return recipient_unavailable while preserving scoped recovery data. Principal targets retain durable store-and-forward behavior even when native delivery is unavailable. poll/fetch remain compatibility and recovery reads; intake, ack, disposition, and activation are separate explicit facts. Native acceptance, polling, fetching, and discovery never imply agent acknowledgement or workflow completion.`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts'],
                    description: 'Message lifecycle or live-directory action. Each action validates only its documented fields and rejects unknown fields.',
                },
                project: { type: 'string', description: 'Local project scope shared by sender and recipient.' },
                sender: { type: 'string', description: 'Required for send. Stable local sender/agent identifier.' },
                recipient: { type: 'string', description: 'Required for every action except discover. Stable target local agent/host identifier.' },
                target_kind: {
                    type: 'string',
                    enum: ['principal', 'session'],
                    description: 'Recipient identity kind for send and fetch. Defaults to principal; exact-session delivery and fetch require session.',
                },
                idempotency_key: { type: 'string', description: 'Required for send and receipt writes. Stable retry key.' },
                payload: {
                    type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
                    description: `Required for send. Untrusted JSON value, limited to ${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes (64 KiB) after JSON encoding. Native push additionally requires the complete envelope to fit ${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB). MeMesh never executes the payload.`,
                },
                content_type: { type: 'string', enum: ['text/plain', 'application/json'], description: 'Send payload media type. Defaults to text/plain.' },
                privacy: { type: 'string', enum: ['private', 'team'], description: 'Send privacy classification. Routing remains exact-recipient in v1.' },
                correlation_id: { type: 'string', description: 'Optional caller-stable conversation or task correlation ID.' },
                reply_to: { type: 'string', description: 'Optional earlier message ID this message replies to.' },
                cursor: { type: 'string', description: 'Optional opaque cursor returned by poll. Clients must not parse it.' },
                wait_ms: { type: 'number', description: 'Poll wait in milliseconds, 0-30000. Defaults to 0.' },
                limit: { type: 'number', description: 'Maximum poll or discovery rows, 1-100. Defaults to 20 for poll and 50 for discover.' },
                message_id: { type: 'string', description: 'Required for fetch, receipt writes, and receipt readback.' },
                intake_state: { type: 'string', enum: ['fetched', 'ingested'], description: 'Required only for intake. Neither value implies ACK.' },
                disposition: { type: 'string', enum: ['accepted', 'rejected', 'completed', 'cancelled', 'deferred'], description: 'Required only for disposition.' },
                activation: { type: 'string', enum: ['woken', 'manual_resume_required', 'unsupported', 'failed'], description: 'Required only for activation; manual_resume_required never implies ACK or workflow disposition.' },
                detail: { type: 'string', description: 'Optional bounded explanation for disposition or activation.' },
            },
            required: ['action'],
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
function formatIssue(issue) {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
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
    const raw = args === undefined || args === null ? {} : args;
    const strictPass = schema.safeParse(raw);
    if (!strictPass.success) {
        const unknownKeys = strictPass.error.issues.filter((i) => i.code === 'unrecognized_keys');
        if (unknownKeys.length > 0) {
            return {
                ok: false,
                result: fail(unknownKeys.map(formatIssue).join('; ')),
            };
        }
    }
    const parsed = schema.safeParse(stripNullProps(raw));
    if (!parsed.success) {
        const message = parsed.error instanceof z.ZodError
            ? parsed.error.issues.map(formatIssue).join('; ')
            : String(parsed.error);
        return { ok: false, result: fail(message) };
    }
    return { ok: true, data: parsed.data };
}
export function normalizeClientHost(name) {
    return (name ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 64) || 'mcp';
}
export async function handleTool(name, args, sourceHost, signal) {
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
            const result = forget(r.data);
            if (result.archived === false) {
                return fail(result.message ?? `Entity "${r.data.name}" not found`);
            }
            if (result.observation_removed === false) {
                return fail(result.entity_found
                    ? `Entity "${r.data.name}" has no observation matching that text (${result.remaining_observations} observation(s) present).`
                    : `Entity "${r.data.name}" not found`);
            }
            return ok(result);
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
            return ok(assembleBriefing(r.data.project, r.data.recipient));
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
        if (name === 'improvement') {
            const r = parseOrFail(ImprovementSchema, args);
            if (!r.ok)
                return r.result;
            if (r.data.action === 'status') {
                return ok(getProductImprovementStatus(getDatabase(), r.data.proposal_id));
            }
            return ok(stageProductImprovement(getDatabase(), {
                project: r.data.project,
                source_names: r.data.source_names,
                title: r.data.title,
                problem: r.data.problem,
                proposed_change: r.data.proposed_change,
                verification_scenario: r.data.verification_scenario,
                success_criteria: r.data.success_criteria,
                priority: r.data.priority,
                sourceHost,
            }));
        }
        if (name === 'message') {
            const r = parseOrFail(MessageSchema, args);
            if (!r.ok)
                return r.result;
            return ok(await executeAgentMessageAction(getDatabase(), r.data, {
                transport: 'mcp',
                sourceHost: normalizeClientHost(sourceHost),
                signal,
            }));
        }
        return fail(`Unknown tool: ${name}`);
    }
    catch (err) {
        return fail(`Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=handlers.js.map