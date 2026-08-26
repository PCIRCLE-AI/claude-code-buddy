import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('governed memory-to-product improvements', () => {
  let tmpHome: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-product-improvement-'));
    process.env.MEMESH_DB_PATH = join(tmpHome, 'graph.db');
    process.env.MEMESH_DIR = tmpHome;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(process.env.MEMESH_DB_PATH);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    delete process.env.MEMESH_DIR;
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedSources(): number[] {
    return [
      kg.createEntity('dogfood-duplicate-research', 'lesson_learned', {
        title: 'Agents duplicated the same research',
        observations: ['Two agents independently researched the same protocol landscape.'],
        tags: ['project:memesh'],
        namespace: 'team',
      }),
      kg.createEntity('dogfood-shared-note-ownership', 'feedback', {
        title: 'Shared notes need an owner',
        observations: ['Concurrent writers need a visible ownership claim.'],
        tags: ['project:memesh'],
        namespace: 'team',
      }),
    ];
  }

  const proposalInput = {
    project: 'memesh',
    source_names: ['dogfood-shared-note-ownership', 'dogfood-duplicate-research'],
    title: 'Add claims and leases to shared research work',
    problem: 'Agents can duplicate work because shared records do not expose active ownership.',
    proposed_change: 'Add claim, lease, expiry, acknowledgement, and disposition to collaboration work items.',
    verification_scenario: 'Start two agents on the same research topic and verify the second sees the first claim before doing duplicate work.',
    success_criteria: [
      'A second agent can discover the active owner and lease.',
      'An expired claim can be recovered without deleting evidence.',
    ],
    priority: 'p1' as const,
  };

  it('stages one idempotent pending proposal without changing source memories', async () => {
    const sourceIds = seedSources();
    expect(sourceIds).toHaveLength(2);
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');

    const first = stageProductImprovement(db, { ...proposalInput, sourceHost: 'codex' });
    const retry = stageProductImprovement(db, { ...proposalInput, sourceHost: 'claude-code' });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.proposal_id).toBe(first.proposal_id);
    expect(first.source_ids).toEqual([...sourceIds].sort((a, b) => a - b));
    expect(first.review).toMatchObject({
      required: true,
      authority: 'human',
      state: 'pending',
      accept: `memesh dream accept ${first.proposal_id}`,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get().n).toBe(1);

    const sources = db.prepare('SELECT id, status FROM entities WHERE id IN (?, ?) ORDER BY id').all(...sourceIds);
    expect(sources).toEqual(sourceIds.map((id) => ({ id, status: 'active' })));
  });

  it('stages a distinct proposal when the proposed product change differs', async () => {
    seedSources();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');
    const first = stageProductImprovement(db, proposalInput);
    const second = stageProductImprovement(db, {
      ...proposalInput,
      proposed_change: proposalInput.proposed_change + ' Also expose a cutoff cursor.',
    });
    expect(second.proposal_id).not.toBe(first.proposal_id);
  });

  it('fails staging on missing or archived evidence and writes no proposal', async () => {
    seedSources();
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = 'dogfood-shared-note-ownership'").run();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');

    expect(() => stageProductImprovement(db, proposalInput)).toThrow(/must exist and be active/);
    expect(() => stageProductImprovement(db, {
      ...proposalInput,
      source_names: ['missing-memory'],
    })).toThrow(/missing-memory/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dream_proposals WHERE kind = 'product_improvement'").get().n).toBe(0);
  });

  it('human acceptance creates one linked work item, preserves evidence, and surfaces it in briefing', async () => {
    const sourceIds = seedSources();
    const { stageProductImprovement, getProductImprovementStatus } = await import('../../src/core/product-improvements.js');
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const staged = stageProductImprovement(db, { ...proposalInput, sourceHost: 'codex' });

    const applied = applyProposal(db, staged.proposal_id, kg);

    expect(applied).toMatchObject({
      proposalId: staged.proposal_id,
      kind: 'product_improvement',
      sourcesArchived: 0,
      sourcesLinked: 2,
    });
    const entity = kg.getEntity(applied.digestEntityName)!;
    expect(entity).toMatchObject({
      title: proposalInput.title,
      type: 'product_improvement',
      namespace: 'team',
    });
    expect(entity.observations).toContain('State: accepted for product work; implementation and outcome are not verified.');
    expect(entity.tags).toEqual(expect.arrayContaining([
      'project:memesh',
      'status:accepted-for-product',
      'implementation:unverified',
      'outcome:unverified',
    ]));
    expect(entity.tags).not.toContain('status:proposed');
    expect(entity.metadata).toMatchObject({
      proposal_id: staged.proposal_id,
      source_ids: [...sourceIds].sort((a, b) => a - b),
      implementation_state: 'unverified',
      outcome_state: 'unverified',
    });

    const links = db.prepare(
      'SELECT to_entity_id, relation_type FROM relations WHERE from_entity_id = ? ORDER BY to_entity_id',
    ).all(entity.id);
    expect(links).toEqual(sourceIds.map((id) => ({ to_entity_id: id, relation_type: 'learned-from' })));
    expect(db.prepare('SELECT id, status FROM entities WHERE id IN (?, ?) ORDER BY id').all(...sourceIds))
      .toEqual(sourceIds.map((id) => ({ id, status: 'active' })));

    const status = getProductImprovementStatus(db, staged.proposal_id);
    expect(status).toMatchObject({ status: 'applied', accepted_entity_name: applied.digestEntityName });
    const { assembleBriefing } = await import('../../src/core/briefing.js');
    const briefing = assembleBriefing('memesh');
    expect(briefing.text).toContain(`[product_improvement] ${proposalInput.title}`);
    expect(briefing.text).toContain(`[mem:${entity.id}]`);
  });

  it('rejects without creating work or mutating evidence', async () => {
    const sourceIds = seedSources();
    const { stageProductImprovement, getProductImprovementStatus } = await import('../../src/core/product-improvements.js');
    const { rejectProposal } = await import('../../src/core/dreamer.js');
    const staged = stageProductImprovement(db, proposalInput);

    rejectProposal(db, staged.proposal_id, 'not a product priority');

    expect(getProductImprovementStatus(db, staged.proposal_id)).toMatchObject({
      status: 'rejected',
      reason: 'not a product priority',
      accepted_entity_name: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'product_improvement'").get().n).toBe(0);
    expect(db.prepare('SELECT id, status FROM entities WHERE id IN (?, ?) ORDER BY id').all(...sourceIds))
      .toEqual(sourceIds.map((id) => ({ id, status: 'active' })));
  });

  it('rolls back acceptance when evidence changed or the payload is malformed', async () => {
    seedSources();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');
    const { applyProposal } = await import('../../src/core/dreamer.js');

    const stale = stageProductImprovement(db, proposalInput);
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = 'dogfood-duplicate-research'").run();
    expect(() => applyProposal(db, stale.proposal_id, kg)).toThrow(/missing or archived/);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(stale.proposal_id).status).toBe('pending');
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'product_improvement'").get().n).toBe(0);

    db.prepare("UPDATE entities SET status = 'active' WHERE name = 'dogfood-duplicate-research'").run();
    db.prepare("UPDATE dream_proposals SET proposed_digest = '{}' WHERE id = ?").run(stale.proposal_id);
    expect(() => applyProposal(db, stale.proposal_id, kg)).toThrow(/malformed content/);
    expect(db.prepare('SELECT status FROM dream_proposals WHERE id = ?').get(stale.proposal_id).status).toBe('pending');
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'product_improvement'").get().n).toBe(0);
  });

  it('does not let an already-reviewed proposal create a second work item', async () => {
    seedSources();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');
    const { applyProposal, rejectProposal } = await import('../../src/core/dreamer.js');
    const staged = stageProductImprovement(db, proposalInput);
    rejectProposal(db, staged.proposal_id, 'settled elsewhere');

    expect(() => applyProposal(db, staged.proposal_id, kg)).toThrow(/not found or not pending/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE type = 'product_improvement'").get().n).toBe(0);
  });

  it('opens a new pending review cycle after an identical proposal was rejected', async () => {
    seedSources();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');
    const { rejectProposal } = await import('../../src/core/dreamer.js');
    const rejected = stageProductImprovement(db, proposalInput);
    rejectProposal(db, rejected.proposal_id, 'not a priority yet');

    const restaged = stageProductImprovement(db, proposalInput);

    expect(restaged).toMatchObject({ created: true, status: 'pending' });
    expect(restaged.proposal_id).not.toBe(rejected.proposal_id);
    expect(db.prepare(
      "SELECT status FROM dream_proposals WHERE kind = 'product_improvement' ORDER BY id",
    ).all()).toEqual([{ status: 'rejected' }, { status: 'pending' }]);
  });

  it('can accept a new review cycle after the identical improvement was already applied', async () => {
    seedSources();
    const { stageProductImprovement } = await import('../../src/core/product-improvements.js');
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const first = stageProductImprovement(db, proposalInput);
    const firstApplied = applyProposal(db, first.proposal_id, kg);

    const restaged = stageProductImprovement(db, proposalInput);
    const secondApplied = applyProposal(db, restaged.proposal_id, kg);

    expect(restaged).toMatchObject({ created: true, status: 'pending' });
    expect(restaged.proposal_id).not.toBe(first.proposal_id);
    expect(secondApplied.digestEntityName).not.toBe(firstApplied.digestEntityName);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM entities WHERE type = 'product_improvement'",
    ).get().n).toBe(2);
  });
});
