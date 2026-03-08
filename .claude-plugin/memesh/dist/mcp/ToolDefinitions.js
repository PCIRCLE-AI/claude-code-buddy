import { OutputSchemas } from './schemas/OutputSchemas.js';
export const CommonSchemas = {
    taskInput: {
        type: 'object',
        properties: {
            taskDescription: {
                type: 'string',
                description: 'Description of the task to be performed',
            },
            priority: {
                type: 'number',
                description: 'Task priority (optional, 1-10)',
                minimum: 1,
                maximum: 10,
            },
        },
        required: ['taskDescription'],
    },
    dashboardInput: {
        type: 'object',
        properties: {
            format: {
                type: 'string',
                description: 'Dashboard format: "summary" (default) or "detailed"',
                enum: ['summary', 'detailed'],
            },
        },
    },
};
export function getAllToolDefinitions() {
    const buddyDoTool = {
        name: 'buddy-do',
        description: `Smart task analysis with memory-enriched proposals.

Analyzes the task description, detects the task type (bug-fix, feature, refactor, test, etc.),
queries the knowledge graph for related context, and returns an enriched proposal for user review.

Follows "propose, don't execute" pattern — the enhanced prompt is returned for confirmation,
not auto-executed. User reviews the proposal and confirms or modifies before proceeding.

Examples:
- buddy-do "fix the auth bug" → detects bug-fix, recalls JWT context, suggests debugging approach
- buddy-do "add user dashboard" → detects feature, recalls related UI work, suggests planning approach
- buddy-do "refactor payment service" → detects refactor, recalls payment patterns, suggests review-first approach`,
        inputSchema: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: 'Task description to analyze and enrich (e.g., "setup authentication", "fix login bug")',
                },
            },
            required: ['task'],
        },
        outputSchema: OutputSchemas.buddyDo,
        annotations: {
            title: 'Smart Task Analyzer',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    };
    const buddyRememberTool = {
        name: 'buddy-remember',
        description: `Search project memory using semantic similarity or keyword matching.

PROJECT ISOLATION (Default):
By default, searches are isolated to the CURRENT PROJECT + GLOBAL memories only.
This prevents memory mixing across different projects.

Examples:
- buddy-remember "how do we handle authentication" -> finds JWT, OAuth, session memories in CURRENT project
- buddy-remember "database" mode=keyword -> exact keyword match in CURRENT project only
- buddy-remember "user login" mode=semantic matchThreshold=0.5 -> high-quality semantic matches in CURRENT project
- buddy-remember "API patterns" allProjects=true -> search across ALL projects (cross-project search)

The default 'hybrid' mode combines semantic understanding with keyword matching for best results.`,
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query (natural language supported for semantic search)',
                },
                mode: {
                    type: 'string',
                    enum: ['semantic', 'keyword', 'hybrid'],
                    description: 'Search mode: semantic (AI similarity), keyword (exact match), hybrid (both combined). Default: hybrid',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (1-50, default: 10)',
                    minimum: 1,
                    maximum: 50,
                },
                matchThreshold: {
                    type: 'number',
                    description: 'Minimum match score (0-1). Higher values return fewer but more relevant results. Default: 0.3',
                    minimum: 0,
                    maximum: 1,
                },
                allProjects: {
                    type: 'boolean',
                    description: 'Search across all projects (default: false, searches only current project + global memories)',
                },
            },
            required: ['query'],
        },
        outputSchema: OutputSchemas.buddyRemember,
        annotations: {
            title: 'Project Memory Recall',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    };
    const buddyHelpTool = {
        name: 'buddy-help',
        description: '📖 MeMesh: Get help for all buddy commands or a specific command.',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'Specific command to get help for (optional, e.g., "do", "remember")',
                },
            },
        },
        outputSchema: OutputSchemas.buddyHelp,
        annotations: {
            title: 'Help & Documentation',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    };
    const buddyRecordMistakeTool = {
        name: 'memesh-record-mistake',
        aliases: ['buddy-record-mistake'],
        description: `📝 MeMesh: Record AI mistakes for learning and prevention - enable systematic improvement from user feedback.

**When to Record:**
• User explicitly corrects behavior or approach
• Violated a documented procedure or guideline
• Made incorrect assumptions instead of asking
• Skipped validation step and caused problems
• User says "you should have..." or "why didn't you..."

**Mistake Record Structure:**
• **Action**: What was actually done (specific, concrete)
• **Error Type**: Category that best fits (see errorType enum)
• **User Correction**: What the user said was wrong (exact feedback)
• **Correct Method**: What should have been done instead (actionable, specific)
• **Impact**: How this affected the user (time wasted, bugs introduced, confusion)
• **Prevention Method**: Concrete steps to prevent this in future (not vague promises)

**Pattern Recognition:**
• Identify the underlying pattern of the mistake (not just the specific instance)
• Categorize the error type accurately (procedure-violation, assumption-error, etc.)
• Recognize if this mistake has happened before (check patterns)
• Extract the root cause, not just the symptom

**Error Type Classification:**
• **procedure-violation**: Skipped a documented workflow step
• **workflow-skip**: Didn't follow the correct sequence (e.g., tested before implementing)
• **assumption-error**: Made incorrect assumptions instead of asking
• **validation-skip**: Didn't verify something that should have been checked
• **responsibility-lack**: Failed to take ownership or be proactive
• **firefighting**: Rushed to fix without understanding root cause
• **dependency-miss**: Missed a dependency or integration point
• **integration-error**: Failed to integrate components correctly
• **deployment-error**: Deployment or configuration mistake

**Example:**
User: "Why did you edit the file without reading it first? Now the indentation is broken!"
Record:
  action: "Edited ServerInitializer.ts without reading file first"
  errorType: "procedure-violation"
  userCorrection: "Must read file before editing - broke indentation"
  correctMethod: "Use Read tool first to see exact content and formatting, then Edit"
  impact: "Broke file indentation, required re-edit, wasted user time"
  preventionMethod: "ALWAYS invoke Read tool before Edit tool - no exceptions"
  relatedRule: "READ_BEFORE_EDIT (Anti-Hallucination Protocol)"`,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    description: 'What action the AI took (the mistake)',
                },
                errorType: {
                    type: 'string',
                    description: 'Error classification',
                    enum: [
                        'procedure-violation',
                        'workflow-skip',
                        'assumption-error',
                        'validation-skip',
                        'responsibility-lack',
                        'firefighting',
                        'dependency-miss',
                        'integration-error',
                        'deployment-error',
                    ],
                },
                userCorrection: {
                    type: 'string',
                    description: 'User\'s correction/feedback',
                },
                correctMethod: {
                    type: 'string',
                    description: 'What should have been done instead',
                },
                impact: {
                    type: 'string',
                    description: 'Impact of the mistake',
                },
                preventionMethod: {
                    type: 'string',
                    description: 'How to prevent this in the future',
                },
                relatedRule: {
                    type: 'string',
                    description: 'Related rule/guideline (optional)',
                },
                context: {
                    type: 'object',
                    description: 'Additional context (optional)',
                },
            },
            required: ['action', 'errorType', 'userCorrection', 'correctMethod', 'impact', 'preventionMethod'],
        },
        outputSchema: OutputSchemas.buddyRecordMistake,
        annotations: {
            title: 'Mistake Recorder',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    };
    const hookToolUseTool = {
        name: 'memesh-hook-tool-use',
        aliases: ['hook-tool-use'],
        description: 'Process tool execution events from Claude Code CLI for workflow automation (auto-triggered, do not call manually)',
        inputSchema: {
            type: 'object',
            properties: {
                toolName: {
                    type: 'string',
                    description: 'Tool name executed by Claude Code (e.g., "Write", "Edit", "Bash")',
                },
                arguments: {
                    type: 'object',
                    description: 'Tool arguments payload (tool-specific)',
                },
                success: {
                    type: 'boolean',
                    description: 'Whether the tool execution succeeded',
                },
                duration: {
                    type: 'number',
                    description: 'Execution duration in milliseconds (optional)',
                },
                tokensUsed: {
                    type: 'number',
                    description: 'Tokens used by the tool call (optional)',
                },
                output: {
                    type: 'string',
                    description: 'Tool output (optional)',
                },
            },
            required: ['toolName', 'success'],
        },
        outputSchema: OutputSchemas.hookToolUse,
        annotations: {
            title: 'Hook Event Processor',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    };
    const createEntitiesTool = {
        name: 'memesh-create-entities',
        aliases: ['create-entities'],
        description: `✨ MeMesh: Create entities in Knowledge Graph - record decisions, features, bug fixes, and lessons learned.

**What to Record:**
• Technical decisions (e.g., "chose JWT over sessions for auth")
• Architectural patterns (e.g., "use repository pattern for data access")
• Bug fixes and root causes (e.g., "fixed race condition in login flow")
• Lessons learned (e.g., "always validate user input before DB queries")
• Code changes and rationale (e.g., "refactored UserService to improve testability")

**Entity Naming Guidelines:**
• Use imperative or declarative form (e.g., "Use Redis for session storage")
• Make names searchable and meaningful (avoid generic names like "Decision 1")
• Include key context (e.g., "API rate limiting implementation - Express middleware")

**Observation Structure:**
• Break down into atomic observations (one fact per observation)
• Include WHY (rationale), WHAT (implementation), and HOW (approach)
• Add context for future recall (date, related files, dependencies)

**Tag Guidelines (3-7 tags):**
• Technology: "tech:postgresql", "tech:nodejs", "tech:react"
• Domain: "domain:authentication", "domain:api", "domain:frontend"
• Pattern: "pattern:repository", "pattern:singleton", "pattern:observer"
• Use lowercase, hyphens for multi-word (e.g., "error-handling")
• MeMesh automatically adds scope tags (scope:project:xxx)

**Example:**
name: "JWT authentication implementation for API"
entityType: "feature"
observations: [
  "Implementation: Used jsonwebtoken library with RS256 algorithm",
  "Rationale: Stateless auth enables horizontal scaling",
  "Security: Tokens expire after 1 hour, refresh tokens after 7 days",
  "Files: src/auth/jwt.ts, src/middleware/authenticate.ts"
]
tags: ["tech:jwt", "tech:nodejs", "domain:authentication", "security"]`,
        inputSchema: {
            type: 'object',
            properties: {
                entities: {
                    type: 'array',
                    description: 'Array of entities to create',
                    items: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Entity name (unique identifier)',
                            },
                            entityType: {
                                type: 'string',
                                description: 'Entity type (e.g., "decision", "feature", "bug_fix", "lesson_learned")',
                            },
                            observations: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of observations (facts, notes, details)',
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Optional tags. Scope tags (scope:project:xxx) and tech tags (tech:xxx) will be automatically added.',
                            },
                            metadata: {
                                type: 'object',
                                description: 'Optional metadata',
                            },
                        },
                        required: ['name', 'entityType', 'observations'],
                    },
                },
            },
            required: ['entities'],
        },
        outputSchema: OutputSchemas.createEntities,
        annotations: {
            title: 'Knowledge Graph Creator',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    };
    const generateTestsTool = {
        name: 'memesh-generate-tests',
        aliases: ['generate-tests'],
        description: 'Automatically generate test cases from specifications or code using AI. Provide either specification or code (at least one required).',
        inputSchema: {
            type: 'object',
            properties: {
                specification: {
                    type: 'string',
                    description: 'Feature or function specification to generate tests for',
                },
                code: {
                    type: 'string',
                    description: 'Source code to generate tests for',
                },
            },
        },
        outputSchema: OutputSchemas.generateTests,
        annotations: {
            title: 'Test Generator',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
        },
    };
    const memeshMetricsTool = {
        name: 'memesh-metrics',
        description: `View MeMesh session metrics, routing configuration, and memory status.

Returns structured data about:
- Current session: modified files, tested files, code review status
- Routing: active model rules, planning enforcement, dry-run gate, recent audit log
- Memory: knowledge graph size and status

Use section parameter to focus on specific areas:
- "all" (default): Everything
- "session": Current session state only
- "routing": Routing config and audit log only
- "memory": Knowledge graph status only`,
        inputSchema: {
            type: 'object',
            properties: {
                section: {
                    type: 'string',
                    enum: ['all', 'session', 'routing', 'memory'],
                    description: 'Which metrics section to return (default: "all")',
                },
            },
        },
        outputSchema: OutputSchemas.memeshMetrics,
        annotations: {
            title: 'Session Metrics',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    };
    return [
        buddyDoTool,
        buddyRememberTool,
        buddyHelpTool,
        buddyRecordMistakeTool,
        createEntitiesTool,
        hookToolUseTool,
        generateTestsTool,
        memeshMetricsTool,
    ];
}
//# sourceMappingURL=ToolDefinitions.js.map