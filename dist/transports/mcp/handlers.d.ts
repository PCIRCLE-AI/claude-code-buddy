export declare const TOOL_DEFINITIONS: readonly [{
    readonly name: "remember";
    readonly description: "Store knowledge as an entity with observations, tags, and relations. Use this to remember decisions, patterns, lessons learned, and important context.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Unique entity name (e.g., \"auth-decision\", \"jwt-pattern\"). Reusing a name appends observations and dedupes tags instead of replacing the entity.";
            };
            readonly type: {
                readonly type: "string";
                readonly description: "Entity type (e.g., \"decision\", \"pattern\", \"lesson\", \"commit\")";
            };
            readonly title: {
                readonly type: "string";
                readonly description: "Short human-readable label for this memory (e.g. \"Use PKCE over implicit flow for auth\"), distinct from name (which stays a stable machine key). Shown as the headline in the dashboard and in memory recalled by an agent, instead of the raw name. Reusing an existing name with a different title UPDATES the title; omit to leave an existing title untouched.";
            };
            readonly observations: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Key facts or observations about this entity";
            };
            readonly tags: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Tags for filtering (e.g., \"project:myapp\", \"type:decision\")";
            };
            readonly relations: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly to: {
                            readonly type: "string";
                            readonly description: "Target entity name";
                        };
                        readonly type: {
                            readonly type: "string";
                            readonly description: string;
                        };
                    };
                    readonly required: readonly ["to", "type"];
                    readonly additionalProperties: false;
                };
                readonly description: "Relations to other entities";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Namespace for organizing the entity. Omit it to leave an existing memory where it is — supplying it MOVES a memory that already exists, and it drops out of every other scoped view. New memories default to \"personal\".";
            };
        };
        readonly required: readonly ["name", "type"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "recall";
    readonly description: "Search and retrieve stored knowledge. Uses full-text search with optional project tag filtering. Call with no query to list recent memories. Query words are OR-ed and results ranked by relevance, so a question phrased naturally works — adding words narrows the ranking, not the result set.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly query: {
                readonly type: "string";
                readonly description: "Search query. Words are OR-ed and ranked by relevance (BM25); only the first 32 terms are used, and words present in most of the corpus are ignored as noise. Leave empty to list recent.";
            };
            readonly tag: {
                readonly type: "string";
                readonly description: "Filter by tag (e.g., \"project:myapp\")";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max results (default: 20, max: 100)";
            };
            readonly include_archived: {
                readonly type: "boolean";
                readonly description: "Include archived (forgotten) entities in results. Default: false.";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Filter results by namespace. Omit to search all namespaces.";
            };
            readonly cross_project: {
                readonly type: "boolean";
                readonly description: "Search across all project tags (ignores tag filter). Default: false.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "forget";
    readonly description: "Archive an entity (soft-delete) or remove a specific observation. Archived entities are hidden from recall but preserved in the database. To remove just one observation, pass the observation parameter.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
                readonly description: "Entity name to archive or modify";
            };
            readonly observation: {
                readonly type: "string";
                readonly description: "If provided, only this specific observation is removed (entity stays active). If omitted, the entire entity is archived.";
            };
        };
        readonly required: readonly ["name"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "export";
    readonly description: "Export memories as JSON for sharing or backup. Returns a portable snapshot of entities and their observations, tags, and relations.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly tag: {
                readonly type: "string";
                readonly description: "Export only entities with this tag";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Export only from this namespace";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max entities to export (default: 1000). The default is a SUBSET, not a backup — check `truncated` in the response, and for a full backup pass a limit above the graph size.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "import";
    readonly description: "Import memories from a JSON export snapshot. Supports skip, append, or overwrite strategies for handling existing entities.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly data: {
                readonly type: "object";
                readonly description: "Export JSON data (from the export tool)";
            };
            readonly namespace: {
                readonly type: "string";
                readonly enum: readonly ["personal", "team", "global"];
                readonly description: "Override namespace for all imported entities";
            };
            readonly merge_strategy: {
                readonly type: "string";
                readonly enum: readonly ["skip", "overwrite", "append"];
                readonly description: "Required. How to handle an entity that already exists: skip = leave it untouched, append = add these observations to it, overwrite = REPLACE its observations and tags (the old ones are deleted, not archived — this cannot be undone)";
            };
        };
        readonly required: readonly ["data", "merge_strategy"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "learn";
    readonly description: "Record a structured lesson from a mistake or discovery. Creates a lesson_learned entity with error, root cause, fix, and prevention.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly error: {
                readonly type: "string";
                readonly description: "What went wrong";
            };
            readonly fix: {
                readonly type: "string";
                readonly description: "What fixed it";
            };
            readonly root_cause: {
                readonly type: "string";
                readonly description: "Why it happened (optional)";
            };
            readonly prevention: {
                readonly type: "string";
                readonly description: "How to prevent it next time (optional)";
            };
            readonly severity: {
                readonly type: "string";
                readonly enum: readonly ["critical", "major", "minor"];
                readonly description: "Severity level (default: minor)";
            };
        };
        readonly required: readonly ["error", "fix"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "task_state";
    readonly description: "Read or update where the work stands on this project: the goal, what is next, what is blocked, what was just finished. Call with no arguments to read it. Injected at the start of the next session, so record ONLY what the user actually stated — never infer a goal or a next step from files edited or commands run, and leave a field out if it was not said. Pass an empty string to clear a field (e.g. blocked: \"\" once a blocker is resolved).";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly project: {
                readonly type: "string";
                readonly description: "Project name. Omit to use the current working directory’s project.";
            };
            readonly goal: {
                readonly type: "string";
                readonly description: "What this work is FOR — the outcome being aimed at";
            };
            readonly next: {
                readonly type: "string";
                readonly description: "The next concrete step";
            };
            readonly blocked: {
                readonly type: "string";
                readonly description: "What is standing in the way, if anything";
            };
            readonly done: {
                readonly type: "string";
                readonly description: "What was just finished";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "briefing";
    readonly description: "The work topology for a project, assembled and ready to use: where the work was left off (goal / next / blocked / done), decisions and direction, lessons not to repeat, what is known, and recent activity — the same block Claude Code receives at session start. Call once at the START of a session to load project context; use recall for specific questions after that. Content is wrapped as untrusted background data.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly project: {
                readonly type: "string";
                readonly description: "Project name. Omit to use the current working directory’s project.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "user_patterns";
    readonly description: "Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use at session start for context about the user.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly categories: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly enum: readonly ["workSchedule", "focusAreas", "workflow", "strengths", "learningAreas"];
                };
                readonly description: "Specific categories to return. Omit for all.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "improvement";
    readonly description: "Turn active memories or lessons into a governed product-improvement proposal, or inspect a proposal status. Agents may only propose and read status; a human must inspect and accept/reject through `memesh dream show|accept|reject` or the dashboard. Acceptance means approved for product work, not implemented or effective.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["propose", "status"];
                readonly description: "propose stages an idempotent human-review item; status reads one existing proposal.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Required for propose. Project whose product work should receive the improvement.";
            };
            readonly source_names: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Required for propose. Stable names of 1-20 active memories that provide evidence.";
            };
            readonly title: {
                readonly type: "string";
                readonly description: "Required for propose. Human-readable improvement title.";
            };
            readonly problem: {
                readonly type: "string";
                readonly description: "Required for propose. Evidence-backed problem observed.";
            };
            readonly proposed_change: {
                readonly type: "string";
                readonly description: "Required for propose. Bounded product change to consider.";
            };
            readonly verification_scenario: {
                readonly type: "string";
                readonly description: "Required for propose. A scenario capable of falsifying the change.";
            };
            readonly success_criteria: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Required for propose. One or more observable success criteria.";
            };
            readonly priority: {
                readonly type: "string";
                readonly enum: readonly ["p0", "p1", "p2", "p3"];
                readonly description: "Optional proposed priority; defaults to p1.";
            };
            readonly proposal_id: {
                readonly type: "number";
                readonly description: "Required for status. Positive proposal ID returned by propose.";
            };
        };
        readonly required: readonly ["action"];
        readonly additionalProperties: false;
    };
}, {
    readonly name: "message";
    readonly description: "Use this to contact another local agent — hand off work, ask for a result, report a disposition — and send here FIRST: the durable inbox is the record, host push is only the delivery. Exchange durable local agent messages on one MeMesh instance. send creates one message/delivery/wakeup event idempotently; poll waits or catches up with an opaque cursor; fetch reads the payload; intake, ack, disposition, and activation record separate explicit facts. Polling or fetching never acknowledges a message, and no action executes payload content.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["send", "poll", "fetch", "intake", "ack", "disposition", "activation", "receipts"];
                readonly description: "Lifecycle action. Each action validates only its documented fields and rejects unknown fields.";
            };
            readonly project: {
                readonly type: "string";
                readonly description: "Local project scope shared by sender and recipient.";
            };
            readonly sender: {
                readonly type: "string";
                readonly description: "Required for send. Stable local sender/agent identifier.";
            };
            readonly recipient: {
                readonly type: "string";
                readonly description: "Stable target local agent/host identifier.";
            };
            readonly target_kind: {
                readonly type: "string";
                readonly enum: readonly ["principal", "session"];
                readonly description: "Recipient identity kind for send and fetch. Defaults to principal; exact-session delivery and fetch require session.";
            };
            readonly idempotency_key: {
                readonly type: "string";
                readonly description: "Required for send and receipt writes. Stable retry key.";
            };
            readonly payload: {
                readonly type: readonly ["string", "number", "boolean", "object", "array", "null"];
                readonly description: "Required for send. JSON value treated as untrusted data and never executed by MeMesh.";
            };
            readonly content_type: {
                readonly type: "string";
                readonly enum: readonly ["text/plain", "application/json"];
                readonly description: "Send payload media type. Defaults to text/plain.";
            };
            readonly privacy: {
                readonly type: "string";
                readonly enum: readonly ["private", "team"];
                readonly description: "Send privacy classification. Routing remains exact-recipient in v1.";
            };
            readonly correlation_id: {
                readonly type: "string";
                readonly description: "Optional caller-stable conversation or task correlation ID.";
            };
            readonly reply_to: {
                readonly type: "string";
                readonly description: "Optional earlier message ID this message replies to.";
            };
            readonly cursor: {
                readonly type: "string";
                readonly description: "Optional opaque cursor returned by poll. Clients must not parse it.";
            };
            readonly wait_ms: {
                readonly type: "number";
                readonly description: "Poll wait in milliseconds, 0-30000. Defaults to 0.";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum poll events, 1-100. Defaults to 20.";
            };
            readonly message_id: {
                readonly type: "string";
                readonly description: "Required for fetch, receipt writes, and receipt readback.";
            };
            readonly intake_state: {
                readonly type: "string";
                readonly enum: readonly ["fetched", "ingested"];
                readonly description: "Required only for intake. Neither value implies ACK.";
            };
            readonly disposition: {
                readonly type: "string";
                readonly enum: readonly ["accepted", "rejected", "completed", "cancelled", "deferred"];
                readonly description: "Required only for disposition.";
            };
            readonly activation: {
                readonly type: "string";
                readonly enum: readonly ["woken", "manual_resume_required", "unsupported", "failed"];
                readonly description: "Required only for activation; manual_resume_required never implies ACK or workflow disposition.";
            };
            readonly detail: {
                readonly type: "string";
                readonly description: "Optional bounded explanation for disposition or activation.";
            };
        };
        readonly required: readonly ["action"];
        readonly additionalProperties: false;
    };
}];
type ToolResult = {
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
};
export declare function normalizeClientHost(name: string | undefined): string;
export declare function handleTool(name: string, args: Record<string, unknown> | undefined, sourceHost?: string, signal?: AbortSignal): Promise<ToolResult>;
export {};
//# sourceMappingURL=handlers.d.ts.map