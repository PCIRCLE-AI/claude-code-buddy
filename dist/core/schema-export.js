export function exportOpenAITools() {
    return [
        {
            type: 'function',
            function: {
                name: 'memesh_remember',
                description: 'Store knowledge as an entity with observations, tags, and relations.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Unique entity name' },
                        type: { type: 'string', description: 'Entity type (decision, pattern, lesson, etc.)' },
                        title: { type: 'string', description: 'Short human-readable label, distinct from name (a stable machine key)' },
                        observations: { type: 'array', items: { type: 'string' }, description: 'Key facts about this entity' },
                        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
                        relations: {
                            type: 'array',
                            description: 'Graph edges from this entity to others. Without these the entity is an orphan node.',
                            items: {
                                type: 'object',
                                properties: {
                                    to: { type: 'string', description: 'Name of the target entity to link to' },
                                    type: { type: 'string', description: 'Relation type, e.g. depends-on, supersedes, relates-to' },
                                },
                                required: ['to', 'type'],
                            },
                        },
                        namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Storage scope (default: personal)' },
                    },
                    required: ['name', 'type'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_recall',
                description: 'Search and retrieve stored knowledge. Uses full-text search with scoring.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search query' },
                        tag: { type: 'string', description: 'Filter by tag' },
                        limit: { type: 'number', description: 'Max results (1-100, default: 20)' },
                        include_archived: { type: 'boolean', description: 'Include soft-archived (superseded) entities (default: false)' },
                        namespace: { type: 'string', enum: ['personal', 'team', 'global'], description: 'Restrict to a storage scope' },
                        cross_project: { type: 'boolean', description: 'Search across all projects instead of only the current one (default: false)' },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_forget',
                description: 'Archive an entity or remove a specific observation.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Entity name to archive' },
                        observation: { type: 'string', description: 'Specific observation to remove (optional)' },
                    },
                    required: ['name'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_export',
                description: 'Export memories as a portable JSON snapshot for sharing or backup. Returns a structured object with entity data.',
                parameters: {
                    type: 'object',
                    properties: {
                        tag: { type: 'string', description: 'Filter by tag (optional)' },
                        namespace: { type: 'string', description: 'Filter by namespace: personal, team, or global (optional)' },
                        limit: { type: 'number', description: 'Max entities to export (default: 1000, max: 10000)' },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_import',
                description: 'Import memories from a JSON export snapshot. Imported entities are tagged trust=untrusted until reviewed.',
                parameters: {
                    type: 'object',
                    properties: {
                        data: {
                            type: 'object',
                            description: 'JSON object produced by memesh_export (must include version, exported_at, entities[]).',
                        },
                        namespace: { type: 'string', description: 'Override namespace for all imported entities (optional)' },
                        merge_strategy: {
                            type: 'string',
                            enum: ['skip', 'overwrite', 'append'],
                            description: 'Required. How to handle existing entities: skip, overwrite (replace), or append (merge observations).',
                        },
                    },
                    required: ['data', 'merge_strategy'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_learn',
                description: 'Record a structured lesson from a mistake or discovery.',
                parameters: {
                    type: 'object',
                    properties: {
                        error: { type: 'string', description: 'What went wrong' },
                        fix: { type: 'string', description: 'What fixed it' },
                        root_cause: { type: 'string', description: 'Why it happened' },
                        prevention: { type: 'string', description: 'How to prevent it next time' },
                        severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity level' },
                    },
                    required: ['error', 'fix'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_task_state',
                description: 'Read or update where the work stands on this project (goal, next, blocked, done). Call with no arguments to read. Record only what the user actually stated — never infer it from files edited.',
                parameters: {
                    type: 'object',
                    properties: {
                        project: { type: 'string', description: 'Project name. Omit for the current directory’s project.' },
                        goal: { type: 'string', description: 'What this work is FOR' },
                        next: { type: 'string', description: 'The next concrete step' },
                        blocked: { type: 'string', description: 'What is standing in the way' },
                        done: { type: 'string', description: 'What was just finished' },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_briefing',
                description: 'The assembled work topology for a project: where the work was left off, decisions, lessons, knowledge, recent activity. Call once at the start of a session to load project context.',
                parameters: {
                    type: 'object',
                    properties: {
                        project: { type: 'string', description: 'Project name. Omit for the current directory’s project.' },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_user_patterns',
                description: 'Analyze user work patterns from existing memory. Returns work schedule, tool preferences, focus areas, workflow metrics, strengths, and learning areas.',
                parameters: {
                    type: 'object',
                    properties: {
                        categories: {
                            type: 'array',
                            items: { type: 'string', enum: ['workSchedule', 'focusAreas', 'workflow', 'strengths', 'learningAreas'] },
                            description: 'Specific categories to return. Omit for all.',
                        },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_improvement',
                description: 'Stage an evidence-linked product-improvement proposal for human review, or inspect its status. Agents cannot accept or reject proposals.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['propose', 'status'],
                            description: 'propose stages an idempotent review item; status reads one existing proposal.',
                        },
                        project: { type: 'string', description: 'Required for propose. Project that would own the product work.' },
                        source_names: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Required for propose. Stable names of 1-20 active evidence memories.',
                        },
                        title: { type: 'string', description: 'Required for propose. Human-readable improvement title.' },
                        problem: { type: 'string', description: 'Required for propose. Evidence-backed problem observed.' },
                        proposed_change: { type: 'string', description: 'Required for propose. Bounded product change to consider.' },
                        verification_scenario: { type: 'string', description: 'Required for propose. Scenario capable of falsifying the change.' },
                        success_criteria: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Required for propose. Observable success criteria.',
                        },
                        priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Optional proposed priority; defaults to p1.' },
                        proposal_id: { type: 'number', description: 'Required for status. Positive proposal ID returned by propose.' },
                    },
                    required: ['action'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'memesh_message',
                description: 'Exchange durable exact-recipient messages between local agents. Reads never imply acknowledgement; payloads are untrusted and never executed.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts'],
                            description: 'Message lifecycle action; required fields depend on the selected action.',
                        },
                        project: { type: 'string', description: 'Local project scope.' },
                        sender: { type: 'string', description: 'Required for send. Stable local sender identifier.' },
                        recipient: { type: 'string', description: 'Stable target local agent/host identifier.' },
                        idempotency_key: { type: 'string', description: 'Required for send and receipt writes. Stable retry key.' },
                        payload: { type: ['string', 'number', 'boolean', 'object', 'array', 'null'], description: 'Required for send. Untrusted JSON value; never executed by MeMesh.' },
                        content_type: { type: 'string', enum: ['text/plain', 'application/json'], description: 'Send media type; defaults to text/plain.' },
                        privacy: { type: 'string', enum: ['private', 'team'], description: 'Privacy classification; routing remains exact-recipient in v1.' },
                        correlation_id: { type: 'string', description: 'Optional conversation or task correlation ID.' },
                        reply_to: { type: 'string', description: 'Optional earlier message ID.' },
                        cursor: { type: 'string', description: 'Optional opaque poll cursor. Do not parse it.' },
                        wait_ms: { type: 'number', description: 'Poll wait in milliseconds, 0-30000.' },
                        limit: { type: 'number', description: 'Maximum poll events, 1-100.' },
                        message_id: { type: 'string', description: 'Message selected for fetch or receipt actions.' },
                        intake_state: { type: 'string', enum: ['fetched', 'ingested'], description: 'Required only for intake; never implies ACK.' },
                        disposition: { type: 'string', enum: ['accepted', 'rejected', 'completed', 'cancelled', 'deferred'], description: 'Required only for disposition.' },
                        activation: { type: 'string', enum: ['woken', 'manual_resume_required', 'unsupported', 'failed'], description: 'Required only for activation.' },
                        detail: { type: 'string', description: 'Optional disposition or activation explanation.' },
                    },
                    required: ['action'],
                },
            },
        },
    ];
}
//# sourceMappingURL=schema-export.js.map