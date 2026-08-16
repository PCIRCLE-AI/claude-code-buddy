/**
 * G1 wired end to end on the dreamer side: failure-lessons become
 * kind='guard' proposals (LLM mocked at the fetch layer, exactly like
 * dreamer.test.ts), the validator gate holds against a broad or evidence-
 * failing spec, and acceptance patches the SOURCE lesson's metadata —
 * creating nothing, archiving nothing, and re-verifying the spec with no
 * model in the loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LLM = { provider: 'anthropic', apiKey: 'test-key-fake', model: 'claude-haiku-4-5' } as const;

function guardResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'GUARD',
    guard: {
      tool: 'Bash',
      pattern: 'git\\s+checkout\\s+--\\s',
      message: 'git checkout -- discards uncommitted work. Commit or stash first.',
      should_match: ['git checkout -- src/', 'git checkout -- .'],
      should_not_match: ['git checkout -b feature', 'git status'],
      ...overrides,
    },
  });
}

describe('lesson guards (dreamer side)', () => {
  let tmpHome: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-guards-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedFailureLesson(name = 'checkout-lesson'): number {
    return kg.createEntity(name, 'lesson_learned', {
      observations: [
        'Error: git checkout -- wiped five files of uncommitted fixes',
        'Root cause: restore ran before the fix was committed',
        'Fix: commit first, then mutate, then restore',
        'Prevention: never run git checkout -- with a dirty tree',
      ],
      tags: ['project:memesh'],
    });
  }

  function mockLlm(text: string) {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return { ok: true, json: async () => ({ content: [{ text }] }) } as any;
    });
    return () => calls;
  }

  it('stages a kind=guard proposal from a failure lesson, and lists it readably', async () => {
    const { runDreamer, listProposals } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    const calls = mockLlm(guardResponse());

    const result = await runDreamer(db, LLM, {});
    expect(calls()).toBe(1);
    expect(result.proposalsCreated).toBe(1);

    const row = db.prepare("SELECT kind, source_ids, proposed_digest, prompt_version FROM dream_proposals WHERE kind = 'guard'").get();
    expect(row).toBeDefined();
    expect(JSON.parse(row.source_ids)).toEqual([lessonId]);
    expect(row.prompt_version).toBe('guard-v1');
    const payload = JSON.parse(row.proposed_digest);
    expect(payload.guard.tool).toBe('Bash');
    expect(payload.source_lesson.id).toBe(lessonId);

    // The review queue names what is being approved, not '(corrupt)'.
    const listed = listProposals(db, 'pending').find((p: any) => p.kind === 'guard');
    expect(listed).toBeDefined();
    expect(listed!.digest_name).toContain('guard (Bash)');
    expect(listed!.digest_observations_preview).toContain('discards uncommitted work');
  });

  it('the validator gate holds: a broad pattern is skipped, not staged', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedFailureLesson();
    // Matches the benign probe 'git status' — exactly the guard that would
    // nag users into turning the feature off.
    mockLlm(guardResponse({ pattern: 'git\\s+\\w+', should_match: ['git checkout -- x', 'git add -A'], should_not_match: ['ls -la', 'echo hi'] }));

    const result = await runDreamer(db, LLM, {});
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped.some(s => s.reason.includes('failed validation'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'guard'").get().n).toBe(0);
  });

  it('NOOP stages nothing, and a freeform lesson never costs an LLM call', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    kg.createEntity('freeform-note', 'lesson_learned', {
      observations: ['remember to hydrate'],
      tags: ['project:memesh'],
    });
    seedFailureLesson();
    const calls = mockLlm(JSON.stringify({ action: 'NOOP', reason: 'no mechanical trigger' }));

    const result = await runDreamer(db, LLM, {});
    // One call for the failure lesson; zero for the freeform note.
    expect(calls()).toBe(1);
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped.some(s => s.reason.includes('NOOP or unparseable'))).toBe(true);
  });

  it('a lesson with a pending guard proposal is not proposed twice', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedFailureLesson();
    const calls = mockLlm(guardResponse());

    await runDreamer(db, LLM, {});
    const second = await runDreamer(db, LLM, {});
    // The second run finds the pending proposal and never reaches the LLM.
    expect(calls()).toBe(1);
    expect(second.proposalsCreated).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'guard'").get().n).toBe(1);
  });

  it('accepting writes metadata.guard onto the source lesson — warn-only, evidence attached', async () => {
    const { runDreamer, applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    mockLlm(guardResponse());
    await runDreamer(db, LLM, {});
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    const applied = applyProposal(db, proposalId, kg);
    expect(applied.kind).toBe('guard');
    expect(applied.sourcesArchived).toBe(0);
    expect(applied.digestEntityName).toContain('checkout-lesson');

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.enabled).toBe(true);
    // v1 policy: acceptance never escalates past warn, whatever the model said.
    expect(meta.guard.action).toBe('warn');
    expect(meta.guard.fires).toBe(0);
    expect(meta.guard.should_match.length).toBeGreaterThanOrEqual(2);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(proposalId).status).toBe('applied');

    // The lesson itself is untouched otherwise: still active, no archive.
    expect(db.prepare('SELECT status FROM entities WHERE id = ?').get(lessonId).status).toBe('active');
  });

  it('acceptance re-verifies with no model: a spec that stopped being valid throws', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    // Hand-stage a proposal whose pattern is too broad — as if validation
    // rules tightened between staging and review months later.
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, kind)
      VALUES ('memesh', 'guard:${lessonId}', ?, ?, 'test/fake', 'guard-v1', 'guard')
    `).run(JSON.stringify([lessonId]), JSON.stringify({
      guard: { tool: 'Bash', pattern: '.*', message: 'anything', should_match: ['a b c d e f'], should_not_match: [] },
      source_lesson: { id: lessonId, name: 'checkout-lesson' },
    }));
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    expect(() => applyProposal(db, proposalId, kg)).toThrow(/guard spec is not valid/);
    // Nothing landed on the lesson.
    const metaRaw = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata;
    expect(metaRaw === null || !JSON.parse(metaRaw).guard).toBe(true);
  });

  it('accepting a guard for an archived lesson fails loudly', async () => {
    const { runDreamer, applyProposal } = await import('../../src/core/dreamer.js');
    const lessonId = seedFailureLesson();
    mockLlm(guardResponse());
    await runDreamer(db, LLM, {});
    const proposalId = db.prepare("SELECT id FROM dream_proposals WHERE kind = 'guard'").get().id;

    db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(lessonId);
    expect(() => applyProposal(db, proposalId, kg)).toThrow(/no longer active/);
  });
});
