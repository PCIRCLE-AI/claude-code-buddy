import { describe, it, expect } from 'vitest';
import { exportOpenAITools } from '../../src/core/schema-export.js';
import { BriefingSchema, MessageSchema, RememberSchema, RecallSchema } from '../../src/transports/schemas.js';
import { TOOL_DEFINITIONS } from '../../src/transports/mcp/handlers.js';

describe('exportOpenAITools', () => {
  const tools = exportOpenAITools();

  it('exports one tool per MCP tool, counted from the registry itself', () => {
    // This used to assert the literal 9, next to a name list that was also a
    // literal, under a title claiming it "matches MCP registry" — it matched
    // nothing, it restated. Retiring `consolidate` made both wrong at once,
    // which is what a duplicated list is for. Counted from the registry now.
    expect(Array.isArray(tools)).toBe(true);
    expect(TOOL_DEFINITIONS.length, 'the MCP registry is empty — this test would pass on nothing').toBeGreaterThan(0);
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('each tool has type "function" and a function object with name, description, parameters', () => {
    for (const tool of tools) {
      const t = tool as any;
      expect(t.type).toBe('function');
      expect(t.function).toBeDefined();
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters).toBeDefined();
      expect(t.function.parameters.type).toBe('object');
      expect(t.function.parameters.properties).toBeDefined();
    }
  });

  it('exports exactly the MCP tool names, prefixed, in registry order', () => {
    const names = tools.map((t: any) => t.function.name);
    expect(names).toEqual(TOOL_DEFINITIONS.map((t) => `memesh_${t.name}`));
  });

  it('memesh_import requires data and merge_strategy', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_import') as any;
    expect(tool.function.parameters.required).toEqual(['data', 'merge_strategy']);
    expect(tool.function.parameters.properties.merge_strategy.description).not.toMatch(/default/i);
  });

  it('memesh_export has no required fields (all optional filters)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_export') as any;
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('memesh_remember requires name and type', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    expect(tool.function.parameters.required).toEqual(['name', 'type']);
  });

  it('memesh_recall has no required fields', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_recall') as any;
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('memesh_forget requires name', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_forget') as any;
    expect(tool.function.parameters.required).toEqual(['name']);
  });

  it('memesh_learn requires error and fix', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_learn') as any;
    expect(tool.function.parameters.required).toEqual(['error', 'fix']);
  });

  it('memesh_improvement exposes proposal/status only and keeps review authority human', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_improvement') as any;
    expect(tool.function.parameters.required).toEqual(['action']);
    expect(tool.function.parameters.properties.action.enum).toEqual(['propose', 'status']);
    expect(tool.function.parameters.properties).not.toHaveProperty('accept');
    expect(tool.function.parameters.properties).not.toHaveProperty('reject');
    expect(tool.function.description).toMatch(/cannot accept or reject/i);
  });

  it('memesh_message exposes every action and does not collapse reads into ACK', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_message') as any;
    expect(tool.function.parameters.required).toEqual(['action']);
    expect(tool.function.parameters.properties.action.enum).toEqual([
      'send', 'poll', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts',
    ]);
    expect(tool.function.description).toMatch(/Reads never imply acknowledgement/);
    expect(tool.function.parameters.properties.recipient.description).toMatch(/required for every action/i);
    const mcpMessage = TOOL_DEFINITIONS.find((definition) => definition.name === 'message') as any;
    expect(tool.function.parameters.properties.recipient.description)
      .toBe(mcpMessage.inputSchema.properties.recipient.description);

    expect(MessageSchema.safeParse({
      action: 'poll', project: 'memesh', recipient: 'codex', wait_ms: 30_001,
    }).success).toBe(false);
    expect(MessageSchema.safeParse({ action: 'poll', project: 'memesh' }).success).toBe(false);
    expect(MessageSchema.safeParse({
      action: 'ack', project: 'memesh', recipient: 'codex', message_id: 'm-1', idempotency_key: 'ack-1', disposition: 'completed',
    }).success).toBe(false);
  });

  // Non-tautological parity: derive the expected fields from the Zod schemas
  // that are the real validation source of truth, not from the export itself.
  // If someone adds a field to RememberSchema/RecallSchema, the OpenAI export
  // must expose it or an agent driven off the export can never send it — the
  // exact gap that left `relations`/`namespace` off `remember` and made every
  // agent-created entity an orphan.
  it('memesh_remember exposes every field in RememberSchema (incl. relations, namespace)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    const zodKeys = Object.keys(RememberSchema.shape);
    for (const key of zodKeys) {
      expect(exported, `RememberSchema.${key} missing from OpenAI export`).toContain(key);
    }
    // Guard against silent regression on the two that were missing.
    expect(exported).toContain('relations');
    expect(exported).toContain('namespace');
  });

  it('memesh_recall exposes every field in RecallSchema (incl. include_archived, cross_project)', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_recall') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    const zodKeys = Object.keys(RecallSchema.shape);
    for (const key of zodKeys) {
      expect(exported, `RecallSchema.${key} missing from OpenAI export`).toContain(key);
    }
    expect(exported).toContain('include_archived');
    expect(exported).toContain('cross_project');
    expect(exported).toContain('namespace');
  });

  it('memesh_briefing exposes the optional exact recipient scope', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_briefing') as any;
    const exported = Object.keys(tool.function.parameters.properties);
    expect(exported).toEqual(Object.keys(BriefingSchema.shape));
    expect(tool.function.parameters.properties.recipient.description).toMatch(/exact logical recipient/i);

    const mcp = TOOL_DEFINITIONS.find((definition) => definition.name === 'briefing')!;
    expect(Object.keys(mcp.inputSchema.properties)).toEqual(Object.keys(BriefingSchema.shape));
    expect(mcp.inputSchema.properties.recipient.description).toMatch(/exact logical recipient/i);
  });

  it('the relations field is shaped as an array of {to, type} objects', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_remember') as any;
    const rel = tool.function.parameters.properties.relations;
    expect(rel.type).toBe('array');
    expect(rel.items.type).toBe('object');
    expect(Object.keys(rel.items.properties).sort()).toEqual(['to', 'type']);
    expect(rel.items.required.sort()).toEqual(['to', 'type']);
  });

  it('all parameter properties have a type field', () => {
    for (const tool of tools) {
      const t = tool as any;
      const props = t.function.parameters.properties;
      for (const [key, value] of Object.entries(props)) {
        expect((value as any).type, `${t.function.name}.${key} should have a type`).toBeDefined();
      }
    }
  });

  it('every namespace field publishes the enum the runtime actually enforces (M-12)', () => {
    // remember/recall's namespace fields carried `enum: ['personal', 'team',
    // 'global']`; export/import's did not — a bare `{type: 'string'}` next
    // to a description that only MENTIONED the three values in prose. A
    // client (or a model reading the schema, not the docs) had no
    // machine-readable way to know 'prod' would be rejected until it tried.
    const withNamespace = TOOL_DEFINITIONS.filter((t: any) => 'namespace' in t.inputSchema.properties);
    expect(withNamespace.length, 'fixture: no registered tool declares a namespace field').toBeGreaterThan(0);
    for (const def of withNamespace) {
      const field = (def.inputSchema.properties as any).namespace;
      expect(field.enum, `${def.name}.namespace has no enum`).toEqual(['personal', 'team', 'global']);
    }
  });
});
