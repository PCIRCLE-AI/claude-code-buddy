/**
 * Export MeMesh tools in OpenAI function calling format.
 * This allows any OpenAI-compatible API to use MeMesh as a tool.
 *
 * CONTRACT: the `parameters` here MUST stay in lockstep with the Zod schemas
 * in src/transports/schemas.ts, which are the single source of truth every
 * transport validates against. A field present in the Zod schema but missing
 * here means an agent driven off this export can never send it — which is how
 * `relations` and `namespace` went missing from `remember`, leaving every
 * entity such an agent created an orphan with no graph edges. tests/core/
 * schema-export.test.ts pins this parity.
 */
export function exportOpenAITools(): object[] {
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
              description: 'How to handle existing entities: skip (default), overwrite (replace), or append (merge observations).',
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
        description:
          'Read or update where the work stands on this project (goal, next, blocked, done). Call with no arguments to read. Record only what the user actually stated — never infer it from files edited.',
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
        name: 'memesh_user_patterns',
        description: 'Analyze user work patterns from existing memory. Returns work schedule, tool preferences, focus areas, workflow metrics, strengths, and learning areas.',
        parameters: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: { type: 'string', enum: ['workSchedule', 'toolPreferences', 'focusAreas', 'workflow', 'strengths', 'learningAreas'] },
              description: 'Specific categories to return. Omit for all.',
            },
          },
        },
      },
    },
  ];
}
