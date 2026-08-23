/**
 * `forget` archives the whole memory ONLY when no selector was given.
 *
 * Three independent reviewers found this on three different surfaces in one
 * pass, which is what makes it a root cause rather than three bugs:
 *
 *   core   `operations.ts` used `if (args.observation)` — truthiness, so `""`
 *          read as "no selector" and fell into the archive branch.
 *   MCP    `handlers.ts` ran `stripNullProps` BEFORE `safeParse`, so a
 *          null-valued UNKNOWN key was deleted rather than rejected by
 *          `.strict()`. `forget({name, observations: null})` — plural, the
 *          word `remember` uses — therefore arrived as `{name}` alone.
 *   CLI    `--observation ""`, which an unset shell variable produces.
 *
 * All three end in the same place: a request scoped to ONE observation
 * archives the entire memory and reports `{archived: true}`, without even
 * mentioning the observation the caller asked about. `schemas.ts` already
 * documents `.strict()` as the fix for the wrong-KEY door; these are the
 * empty-VALUE and null-VALUE doors beside it.
 *
 * The invariant under test is one sentence: an empty or unknown selector is a
 * caller error, never a licence to destroy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { forget } from '../../src/core/operations.js';
import { ForgetSchema } from '../../src/transports/schemas.js';
import { handleTool } from '../../src/transports/mcp/handlers.js';

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-forget-safety-'));
  savedHome = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'test.db'));
  new KnowledgeGraph(getDatabase()).createEntity('victim', 'note', {
    observations: ['fact one', 'fact two'],
  });
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (savedHome === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedHome;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function statusOf(name: string): string | undefined {
  return (getDatabase()
    .prepare('SELECT status FROM entities WHERE name = ?')
    .get(name) as { status?: string } | undefined)?.status;
}

function observationCount(): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM observations').get() as { c: number }).c;
}

describe('the schema refuses an empty selector', () => {
  it('rejects observation: "" rather than treating it as absent', () => {
    const parsed = ForgetSchema.safeParse({ name: 'victim', observation: '' });
    expect(parsed.success, 'an empty selector parsed as valid').toBe(false);
  });

  it('still accepts a real selector, and still accepts none at all', () => {
    // The half that gives the rejection meaning: this must not have made the
    // schema reject the two legitimate shapes.
    expect(ForgetSchema.safeParse({ name: 'victim', observation: 'fact one' }).success).toBe(true);
    expect(ForgetSchema.safeParse({ name: 'victim' }).success).toBe(true);
  });
});

describe('the core branch distinguishes absent from empty', () => {
  it('does NOT archive when the selector is an empty string', () => {
    // Reaches `forget()` directly, below the schema — because the schema is
    // one of two defences and this pins the other. A caller inside the
    // process (or a future transport) must not be able to archive by passing
    // "" either.
    const result = forget({ name: 'victim', observation: '' });

    expect(statusOf('victim'), 'an empty selector archived the whole memory').toBe('active');
    expect(observationCount(), 'observations were destroyed').toBe(2);
    expect(result, 'the result claimed an archive').not.toHaveProperty('archived', true);
  });

  it('removes exactly the named observation and keeps the memory active', () => {
    const result = forget({ name: 'victim', observation: 'fact one' }) as { observation_removed: boolean };

    expect(result.observation_removed).toBe(true);
    expect(observationCount()).toBe(1);
    expect(statusOf('victim'), 'removing one observation archived the entity').toBe('active');
  });

  it('archives when no selector is given at all — the one case that should', () => {
    // Anti-vacuity for the whole file: if this stopped working, every
    // assertion above would still pass while `forget` did nothing ever.
    const result = forget({ name: 'victim' }) as { archived: boolean };

    expect(result.archived).toBe(true);
    expect(statusOf('victim')).toBe('archived');
  });
});

describe('the MCP boundary rejects unknown keys whatever their value', () => {
  it('rejects a null-valued unknown key instead of silently dropping it', async () => {
    // The exact call that archived a whole memory: `observations` (plural)
    // with a null value, from a client that fills blank parameters with null.
    const res = await handleTool('forget', { name: 'victim', observations: null });

    expect(res.isError, 'a null-valued unknown key was accepted').toBe(true);
    expect(JSON.stringify(res)).toMatch(/nrecognized key/);
    expect(statusOf('victim'), 'the memory was archived by an unknown key').toBe('active');
    expect(observationCount()).toBe(2);
  });

  it('rejects a non-null unknown key the same way', async () => {
    const res = await handleTool('forget', { name: 'victim', observations: 'fact one' });

    expect(res.isError).toBe(true);
    expect(statusOf('victim')).toBe('active');
  });

  it('rejects an empty selector through the tool surface too', async () => {
    const res = await handleTool('forget', { name: 'victim', observation: '' });

    expect(res.isError, 'an empty selector was accepted at the MCP boundary').toBe(true);
    expect(statusOf('victim')).toBe('active');
    expect(observationCount()).toBe(2);
  });

  it('still lets a null-valued KNOWN optional field mean "left blank"', async () => {
    // The premise `stripNullProps` was written for is unchanged and must
    // stay working: a client that sends null for a blank OPTIONAL field
    // (Gemini CLI does) is not making an error. Only unknown keys are now
    // rejected before stripping.
    const res = await handleTool('recall', { query: 'victim', namespace: null });

    expect(res.isError, 'a null on a known optional field was rejected').toBeFalsy();
  });
});
