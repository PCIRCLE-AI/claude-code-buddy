import { describe, it, expect } from 'vitest';
import {
  RememberSchema,
  RecallSchema,
  ForgetSchema,
  LearnSchema,
  ImportSchema,
} from '../../src/transports/schemas.js';

// ── RememberSchema ──────────────────────────────────────────────────────────

describe('RememberSchema', () => {
  it('accepts valid input', () => {
    const result = RememberSchema.safeParse({
      name: 'test-entity',
      type: 'note',
      observations: ['obs1'],
      tags: ['tag1'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal valid input (name + type only)', () => {
    const result = RememberSchema.safeParse({ name: 'x', type: 'note' });
    expect(result.success).toBe(true);
  });

  it('rejects name longer than 255 chars', () => {
    const result = RememberSchema.safeParse({
      name: 'a'.repeat(256),
      type: 'note',
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 100 observations', () => {
    const result = RememberSchema.safeParse({
      name: 'test',
      type: 'note',
      observations: Array.from({ length: 101 }, (_, i) => `obs-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = RememberSchema.safeParse({ name: '', type: 'note' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type', () => {
    const result = RememberSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });
});

// ── RecallSchema ────────────────────────────────────────────────────────────

describe('RecallSchema', () => {
  it('accepts empty object', () => {
    const result = RecallSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid query and limit', () => {
    const result = RecallSchema.safeParse({ query: 'search term', limit: 10 });
    expect(result.success).toBe(true);
  });

  it('rejects query longer than 1000 chars', () => {
    const result = RecallSchema.safeParse({ query: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('rejects limit greater than 100', () => {
    const result = RecallSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects limit of 0', () => {
    const result = RecallSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('accepts include_archived boolean', () => {
    const result = RecallSchema.safeParse({ include_archived: true });
    expect(result.success).toBe(true);
  });
});

// ── ForgetSchema ────────────────────────────────────────────────────────────

describe('ForgetSchema', () => {
  it('accepts { name: "test" }', () => {
    const result = ForgetSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(true);
  });

  it('accepts name with optional observation', () => {
    const result = ForgetSchema.safeParse({ name: 'test', observation: 'obs' });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = ForgetSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = ForgetSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── LearnSchema ─────────────────────────────────────────────────────────────

describe('LearnSchema', () => {
  it('accepts { error: "x", fix: "y" }', () => {
    const result = LearnSchema.safeParse({ error: 'x', fix: 'y' });
    expect(result.success).toBe(true);
  });

  it('rejects missing error', () => {
    const result = LearnSchema.safeParse({ fix: 'y' });
    expect(result.success).toBe(false);
  });

  it('rejects missing fix', () => {
    const result = LearnSchema.safeParse({ error: 'x' });
    expect(result.success).toBe(false);
  });

  it('accepts all optional fields', () => {
    const result = LearnSchema.safeParse({
      error: 'build failed',
      fix: 'fixed tsconfig',
      root_cause: 'wrong paths',
      prevention: 'validate config before build',
      severity: 'major',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid severity value', () => {
    const result = LearnSchema.safeParse({
      error: 'x',
      fix: 'y',
      severity: 'low',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty error string', () => {
    const result = LearnSchema.safeParse({ error: '', fix: 'y' });
    expect(result.success).toBe(false);
  });
});

// ── ImportSchema ────────────────────────────────────────────────────────────

describe('ImportSchema', () => {
  const validData = {
    version: '3.0.0',
    exported_at: new Date().toISOString(),
    entity_count: 0,
    entities: [],
  };

  it('accepts valid import with skip strategy', () => {
    const result = ImportSchema.safeParse({ data: validData, merge_strategy: 'skip' });
    expect(result.success).toBe(true);
  });

  it('accepts valid import with overwrite strategy', () => {
    const result = ImportSchema.safeParse({ data: validData, merge_strategy: 'overwrite' });
    expect(result.success).toBe(true);
  });

  it('accepts valid import with append strategy', () => {
    const result = ImportSchema.safeParse({ data: validData, merge_strategy: 'append' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid merge_strategy', () => {
    const result = ImportSchema.safeParse({ data: validData, merge_strategy: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects missing merge_strategy', () => {
    const result = ImportSchema.safeParse({ data: validData });
    expect(result.success).toBe(false);
  });
});
