// dreamer — LLM cluster compactor (#39 Phase 2). Tests cover the
// LLM-independent paths: cluster detection, idempotency, apply/reject,
// safety guards. The LLM call itself is mocked via the dryRun path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('dreamer', () => {
  let tmpHome: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memesh-dreamer-'));
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
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedCommits(count: number, project = 'memesh'): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const name = `Commit abc${i}: feat: add thing ${i}`;
      const id = kg.createEntity(name, 'commit', {
        observations: [`feat: add thing ${i}\n\nDetails about change ${i} that justify a body`],
        tags: [`project:${project}`],
      });
      ids.push(id);
    }
    return ids;
  }

  function seedLessons(count: number, project = 'memesh'): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const id = kg.createEntity(`lesson-${i}`, 'lesson_learned', {
        observations: ['Error: x', 'Root cause: y', 'Fix: z', 'Prevention: w'],
        tags: [`project:${project}`],
      });
      ids.push(id);
    }
    return ids;
  }

  it('skips when no LLM is configured', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(10);
    const result = await runDreamer(db, undefined);
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped[0].reason).toMatch(/no LLM/);
  });

  it('detects cluster of compactable commits but skips when below MIN_CLUSTER_SIZE', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(3); // MIN is 5
    const result = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    // Cluster exists but is too small to compact
    expect(result.skipped.some(s => s.reason.includes('smaller than'))).toBe(true);
  });

  it('NEVER includes lesson_learned, decision, architecture, etc. (semantic types are protected)', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedLessons(20); // many lessons — would form a cluster IF they were compactable
    const result = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    // No clusters detected because all entities are protected types
    expect(result.clustersScanned).toBe(0);
    expect(result.proposalsCreated).toBe(0);
  });

  it('NEVER includes pinned entities (metadata.pin = true)', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    for (let i = 0; i < 10; i++) {
      kg.createEntity(`pinned-commit-${i}`, 'commit', {
        observations: [`commit message ${i} long enough to be a body content`],
        tags: ['project:memesh'],
        metadata: { pin: true },
      });
    }
    const result = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    expect(result.clustersScanned).toBe(0);
  });

  it('protection reachable via the real setPinned writer (end-to-end, not just seeded metadata)', async () => {
    // The test above seeds metadata.pin directly. This proves the PRODUCTION
    // path: `setPinned` (behind `memesh pin`) is what a user actually calls,
    // and it must connect to the dreamer's `metadata.pin === true` read. Before
    // this writer existed the read was inert — nothing could set the flag.
    const { runDreamer } = await import('../../src/core/dreamer.js');
    const { setPinned } = await import('../../src/core/operations.js');
    const names: string[] = [];
    for (let i = 0; i < 10; i++) {
      const name = `commit-to-pin-${i}`;
      kg.createEntity(name, 'commit', {
        observations: [`commit message ${i} long enough to be a body content`],
        tags: ['project:memesh'],
      });
      names.push(name);
    }
    // Baseline: unpinned, these DO form a compactable cluster.
    const before = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    expect(before.clustersScanned).toBeGreaterThan(0);

    for (const name of names) expect(setPinned(name, true).found).toBe(true);

    const after = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    expect(after.clustersScanned).toBe(0);
  });

  it('NEVER re-compacts entities with consolidation_depth >= 1 (no recursive degradation)', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    for (let i = 0; i < 10; i++) {
      kg.createEntity(`already-digested-${i}`, 'commit', {
        observations: [`already digested content ${i}`],
        tags: ['project:memesh'],
        metadata: { consolidation_depth: 1 },
      });
    }
    const result = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true });
    expect(result.clustersScanned).toBe(0);
  });

  it('respects --project filter — entries from other projects are not clustered together', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(10, 'project-a');
    seedCommits(10, 'project-b');
    const resultA = await runDreamer(db, { provider: 'ollama', model: 'fake' }, { dryRun: true, project: 'project-a' });
    // Project-a forms a cluster; project-b ignored
    expect(resultA.clustersScanned).toBe(1);
  });

  it('listProposals returns empty when no proposals exist', async () => {
    const { listProposals } = await import('../../src/core/dreamer.js');
    expect(listProposals(db, 'pending')).toEqual([]);
  });

  it('apply: writes a digest entity, soft-archives sources, links via metadata.compacted_into', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    // Manually insert a pending proposal (simulates LLM output)
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'memesh',
      '2026-W19',
      JSON.stringify(sourceIds),
      JSON.stringify({
        name: 'digest-2026-W19-feature-thing',
        type: 'digest',
        observations: ['Consolidated 6 commits implementing the feature thing across week 19'],
        tags: ['digest', 'project:memesh', 'week:2026-W19'],
      }),
      'ollama/fake',
      'v1',
    );
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    const result = applyProposal(db, proposalRow.id, kg);
    expect(result.sourcesArchived).toBe(6);
    expect(result.digestEntityName).toBe('digest-2026-W19-feature-thing');

    // Digest entity should exist and be active
    const digest = db.prepare("SELECT id, status, metadata FROM entities WHERE name = ?").get('digest-2026-W19-feature-thing') as any;
    expect(digest).toBeDefined();
    expect(digest.status).toBe('active');
    const digestMeta = JSON.parse(digest.metadata);
    expect(digestMeta.consolidation_depth).toBe(1);
    expect(digestMeta.source_ids).toEqual(sourceIds);

    // Sources should be archived AND linked to the digest
    for (const sourceId of sourceIds) {
      const source = db.prepare('SELECT status, metadata FROM entities WHERE id = ?').get(sourceId) as any;
      expect(source.status).toBe('archived');
      const meta = JSON.parse(source.metadata);
      expect(meta.compacted_into).toBe(digest.id);
    }

    // Proposal status flipped to 'applied'
    const updatedProposal = db.prepare('SELECT status, reviewed_at FROM dream_proposals WHERE id = ?').get(proposalRow.id) as any;
    expect(updatedProposal.status).toBe('applied');
    expect(updatedProposal.reviewed_at).toBeDefined();
  });

  it('reject: source entities untouched, proposal marked rejected with reason', async () => {
    const { rejectProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(6);
    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('memesh', '2026-W19', JSON.stringify(sourceIds), JSON.stringify({
      name: 'bad-digest', type: 'digest', observations: ['nope'], tags: [],
    }), 'ollama/fake', 'v1');
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    rejectProposal(db, proposalRow.id, 'incoherent grouping');

    // Sources still active
    for (const sourceId of sourceIds) {
      const s = db.prepare('SELECT status FROM entities WHERE id = ?').get(sourceId) as any;
      expect(s.status).toBe('active');
    }
    // Proposal status flipped
    const updated = db.prepare('SELECT status, reason FROM dream_proposals WHERE id = ?').get(proposalRow.id) as any;
    expect(updated.status).toBe('rejected');
    expect(updated.reason).toBe('incoherent grouping');
  });

  it('apply throws on a non-existent or already-applied proposal', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    expect(() => applyProposal(db, 99999, kg)).toThrow(/not found or not pending/);
  });

  // ============================================================================
  // Phase 3 — pattern detector
  // ============================================================================

  it('pattern detector skips projects with too few entities', async () => {
    const { runPatternDetector } = await import('../../src/core/dreamer.js');
    seedCommits(3, 'tiny-project');
    const result = await runPatternDetector(db, { provider: 'ollama', model: 'fake' }, {
      project: 'tiny-project',
      dryRun: true,
    });
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped.some(s => s.reason.includes('fewer than'))).toBe(true);
  });

  it('pattern detector skips when no LLM is configured', async () => {
    const { runPatternDetector } = await import('../../src/core/dreamer.js');
    seedCommits(20);
    const result = await runPatternDetector(db, undefined, { project: 'memesh', dryRun: true });
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped[0].reason).toMatch(/no LLM/);
  });

  it('pattern apply: creates pattern_emergent entity, links sources via evidence_for, does NOT archive', async () => {
    const { applyProposal } = await import('../../src/core/dreamer.js');
    const sourceIds = seedCommits(4);

    db.prepare(`
      INSERT INTO dream_proposals (project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'memesh',
      'pattern:2026-05-08',
      JSON.stringify(sourceIds),
      JSON.stringify({
        name: 'pattern-recurring-thing',
        type: 'pattern_emergent',
        observations: ['Pattern: every commit touching X also touches Y'],
        tags: ['pattern_emergent', 'project:memesh'],
      }),
      'ollama/fake',
      'v1',
    );
    const proposalRow = db.prepare("SELECT id FROM dream_proposals WHERE status='pending'").get() as { id: number };

    const result = applyProposal(db, proposalRow.id, kg);
    // Aligned with ProposalSummary.kind discriminator — earlier the
    // apply path returned 'pattern' (abbreviated) which created
    // contract drift with the listing path. Pinned at the canonical
    // 'pattern_emergent' value as part of the v4.2.0 cleanup.
    expect(result.kind).toBe('pattern_emergent');
    expect(result.sourcesLinked).toBe(4);
    expect(result.sourcesArchived).toBe(0);

    // Pattern entity exists, sources still active
    const pattern = db.prepare("SELECT id, status, metadata FROM entities WHERE name = ?").get('pattern-recurring-thing') as any;
    expect(pattern.status).toBe('active');
    const meta = JSON.parse(pattern.metadata);
    expect(meta.kind).toBe('pattern_emergent');
    expect(meta.consolidation_depth).toBeUndefined(); // patterns aren't depth-counted

    for (const sourceId of sourceIds) {
      const source = db.prepare('SELECT status, metadata FROM entities WHERE id = ?').get(sourceId) as any;
      expect(source.status).toBe('active'); // NOT archived
      const sourceMeta = JSON.parse(source.metadata);
      expect(sourceMeta.evidence_for).toContain(pattern.id);
      expect(sourceMeta.compacted_into).toBeUndefined(); // not compacted
    }
  });

  // ============================================================================
  // validateBeforeStage (digest validator integration)
  // ============================================================================

  it('validateBeforeStage=true rejects digest when validator returns reject verdict', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(6);

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      // First call: dreamer's consolidateCluster returns a digest.
      // Second call: digest-validator says "reject — fabricated branch".
      const text = callCount === 1
        ? JSON.stringify({
            action: 'ADD',
            digest: {
              name: 'wk-19-feature',
              type: 'digest',
              observations: ['Implements feature on release/v4.1.14 branch'],
              tags: ['digest', 'project:memesh', 'week:wk'],
            },
          })
        : JSON.stringify({
            verdict: 'reject',
            suspicious: [{ claim: 'release/v4.1.14 branch', reason: 'no such branch in sources' }],
          });
      return { ok: true, json: async () => ({ content: [{ text }] }) } as any;
    });

    const result = await runDreamer(
      db,
      { provider: 'anthropic', apiKey: 'test-key-fake', model: 'claude-haiku-4-5' },
      { dryRun: true, validateBeforeStage: true },
    );

    expect(callCount).toBe(2); // dreamer + validator
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped.some(s => s.reason.startsWith('LLM validator rejected digest'))).toBe(true);
  });

  it('validateBeforeStage=true with verdict=soften writes proposal with validation_warnings', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(6);

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      const text = callCount === 1
        ? JSON.stringify({
            action: 'ADD',
            digest: {
              name: 'wk-19-feature',
              type: 'digest',
              observations: ['Implements feature with mostly-correct details'],
              tags: ['digest', 'project:memesh', 'week:wk'],
            },
          })
        : JSON.stringify({
            verdict: 'soften',
            suspicious: [{ claim: 'minor detail', reason: 'not in sources' }],
          });
      return { ok: true, json: async () => ({ content: [{ text }] }) } as any;
    });

    const result = await runDreamer(
      db,
      { provider: 'anthropic', apiKey: 'test-key-fake', model: 'claude-haiku-4-5' },
      { validateBeforeStage: true },
    );

    expect(result.proposalsCreated).toBe(1);
    const row = db.prepare("SELECT proposed_digest FROM dream_proposals WHERE status='pending'").get() as { proposed_digest: string };
    const digestObj = JSON.parse(row.proposed_digest);
    expect(digestObj.validation_warnings).toBeDefined();
    expect(digestObj.validation_warnings).toHaveLength(1);
    expect(digestObj.validation_warnings[0].claim).toBe('minor detail');
  });

  it('validateBeforeStage=false (default) skips the validator entirely', async () => {
    const { runDreamer } = await import('../../src/core/dreamer.js');
    seedCommits(6);

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          content: [{
            text: JSON.stringify({
              action: 'ADD',
              digest: {
                name: 'wk-19',
                type: 'digest',
                observations: ['summary'],
                tags: ['digest', 'project:memesh', 'week:wk'],
              },
            }),
          }],
        }),
      } as any;
    });

    const result = await runDreamer(
      db,
      { provider: 'anthropic', apiKey: 'test-key-fake', model: 'claude-haiku-4-5' },
      { /* validateBeforeStage absent */ },
    );

    expect(callCount).toBe(1); // only the dreamer call, no validator
    expect(result.proposalsCreated).toBe(1);
    const row = db.prepare("SELECT proposed_digest FROM dream_proposals WHERE status='pending'").get() as { proposed_digest: string };
    const digestObj = JSON.parse(row.proposed_digest);
    expect(digestObj.validation_warnings).toBeUndefined();
  });

  it('pattern detector includes high-signal entities (lessons/decisions) — patterns CAN draw from semantic types', async () => {
    const { runPatternDetector } = await import('../../src/core/dreamer.js');
    seedLessons(10, 'memesh'); // 10 lessons — protected from compaction but fair game for pattern detection
    const result = await runPatternDetector(db, { provider: 'ollama', model: 'fake' }, {
      project: 'memesh',
      dryRun: true,
    });
    expect(result.entitiesScanned).toBeGreaterThanOrEqual(10);
  });
});
