/**
 * Export MeMesh tools in OpenAI function calling format.
 * This allows any OpenAI-compatible API to use MeMesh as a tool.
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
            limit: { type: 'number', description: 'Max results (default: 20)' },
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
  ];
}
