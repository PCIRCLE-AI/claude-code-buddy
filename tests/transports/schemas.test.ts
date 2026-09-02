import { describe, it, expect } from 'vitest';
import {
  RememberSchema,
  RecallSchema,
  ForgetSchema,
  LearnSchema,
  ImportSchema,
  MessageSchema,
  BriefingSchema,
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

// ── MessageSchema scope identifiers ─────────────────────────────────────────

describe('MessageSchema scope identifiers', () => {
  const send = {
    action: 'send' as const,
    project: 'memesh',
    sender: 'author',
    recipient: 'reviewer-agent',
    idempotency_key: 'k-1',
    payload: 'hello',
  };

  it('canonicalises project and recipient to NFC at the boundary', () => {
    const parsed = MessageSchema.parse({ ...send, project: 'proje\u0301t', recipient: 'cafe\u0301-reviewer' });
    expect(parsed.action).toBe('send');
    if (parsed.action !== 'send') throw new Error('unreachable');
    expect(parsed.project).toBe('proj\u00e9t');
    expect(parsed.recipient).toBe('caf\u00e9-reviewer');
  });

  it('refuses an absolute path and the error names the field and a valid value', () => {
    const bad = MessageSchema.safeParse({ ...send, recipient: '/root' });
    expect(bad.success).toBe(false);
    const message = bad.success ? '' : bad.error.issues.map((i) => i.message).join(' | ');
    expect(message).toContain('recipient must be a stable identifier, not a filesystem path');
    expect(message).toContain('"/root"');
    expect(message).toContain('"root"');

    const badProject = MessageSchema.safeParse({ ...send, project: '/Users/x/Projects/memesh-llm-memory' });
    expect(badProject.success).toBe(false);
    const projectMessage = badProject.success ? '' : badProject.error.issues.map((i) => i.message).join(' | ');
    expect(projectMessage).toContain('project must be a stable identifier');
    expect(projectMessage).toContain('"memesh-llm-memory"');
  });

  it('refuses a path-shaped recipient on the read actions too, not only on send', () => {
    for (const action of ['poll', 'fetch', 'receipts', 'ack'] as const) {
      const result = MessageSchema.safeParse({
        action, project: 'memesh', recipient: '/root', message_id: 'm-1', idempotency_key: 'k-1',
      });
      expect(result.success, `${action} must refuse a path-shaped recipient`).toBe(false);
    }
  });

  it('leaves `sender` alone — it is provenance, and it keys replay protection', () => {
    const parsed = MessageSchema.safeParse({ ...send, sender: '/root/full-board-scan-luna' });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.action === 'send') {
      expect(parsed.data.sender).toBe('/root/full-board-scan-luna');
    }
  });

  it('accepts an identifier that merely contains a separator', () => {
    // Only an ABSOLUTE path is provably not an identity this product derived.
    expect(MessageSchema.safeParse({ ...send, recipient: 'team/reviewer' }).success).toBe(true);
  });
});

describe('BriefingSchema scope identifiers', () => {
  it('applies the same rule as the message tool — briefing reads the same inbox key', () => {
    const parsed = BriefingSchema.parse({ project: 'memesh', recipient: 'cafe\u0301-reviewer' });
    expect(parsed.recipient).toBe('caf\u00e9-reviewer');
    const bad = BriefingSchema.safeParse({ project: 'memesh', recipient: '/root' });
    expect(bad.success).toBe(false);
    const message = bad.success ? '' : bad.error.issues.map((i) => i.message).join(' | ');
    expect(message).toContain('recipient must be a stable identifier, not a filesystem path');
    // Both fields stay optional: a generic briefing has no recipient identity.
    expect(BriefingSchema.safeParse({}).success).toBe(true);
  });
});
