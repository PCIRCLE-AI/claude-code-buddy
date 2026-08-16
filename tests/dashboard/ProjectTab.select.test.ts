// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { selectProjectEntities } from '../../dashboard/src/components/ProjectTab';
import type { Entity } from '../../dashboard/src/lib/api';

/**
 * The readmission rule, pinned: `supersedes` archives its target on write,
 * so the archived loser must ride back in WITH the chain that points at it
 * — and ONLY then. Archived entities nothing points at stay out.
 */
function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: Math.floor(Math.random() * 100000),
    name: 'x',
    type: 'decision',
    created_at: '2026-04-15T00:00:00.000Z',
    observations: ['obs'],
    tags: ['project:myapp'],
    ...overrides,
  };
}

describe('selectProjectEntities — lineage-aware project filter', () => {
  it('no selection -> empty; active entities of the project only', () => {
    const a = makeEntity({ id: 1, name: 'a' });
    const other = makeEntity({ id: 2, name: 'b', tags: ['project:other'] });
    expect(selectProjectEntities([a, other], null)).toEqual([]);
    expect(selectProjectEntities([a, other], 'myapp').map((e) => e.name)).toEqual(['a']);
  });

  it('readmits the archived target of an active supersedes edge — and only that', () => {
    const winner = makeEntity({
      id: 1, name: 'db-choice-v2', created_at: '2026-05-01T00:00:00.000Z',
      relations: [{ from: 'db-choice-v2', to: 'db-choice-v1', type: 'supersedes' }],
    });
    const loser = makeEntity({
      id: 2, name: 'db-choice-v1', created_at: '2026-04-01T00:00:00.000Z', archived: true,
    });
    const unrelatedArchived = makeEntity({
      id: 3, name: 'old-noise', created_at: '2026-03-01T00:00:00.000Z', status: 'archived',
    });
    const names = selectProjectEntities([winner, loser, unrelatedArchived], 'myapp').map((e) => e.name);
    expect(names).toEqual(['db-choice-v2', 'db-choice-v1']);
    expect(names).not.toContain('old-noise');
  });

  it('contradicts targets ride in too — a conflict needs both ends visible', () => {
    const claim = makeEntity({
      id: 1, name: 'claim-a',
      relations: [{ from: 'claim-a', to: 'claim-b', type: 'contradicts' }],
    });
    const counter = makeEntity({ id: 2, name: 'claim-b', archived: true });
    expect(selectProjectEntities([claim, counter], 'myapp').map((e) => e.name)).toContain('claim-b');
  });

  it('an ARCHIVED entity with a supersedes edge does not readmit anything (only active edges count)', () => {
    const archivedPointer = makeEntity({
      id: 1, name: 'dead-winner', archived: true,
      relations: [{ from: 'dead-winner', to: 'dead-loser', type: 'supersedes' }],
    });
    const target = makeEntity({ id: 2, name: 'dead-loser', archived: true });
    expect(selectProjectEntities([archivedPointer, target], 'myapp')).toEqual([]);
  });
});
