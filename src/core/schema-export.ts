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
        name: 'memesh_consolidate',
        description: 'Compress verbose entity observations using LLM.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Entity to consolidate' },
            tag: { type: 'string', description: 'Consolidate all entities with this tag' },
            min_observations: { type: 'number', description: 'Min observations to trigger (default: 5)' },
          },
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
    {
      type: 'function',
      function: {
        name: 'memesh_verify_agent_work',
        description: 'Record a verification report for work done by a background agent. Runs git reality-check (files changed vs claim) and persists report as a verification_record entity.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Identifier for the agent whose work is being verified' },
            workdir: { type: 'string', description: 'Absolute path to the git working tree' },
            base: { type: 'string', description: 'Git ref/sha to diff against (default: merge-base with origin/main)' },
            claim: {
              type: 'object',
              properties: {
                expected_files: { type: 'number', description: 'Files the agent claimed to change' },
              },
            },
            report: {
              type: 'object',
              description: 'Pre-computed external report (typecheck/tests/lint/build)',
              properties: {
                pass: { type: 'boolean' },
                typecheck: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } } },
                tests: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } } },
                lint: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } } },
                build: { type: 'object', properties: { pass: { type: 'boolean' }, summary: { type: 'string' } } },
                summary: { type: 'string' },
              },
            },
          },
          required: ['agent_id', 'workdir'],
        },
      },
    },
  ];
}
