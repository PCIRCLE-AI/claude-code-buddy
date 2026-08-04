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
                readonly description: "Namespace for organizing the entity (default: \"personal\")";
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
                readonly description: "Export only from this namespace (personal, team, global)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Max entities to export (default: 1000)";
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
                readonly description: "Override namespace for all imported entities";
            };
            readonly merge_strategy: {
                readonly type: "string";
                readonly enum: readonly ["skip", "overwrite", "append"];
                readonly description: "How to handle existing entities: skip (default) = leave untouched, append = add observations, overwrite = archive existing and recreate";
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
    readonly name: "user_patterns";
    readonly description: "Analyze user work patterns from existing memory. Returns: work schedule (peak hours/days), tool preferences, focus areas, workflow metrics (session duration, commits/session), knowledge strengths, and learning areas. Use at session start for context about the user.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly categories: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly enum: readonly ["workSchedule", "toolPreferences", "focusAreas", "workflow", "strengths", "learningAreas"];
                };
                readonly description: "Specific categories to return. Omit for all.";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly name: "verify_agent_work";
    readonly description: "Record a verification report for work done by a background agent. Runs a deterministic git reality-check on the workdir (files changed vs claim) and persists the result as a verification_record entity. Returns verdict: \"pass\" | \"fail\" | \"unverified\". IMPORTANT: calling this with neither `claim` nor `report` checks nothing and returns \"unverified\" — it counts changed files, which is not a verification. To get a \"pass\" you must give it something to check: `claim.expected_files`, a `report`, or both. Heavier checks (typecheck/tests/lint) are expected to be pre-computed by a local hook and passed in via report.*.pass — this tool focuses on persistence + cross-checking, not running test suites.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly agent_id: {
                readonly type: "string";
                readonly description: "Identifier for the agent whose work is being verified.";
            };
            readonly workdir: {
                readonly type: "string";
                readonly description: "Absolute path to the git working tree the agent edited.";
            };
            readonly base: {
                readonly type: "string";
                readonly description: "Git ref/sha to diff against. Defaults to merge-base with origin/main.";
            };
            readonly claim: {
                readonly type: "object";
                readonly properties: {
                    readonly expected_files: {
                        readonly type: "number";
                        readonly description: "How MANY files the agent claimed to change — a count, not a list. Only committed changes are counted.";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly report: {
                readonly type: "object";
                readonly description: "Pre-computed external verification report (typecheck/tests/lint/build).";
                readonly properties: {
                    readonly pass: {
                        readonly type: "boolean";
                    };
                    readonly typecheck: {
                        readonly type: "object";
                        readonly properties: {
                            readonly pass: {
                                readonly type: "boolean";
                            };
                            readonly summary: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["pass"];
                    };
                    readonly tests: {
                        readonly type: "object";
                        readonly properties: {
                            readonly pass: {
                                readonly type: "boolean";
                            };
                            readonly summary: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["pass"];
                    };
                    readonly lint: {
                        readonly type: "object";
                        readonly properties: {
                            readonly pass: {
                                readonly type: "boolean";
                            };
                            readonly summary: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["pass"];
                    };
                    readonly build: {
                        readonly type: "object";
                        readonly properties: {
                            readonly pass: {
                                readonly type: "boolean";
                            };
                            readonly summary: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["pass"];
                    };
                    readonly summary: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly ["pass"];
            };
        };
        readonly required: readonly ["agent_id", "workdir"];
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
export declare function handleTool(name: string, args: Record<string, unknown> | undefined): Promise<ToolResult>;
export {};
//# sourceMappingURL=handlers.d.ts.map