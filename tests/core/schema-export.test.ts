import { describe, it, expect } from 'vitest';
import { exportOpenAITools } from '../../src/core/schema-export.js';
import { RememberSchema, RecallSchema } from '../../src/transports/schemas.js';

describe('exportOpenAITools', () => {
  const tools = exportOpenAITools();

  it('returns an array of 9 tools (matches MCP registry)', () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(9);
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

  it('contains the correct tool names (matches MCP registry)', () => {
    const names = tools.map((t: any) => t.function.name);
    expect(names).toEqual([
      'memesh_remember',
      'memesh_recall',
      'memesh_forget',
      'memesh_consolidate',
      'memesh_learn',
      'memesh_export',
      'memesh_import',
      'memesh_user_patterns',
      'memesh_verify_agent_work',
    ]);
  });

  it('memesh_import requires data and merge_strategy', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_import') as any;
    expect(tool.function.parameters.required).toEqual(['data', 'merge_strategy']);
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

  it('memesh_consolidate has no required fields', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_consolidate') as any;
    expect(tool.function.parameters.required).toBeUndefined();
  });

  it('memesh_learn requires error and fix', () => {
    const tool = tools.find((t: any) => t.function.name === 'memesh_learn') as any;
    expect(tool.function.parameters.required).toEqual(['error', 'fix']);
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
});
