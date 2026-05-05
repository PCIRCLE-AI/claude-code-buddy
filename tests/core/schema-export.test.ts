import { describe, it, expect } from 'vitest';
import { exportOpenAITools } from '../../src/core/schema-export.js';

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
