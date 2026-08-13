// The conflict pipeline's LLM half (P2): verdicts, staging, acceptance.
//
// callLLM is mocked — these tests pin the CONTRACT around the model (what
// gets written for each verdict shape), not the model itself. Vectors are
// written directly into entities_vec, unit-length, same discipline as
// conflict-candidates.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';

const callLLMMock = vi.fn();
vi.mock('../../src/core/llm-client.js', () => ({
  callLLM: (...args: unknown[]) => callLLMMock(...args),
}));
vi.mock('../../src/core/llm-telemetry.js', () => ({
  recordTelemetry: () => {},
}));

import { getDatabase } from '../../src/db.js';
import type { LLMConfig } from '../../src/core/config.js';
import { judgeConflicts } from '../../src/core/conflict-judge.js';
import { findConflictCandidates } from '../../src/core/conflict-candidates.js';
import { applyProposal, rejectProposal, listProposals, getProposalDetail } from '../../src/core/dreamer.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-conflict-judge-');

const LLM: LLMConfig = { provider: 'ollama', model: 'test-model' } as LLMConfig;
const DIM = 384;

function unitVec(axis: number, deg: number): Float32Array {
  const v = new Float32Array(DIM);
  const rad = (deg * Math.PI) / 180;
  v[axis] = Math.cos(rad);
  v[axis + 1] = Math.sin(rad);
  return v;
}

function seed(name: string, type: string, deg: number, obs: string[] = ['claim text'], axis = 5): number {
  const db = getDatabase();
  db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(name, type);
  const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
  for (const o of obs) {
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, o);
  }
  db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
    BigInt(id),
    Buffer.from(unitVec(axis, deg).buffer),
  );
  return id;
}

afterEach(() => {
  callLLMMock.mockReset();
});

describe('judgeConflicts', () => {
  it('UNRELATED is remembered in conflict_judged_pairs and stages nothing — and is never re-bought', async () => {
    seed('decision-a', 'decision', 0, ['use tabs']);
    seed('decision-b', 'decision', 10, ['tab bar colours']);
    callLLMMock.mockResolvedValue('{"verdict":"UNRELATED","rationale":"different subjects"}');

    const r = await judgeConflicts(getDatabase(), LLM);
    expect(r.judged).toBe(1);
    expect(r.unrelated).toBe(1);
    expect(r.staged).toBe(0);
    expect(listProposals(getDatabase(), 'pending')).toHaveLength(0);

    // Next run: the pair is excluded at the candidate layer — zero LLM spend.
    callLLMMock.mockClear();
    const r2 = await judgeConflicts(getDatabase(), LLM);
    expect(r2.candidatesAvailable).toBe(0);
    expect(callLLMMock).not.toHaveBeenCalled();
  });

  it('CONTRADICTS stages a kind=relation proposal; accepting it creates the relation and archives nothing', async () => {
    const a = seed('retry-forever', 'decision', 0, ['always retry with backoff']);
    const b = seed('retry-never', 'decision', 10, ['never retry, fail fast']);
    callLLMMock.mockResolvedValue(JSON.stringify({
      verdict: 'CONTRADICTS',
      rationale: 'opposite retry policies for the same client',
      severity: 'high',
      recommended_action: 'decide which policy stands and archive the other',
      excerpts: { a: 'always retry', b: 'never retry' },
    }));

    const r = await judgeConflicts(getDatabase(), LLM);
    expect(r.staged).toBe(1);

    const pending = listProposals(getDatabase(), 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('relation');
    expect(pending[0].digest_name).toContain('retry-forever');
    expect(pending[0].digest_name).toContain('retry-never');

    const detail = getProposalDetail(getDatabase(), pending[0].id);
    expect(detail?.kind).toBe('relation');
    expect((detail?.relation as { severity: string }).severity).toBe('high');

    const db = getDatabase();
    const before = (db.prepare('SELECT count(*) AS c FROM entities').get() as { c: number }).c;
    const applied = applyProposal(db, pending[0].id, {
      createEntity: () => { throw new Error('a relation proposal must not create entities'); },
    });
    expect(applied.kind).toBe('relation');
    expect(applied.sourcesArchived).toBe(0);
    const after = (db.prepare('SELECT count(*) AS c FROM entities').get() as { c: number }).c;
    expect(after).toBe(before);

    const rel = db.prepare(
      "SELECT from_entity_id AS f, to_entity_id AS t FROM relations WHERE relation_type = 'contradicts'",
    ).get() as { f: number; t: number };
    expect([rel.f, rel.t].sort()).toEqual([a, b].sort());

    // The relation itself now excludes the pair at the candidate layer.
    expect(findConflictCandidates(db)).toHaveLength(0);
  });

  it('SUPERSEDES honours the survivor direction: b_supersedes_a points b → a', async () => {
    const a = seed('threshold-old', 'fact', 0, ['cutoff is 1.30']);
    const b = seed('threshold-new', 'fact', 10, ['cutoff re-measured to 1.00, replacing 1.30']);
    callLLMMock.mockResolvedValue(JSON.stringify({
      verdict: 'SUPERSEDES',
      direction: 'b_supersedes_a',
      rationale: 'B is the re-measured value replacing A',
      severity: 'medium',
      recommended_action: 'accept and archive A',
      excerpts: { a: '1.30', b: '1.00' },
    }));

    await judgeConflicts(getDatabase(), LLM);
    const pending = listProposals(getDatabase(), 'pending');
    applyProposal(getDatabase(), pending[0].id, { createEntity: () => 0 });

    const rel = getDatabase().prepare(
      "SELECT from_entity_id AS f, to_entity_id AS t FROM relations WHERE relation_type = 'supersedes'",
    ).get() as { f: number; t: number };
    expect(rel.f).toBe(b);
    expect(rel.t).toBe(a);
  });

  it('a SUPERSEDES verdict with no direction is a parse failure, not a coin flip', async () => {
    seed('x1', 'fact', 0);
    seed('x2', 'fact', 10);
    callLLMMock.mockResolvedValue('{"verdict":"SUPERSEDES","rationale":"newer"}');

    const r = await judgeConflicts(getDatabase(), LLM);
    expect(r.llmFailures).toBe(1);
    expect(r.judged).toBe(0);
    expect(getDatabase().prepare('SELECT count(*) AS c FROM conflict_judged_pairs').get()).toEqual({ c: 0 });
  });

  it('garbage output is a failure and the pair returns as a candidate — never a silent UNRELATED', async () => {
    seed('g1', 'fact', 0);
    seed('g2', 'fact', 10);
    callLLMMock.mockResolvedValue('I think these are probably fine, no JSON for you');

    const r = await judgeConflicts(getDatabase(), LLM);
    expect(r.llmFailures).toBe(1);
    expect(r.judged).toBe(0);
    // Unjudged = re-buyable: the pair must still be a candidate next run.
    expect(findConflictCandidates(getDatabase())).toHaveLength(1);
  });

  it('rejecting a relation proposal keeps the pair judged, so it is not re-bought either', async () => {
    seed('r1', 'decision', 0);
    seed('r2', 'decision', 10);
    callLLMMock.mockResolvedValue(JSON.stringify({
      verdict: 'DUPLICATE',
      rationale: 'same claim twice',
      severity: 'low',
      recommended_action: 'merge',
      excerpts: { a: 'x', b: 'x' },
    }));

    await judgeConflicts(getDatabase(), LLM);
    const pending = listProposals(getDatabase(), 'pending');
    expect(pending[0].kind).toBe('relation');
    rejectProposal(getDatabase(), pending[0].id, 'not actually duplicates');

    expect(getDatabase().prepare(
      "SELECT count(*) AS c FROM relations WHERE relation_type = 'duplicates'",
    ).get()).toEqual({ c: 0 });
    expect(findConflictCandidates(getDatabase())).toHaveLength(0); // judged_pairs still excludes
  });

  it('dry-run counts candidates without calling the LLM or writing anything', async () => {
    seed('d1', 'fact', 0);
    seed('d2', 'fact', 10);

    const r = await judgeConflicts(getDatabase(), LLM, { dryRun: true });
    expect(r.candidatesAvailable).toBe(1);
    expect(r.llmCalls).toBe(0);
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(getDatabase().prepare('SELECT count(*) AS c FROM conflict_judged_pairs').get()).toEqual({ c: 0 });
  });

  it('maxPairs caps LLM spend at the tightest pairs', async () => {
    // Two independent pairs on far-apart axes; cap at 1 → one call only.
    seed('p1a', 'fact', 0, ['claim'], 5);
    seed('p1b', 'fact', 4, ['claim'], 5);   // tighter pair
    seed('p2a', 'fact', 0, ['claim'], 100);
    seed('p2b', 'fact', 20, ['claim'], 100); // looser pair
    callLLMMock.mockResolvedValue('{"verdict":"UNRELATED","rationale":"no"}');

    const r = await judgeConflicts(getDatabase(), LLM, { maxPairs: 1 });
    expect(r.llmCalls).toBe(1);
    expect(r.candidatesAvailable).toBe(2);
    expect(r.judged).toBe(1);
  });

  it('a relation proposal whose endpoint has since been archived refuses to apply', async () => {
    const a = seed('gone-soon', 'decision', 0);
    seed('stays', 'decision', 10);
    callLLMMock.mockResolvedValue(JSON.stringify({
      verdict: 'CONTRADICTS', rationale: 'x', severity: 'low',
      recommended_action: 'x', excerpts: { a: 'x', b: 'y' },
    }));
    await judgeConflicts(getDatabase(), LLM);
    const pending = listProposals(getDatabase(), 'pending');

    getDatabase().prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run(a);
    expect(() => applyProposal(getDatabase(), pending[0].id, { createEntity: () => 0 }))
      .toThrow(/no longer active/);
    // Refused loudly AND left pending — nothing half-applied.
    expect(listProposals(getDatabase(), 'pending')).toHaveLength(1);
  });
});
