import { describe, it, expect } from 'vitest';
import { remember } from '../../src/core/operations.js';
import { getDatabase } from '../../src/db.js';
import { listProjectTags, renameProjectTag } from '../../src/core/project-tags.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-projtags-');

function projectTagsOf(name: string): string[] {
  const row = getDatabase().prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) return [];
  return (getDatabase().prepare("SELECT tag FROM tags WHERE entity_id = ? AND tag LIKE 'project:%'").all(row.id) as Array<{ tag: string }>).map(r => r.tag);
}

describe('project-tags: listProjectTags', () => {
  it('returns each project value with its entity count, most-used first', () => {
    remember({ name: 'a', type: 'note', tags: ['project:TIM'] });
    remember({ name: 'b', type: 'note', tags: ['project:TIM'] });
    remember({ name: 'c', type: 'note', tags: ['project:memesh'] });
    const tags = listProjectTags();
    expect(tags[0]).toEqual({ project: 'TIM', count: 2 });
    expect(tags).toContainEqual({ project: 'memesh', count: 1 });
  });
});

describe('project-tags: renameProjectTag', () => {
  it('dry-run reports affected entities and writes nothing', () => {
    remember({ name: 'a', type: 'note', tags: ['project:tim'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: false });
    expect(r.affectedEntities).toBe(2);
    expect(r.renamed).toBe(2);
    expect(r.merged).toBe(0);
    expect(r.applied).toBe(false);
    // Unchanged on disk.
    expect(projectTagsOf('a')).toEqual(['project:tim']);
  });

  it('apply renames the tag across all carrying entities', () => {
    remember({ name: 'a', type: 'note', tags: ['project:tim'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: true });
    expect(r.applied).toBe(true);
    expect(r.renamed).toBe(2);
    expect(projectTagsOf('a')).toEqual(['project:TIM']);
    expect(projectTagsOf('b')).toEqual(['project:TIM']);
    expect(listProjectTags()).toEqual([{ project: 'TIM', count: 2 }]);
  });

  it('merges (not duplicates) when an entity already has the target tag — respects UNIQUE(entity_id, tag)', () => {
    // Entity carries BOTH the old and new tag (the split case).
    remember({ name: 'a', type: 'note', tags: ['project:tim', 'project:TIM'] });
    remember({ name: 'b', type: 'note', tags: ['project:tim'] });
    const r = renameProjectTag('tim', 'TIM', { apply: true });
    expect(r.affectedEntities).toBe(2);
    expect(r.merged).toBe(1);   // 'a' already had project:TIM → project:tim removed
    expect(r.renamed).toBe(1);  // 'b' renamed
    expect(projectTagsOf('a')).toEqual(['project:TIM']); // no duplicate
    expect(projectTagsOf('b')).toEqual(['project:TIM']);
  });

  it('no-op when nothing carries the from tag', () => {
    remember({ name: 'a', type: 'note', tags: ['project:other'] });
    const r = renameProjectTag('ghost', 'TIM', { apply: true });
    expect(r.affectedEntities).toBe(0);
    expect(projectTagsOf('a')).toEqual(['project:other']);
  });
});
