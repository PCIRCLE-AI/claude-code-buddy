import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import type { CreateEntityInput } from '../src/knowledge-graph.js';
import { getEmbeddingDimension } from '../src/core/config.js';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Feature: Knowledge Graph', () => {
  let testDir: string;
  let testDbPath: string;
  let db: Database.Database;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `memesh-kg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    testDbPath = path.join(testDir, 'test.db');
    db = openDatabase(testDbPath);
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {}
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Remember (Create)', () => {
    it('should create a new entity with created_at', () => {
      const id = kg.createEntity('TypeScript', 'language');
      expect(id).toBeGreaterThan(0);

      const entity = kg.getEntity('TypeScript');
      expect(entity).not.toBeNull();
      expect(entity!.name).toBe('TypeScript');
      expect(entity!.type).toBe('language');
      expect(entity!.created_at).toBeDefined();
    });

    it('should create entity with observations', () => {
      kg.createEntity('TypeScript', 'language', {
        observations: ['Superset of JavaScript', 'Has static typing'],
      });

      const entity = kg.getEntity('TypeScript');
      expect(entity!.observations).toHaveLength(2);
      expect(entity!.observations).toContain('Superset of JavaScript');
      expect(entity!.observations).toContain('Has static typing');
    });

    it('should create entity with tags', () => {
      kg.createEntity('TypeScript', 'language', {
        tags: ['programming', 'frontend'],
      });

      const entity = kg.getEntity('TypeScript');
      expect(entity!.tags).toHaveLength(2);
      expect(entity!.tags).toContain('programming');
      expect(entity!.tags).toContain('frontend');
    });

    it('should create entity with relations that are queryable', () => {
      kg.createEntity('TypeScript', 'language');
      kg.createEntity('JavaScript', 'language');
      kg.createRelation('TypeScript', 'JavaScript', 'extends');

      const entity = kg.getEntity('TypeScript');
      expect(entity!.relations).toBeDefined();
      expect(entity!.relations).toHaveLength(1);
      expect(entity!.relations![0]).toEqual({
        from: 'TypeScript',
        to: 'JavaScript',
        type: 'extends',
        metadata: undefined,
      });
    });

    it('should append observations on duplicate entity (upsert)', () => {
      kg.createEntity('TypeScript', 'language', {
        observations: ['First observation'],
      });
      kg.createEntity('TypeScript', 'language', {
        observations: ['Second observation'],
      });

      const entity = kg.getEntity('TypeScript');
      expect(entity!.observations).toHaveLength(2);
      expect(entity!.observations).toContain('First observation');
      expect(entity!.observations).toContain('Second observation');
    });

    it('should dedupe tags and preserve original type on duplicate entity', () => {
      kg.createEntity('TypeScript', 'language', {
        tags: ['frontend'],
      });
      kg.createEntity('TypeScript', 'runtime', {
        tags: ['frontend', 'typed'],
      });

      const entity = kg.getEntity('TypeScript');
      expect(entity!.type).toBe('language');
      expect([...entity!.tags].sort()).toEqual(['frontend', 'typed']);
    });

    it('should batch create all entities in single transaction', () => {
      const entities: CreateEntityInput[] = [
        {
          name: 'Entity1',
          type: 'test',
          observations: ['obs1'],
          tags: ['tag1'],
        },
        {
          name: 'Entity2',
          type: 'test',
          observations: ['obs2'],
          tags: ['tag2'],
        },
        {
          name: 'Entity3',
          type: 'test',
          observations: ['obs3'],
        },
      ];

      kg.createEntitiesBatch(entities);

      expect(kg.getEntity('Entity1')).not.toBeNull();
      expect(kg.getEntity('Entity2')).not.toBeNull();
      expect(kg.getEntity('Entity3')).not.toBeNull();
      expect(kg.getEntity('Entity1')!.observations).toEqual(['obs1']);
      expect(kg.getEntity('Entity2')!.tags).toEqual(['tag2']);
    });
  });

  describe('Recall (Search)', () => {
    it('should search by keyword via FTS5 and find entity by observation content', () => {
      kg.createEntity('React', 'framework', {
        observations: ['A library for building user interfaces'],
      });
      kg.createEntity('Vue', 'framework', {
        observations: ['A progressive JavaScript framework'],
      });

      const results = kg.search('interfaces');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('React');
    });

    it('should filter search results by tag', () => {
      kg.createEntity('React', 'framework', {
        observations: ['Uses virtual DOM'],
        tags: ['frontend'],
      });
      kg.createEntity('Express', 'framework', {
        observations: ['Uses middleware pattern with virtual routing'],
        tags: ['backend'],
      });

      const results = kg.search('virtual', { tag: 'frontend' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('React');
    });

    it('should apply limit after tag filtering', () => {
      kg.createEntity('TaggedOne', 'framework', {
        observations: ['shared query terms'],
        tags: ['frontend'],
      });
      kg.createEntity('TaggedTwo', 'framework', {
        observations: ['shared query terms'],
        tags: ['frontend'],
      });
      kg.createEntity('UntaggedLatestOne', 'framework', {
        observations: ['shared query terms'],
      });
      kg.createEntity('UntaggedLatestTwo', 'framework', {
        observations: ['shared query terms'],
      });

      const results = kg.search('shared query terms', {
        tag: 'frontend',
        limit: 2,
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).sort()).toEqual([
        'TaggedOne',
        'TaggedTwo',
      ]);
    });

    it('should return related entities via getEntity', () => {
      kg.createEntity('React', 'framework', {
        observations: ['Component-based UI library'],
      });
      kg.createEntity('Redux', 'library', {
        observations: ['State management for React'],
      });
      kg.createRelation('React', 'Redux', 'uses');

      const entity = kg.getEntity('React');
      expect(entity!.relations).toBeDefined();
      expect(entity!.relations![0].to).toBe('Redux');
    });

    it('should return empty array when no results match', () => {
      kg.createEntity('React', 'framework', {
        observations: ['A UI library'],
      });

      const results = kg.search('nonexistentterm');
      expect(results).toEqual([]);
    });

    it('should list recent entities ordered by created_at DESC', () => {
      kg.createEntity('First', 'test');
      kg.createEntity('Second', 'test');
      kg.createEntity('Third', 'test');

      const recent = kg.listRecent(2);
      expect(recent).toHaveLength(2);
      // Most recent first
      expect(recent[0].name).toBe('Third');
      expect(recent[1].name).toBe('Second');
    });

    it('should return listRecent when search query is empty', () => {
      kg.createEntity('Alpha', 'test');
      kg.createEntity('Beta', 'test');

      const results = kg.search('');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Should be ordered by created_at DESC
      expect(results[0].name).toBe('Beta');
      expect(results[1].name).toBe('Alpha');
    });

    it('should filter recent results by tag when no query is provided', () => {
      kg.createEntity('Alpha', 'test', {
        tags: ['project:a'],
      });
      kg.createEntity('Beta', 'test', {
        tags: ['project:b'],
      });
      kg.createEntity('Gamma', 'test', {
        tags: ['project:a'],
      });

      const results = kg.search(undefined, { tag: 'project:a', limit: 5 });

      expect(results.map((r) => r.name)).toEqual(['Gamma', 'Alpha']);
    });
  });

  describe('Archive (Soft Forget)', () => {
    it('should archive entity without deleting data', () => {
      kg.createEntity('OldDesign', 'decision', {
        observations: ['Use REST API'],
        tags: ['project:x'],
      });

      const result = kg.archiveEntity('OldDesign');
      expect(result).toEqual({ archived: true, name: 'OldDesign', previousStatus: 'active' });

      // Entity still in DB with all data
      const row = db.prepare("SELECT status FROM entities WHERE name = ?").get('OldDesign') as any;
      expect(row.status).toBe('archived');

      const entity = kg.getEntity('OldDesign');
      expect(entity).not.toBeNull();
      expect(entity!.observations).toContain('Use REST API');
      expect(entity!.tags).toContain('project:x');
    });

    it('should remove archived entity from FTS5 index', () => {
      kg.createEntity('OldDesign', 'decision', {
        observations: ['Use REST API'],
      });

      kg.archiveEntity('OldDesign');

      const results = kg.search('REST');
      expect(results).toEqual([]);
    });

    it('should remove archived entity from vector index', () => {
      const id = kg.createEntity('OldDesign', 'decision', {
        observations: ['Use REST API'],
      });
      const embedding = new Float32Array(getEmbeddingDimension());
      embedding.fill(0.01);
      embedding[0] = 1;

      db.prepare(
        'INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)'
      ).run(BigInt(id), Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));

      kg.archiveEntity('OldDesign');

      const count = db.prepare('SELECT count(*) AS count FROM entities_vec').get() as { count: number };
      expect(count.count).toBe(0);
    });

    it('should return { archived: false } for non-existent entity', () => {
      const result = kg.archiveEntity('Ghost');
      expect(result).toEqual({ archived: false });
    });
  });

  describe('Forget (Delete)', () => {
    it('should cascade delete entity, observations, relations, tags, and FTS', () => {
      kg.createEntity('ToDelete', 'test', {
        observations: ['some observation'],
        tags: ['sometag'],
      });
      kg.createEntity('Related', 'test');
      kg.createRelation('ToDelete', 'Related', 'links-to');

      const result = (kg as any).deleteEntity('ToDelete');
      expect(result).toEqual({ deleted: true });

      // Entity gone
      expect(kg.getEntity('ToDelete')).toBeNull();

      // Observations gone (via CASCADE)
      const obs = db
        .prepare(
          "SELECT COUNT(*) as c FROM observations WHERE entity_id NOT IN (SELECT id FROM entities)"
        )
        .get() as any;
      expect(obs.c).toBe(0);

      // Tags gone (via CASCADE)
      const tags = db
        .prepare(
          "SELECT COUNT(*) as c FROM tags WHERE entity_id NOT IN (SELECT id FROM entities)"
        )
        .get() as any;
      expect(tags.c).toBe(0);

      // FTS gone
      const fts = db
        .prepare("SELECT COUNT(*) as c FROM entities_fts WHERE name = 'ToDelete'")
        .get() as any;
      expect(fts.c).toBe(0);

      // Relation gone (via CASCADE on from_entity_id)
      const rels = db
        .prepare('SELECT COUNT(*) as c FROM relations')
        .get() as any;
      expect(rels.c).toBe(0);
    });

    it('should return { deleted: false } for non-existent entity', () => {
      const result = (kg as any).deleteEntity('DoesNotExist');
      expect(result).toEqual({ deleted: false });
    });
  });

  describe('Observation-level forget', () => {
    it('should remove a specific observation and rebuild FTS', () => {
      kg.createEntity('Design', 'decision', {
        observations: ['Use JWT', 'Use RS256', 'Rotate keys'],
      });

      const result = kg.removeObservation('Design', 'Use JWT');
      expect(result).toEqual({ removed: true, remainingObservations: 2 });

      const entity = kg.getEntity('Design');
      expect(entity!.observations).toEqual(['Use RS256', 'Rotate keys']);

      // FTS should find "RS256" but not "JWT"
      expect(kg.search('RS256')).toHaveLength(1);
      expect(kg.search('JWT')).toEqual([]);
    });

    it('should return removed:false for non-matching observation', () => {
      kg.createEntity('Design', 'decision', {
        observations: ['Use JWT'],
      });

      const result = kg.removeObservation('Design', 'nonexistent');
      expect(result).toEqual({ removed: false, remainingObservations: 1 });
    });

    it('should return removed:false for non-existent entity', () => {
      const result = kg.removeObservation('Ghost', 'anything');
      expect(result).toEqual({ removed: false, remainingObservations: 0 });
    });
  });

  describe('Reactivation via Remember', () => {
    it('should reactivate archived entity when remembered again', () => {
      kg.createEntity('OldDesign', 'decision', {
        observations: ['Use REST'],
      });
      kg.archiveEntity('OldDesign');

      // Verify archived in DB
      const archivedRow = db.prepare("SELECT status FROM entities WHERE name = 'OldDesign'").get() as any;
      expect(archivedRow.status).toBe('archived');

      // Remember again — should reactivate
      kg.createEntity('OldDesign', 'decision', {
        observations: ['Use GraphQL'],
      });

      // Verify reactivated
      const reactivatedRow = db.prepare("SELECT status FROM entities WHERE name = 'OldDesign'").get() as any;
      expect(reactivatedRow.status).toBe('active');

      // Observations appended
      const entity = kg.getEntity('OldDesign');
      expect(entity!.observations).toContain('Use REST');
      expect(entity!.observations).toContain('Use GraphQL');

      // FTS5 rebuilt — searchable again
      expect(kg.search('REST')).toHaveLength(1);
      expect(kg.search('GraphQL')).toHaveLength(1);
    });
  });

  describe('Recall respects archive status', () => {
    beforeEach(() => {
      kg.createEntity('Active1', 'test', { observations: ['shared term'] });
      kg.createEntity('Active2', 'test', { observations: ['shared term'] });
      kg.createEntity('Archived1', 'test', { observations: ['shared term'] });
      kg.archiveEntity('Archived1');
    });

    it('should exclude archived entities from search by default', () => {
      const results = kg.search('shared');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).sort()).toEqual(['Active1', 'Active2']);
    });

    it('should include archived entities when includeArchived is true', () => {
      const results = kg.search('shared', { includeArchived: true });
      expect(results).toHaveLength(3);
    });

    it('should exclude archived from listRecent by default', () => {
      const results = kg.listRecent();
      expect(results).toHaveLength(2);
    });

    it('should include archived in listRecent when includeArchived is true', () => {
      const results = kg.listRecent(20, true);
      expect(results).toHaveLength(3);
    });

    it('should mark archived entities with archived:true in response', () => {
      const results = kg.search('shared', { includeArchived: true });
      const archived = results.find((e) => e.name === 'Archived1');
      expect(archived?.archived).toBe(true);

      const active = results.find((e) => e.name === 'Active1');
      expect(active?.archived).toBeUndefined();
    });
  });

  describe('Access Tracking', () => {
    it('should increment access_count on search', () => {
      kg.createEntity('Test', 'note', { observations: ['some data'] });

      // Before search
      const before = kg.getEntity('Test');
      expect(before!.access_count).toBe(0);

      // Search (triggers trackAccess)
      kg.search('data');

      // After search
      const after = kg.getEntity('Test');
      expect(after!.access_count).toBe(1);
      expect(after!.last_accessed_at).toBeDefined();
    });

    it('should increment on each recall', () => {
      kg.createEntity('Multi', 'note', { observations: ['test data'] });
      kg.search('test');
      kg.search('test');
      kg.search('test');

      const entity = kg.getEntity('Multi');
      expect(entity!.access_count).toBe(3);
    });

    it('should increment access_count on listRecent', () => {
      kg.createEntity('RecentEntity', 'note', { observations: ['content'] });

      const before = kg.getEntity('RecentEntity');
      expect(before!.access_count).toBe(0);

      kg.listRecent();

      const after = kg.getEntity('RecentEntity');
      expect(after!.access_count).toBe(1);
    });

    it('should increment access_count when search falls back to listRecent (empty query)', () => {
      kg.createEntity('FallbackTest', 'note', { observations: ['data'] });

      kg.search('');

      const entity = kg.getEntity('FallbackTest');
      expect(entity!.access_count).toBe(1);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect contradicting entities', () => {
      kg.createEntity('use-jwt', 'decision', { observations: ['Always use JWT'] });
      kg.createEntity('no-jwt', 'decision', { observations: ['Never use JWT'] });
      kg.createRelation('no-jwt', 'use-jwt', 'contradicts');

      const conflicts = kg.findConflicts(['use-jwt', 'no-jwt']);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('contradicts');
    });

    it('should return empty for non-conflicting entities', () => {
      kg.createEntity('a', 'note');
      kg.createEntity('b', 'note');

      const conflicts = kg.findConflicts(['a', 'b']);
      expect(conflicts).toEqual([]);
    });

    it('should handle single entity', () => {
      expect(kg.findConflicts(['a'])).toEqual([]);
    });

    it('should handle empty array', () => {
      expect(kg.findConflicts([])).toEqual([]);
    });

    it('should not flag non-contradicts relations as conflicts', () => {
      kg.createEntity('ParentA', 'decision');
      kg.createEntity('ChildB', 'decision');
      kg.createRelation('ParentA', 'ChildB', 'relates-to');

      const conflicts = kg.findConflicts(['ParentA', 'ChildB']);
      expect(conflicts).toEqual([]);
    });

    it('should detect both directions of contradicts', () => {
      kg.createEntity('X', 'decision', { observations: ['prefer X'] });
      kg.createEntity('Y', 'decision', { observations: ['prefer Y'] });
      kg.createEntity('Z', 'decision', { observations: ['prefer Z'] });
      kg.createRelation('X', 'Y', 'contradicts');
      kg.createRelation('Z', 'Y', 'contradicts');

      const conflicts = kg.findConflicts(['X', 'Y', 'Z']);
      expect(conflicts).toHaveLength(2);
      expect(conflicts.some((c) => c.includes('"X" contradicts "Y"'))).toBe(true);
      expect(conflicts.some((c) => c.includes('"Z" contradicts "Y"'))).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should throw when creating relation with non-existent entity', () => {
      kg.createEntity('Exists', 'test');
      expect(() => kg.createRelation('Exists', 'Ghost', 'links')).toThrow(
        'Entity not found: Ghost'
      );
      expect(() => kg.createRelation('Ghost', 'Exists', 'links')).toThrow(
        'Entity not found: Ghost'
      );
    });

    it('should handle entity with metadata', () => {
      kg.createEntity('WithMeta', 'test', {
        metadata: { version: '1.0', priority: 'high' },
      });

      const entity = kg.getEntity('WithMeta');
      expect(entity!.metadata).toEqual({ version: '1.0', priority: 'high' });
    });

    it('should handle relation with metadata', () => {
      kg.createEntity('A', 'test');
      kg.createEntity('B', 'test');
      kg.createRelation('A', 'B', 'depends-on', { weight: 0.8 });

      const relations = kg.getRelations('A');
      expect(relations[0].metadata).toEqual({ weight: 0.8 });
    });

    it('should search by entity name via FTS', () => {
      kg.createEntity('UniqueProjectName', 'project', {
        observations: ['A special project'],
      });

      const results = kg.search('UniqueProjectName');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('UniqueProjectName');
    });
  });

  describe('Namespace', () => {
    it('should create entity with explicit namespace', () => {
      kg.createEntity('team-pattern', 'pattern', { namespace: 'team' });
      const entity = kg.getEntity('team-pattern');
      expect(entity).not.toBeNull();
      expect(entity!.namespace).toBe('team');
    });

    it('should default to personal namespace when not specified', () => {
      kg.createEntity('my-note', 'note');
      const entity = kg.getEntity('my-note');
      expect(entity).not.toBeNull();
      expect(entity!.namespace).toBe('personal');
    });

    it('should create entity with global namespace', () => {
      kg.createEntity('global-rule', 'rule', { namespace: 'global' });
      const entity = kg.getEntity('global-rule');
      expect(entity!.namespace).toBe('global');
    });

    it('should filter search results by namespace', () => {
      kg.createEntity('personal-note', 'note', {
        observations: ['personal data'],
        namespace: 'personal',
      });
      kg.createEntity('team-note', 'note', {
        observations: ['team data'],
        namespace: 'team',
      });

      const personalResults = kg.search('data', { namespace: 'personal' });
      expect(personalResults).toHaveLength(1);
      expect(personalResults[0].name).toBe('personal-note');

      const teamResults = kg.search('data', { namespace: 'team' });
      expect(teamResults).toHaveLength(1);
      expect(teamResults[0].name).toBe('team-note');
    });

    it('should return all namespaces when namespace filter is omitted', () => {
      kg.createEntity('note-a', 'note', {
        observations: ['shared query'],
        namespace: 'personal',
      });
      kg.createEntity('note-b', 'note', {
        observations: ['shared query'],
        namespace: 'team',
      });

      const allResults = kg.search('shared query');
      expect(allResults.length).toBeGreaterThanOrEqual(2);
      const names = allResults.map((e) => e.name);
      expect(names).toContain('note-a');
      expect(names).toContain('note-b');
    });

    it('should filter listRecent by namespace', () => {
      kg.createEntity('personal-entity', 'note', { namespace: 'personal' });
      kg.createEntity('team-entity', 'note', { namespace: 'team' });

      const personalList = kg.listRecent(10, false, 'personal');
      const names = personalList.map((e) => e.name);
      expect(names).toContain('personal-entity');
      expect(names).not.toContain('team-entity');
    });

    it('should filter tag-based search by namespace', () => {
      kg.createEntity('tagged-personal', 'note', {
        observations: ['tagged content'],
        tags: ['shared-tag'],
        namespace: 'personal',
      });
      kg.createEntity('tagged-team', 'note', {
        observations: ['tagged content'],
        tags: ['shared-tag'],
        namespace: 'team',
      });

      const personalTagResults = kg.search('tagged content', {
        tag: 'shared-tag',
        namespace: 'personal',
      });
      expect(personalTagResults).toHaveLength(1);
      expect(personalTagResults[0].name).toBe('tagged-personal');
    });

    it('should not change namespace of existing entity on re-remember', () => {
      kg.createEntity('stable-entity', 'note', { namespace: 'team' });
      // Re-create with different namespace — INSERT OR IGNORE means namespace stays unchanged
      kg.createEntity('stable-entity', 'note', {
        observations: ['new obs'],
        namespace: 'personal',
      });
      const entity = kg.getEntity('stable-entity');
      expect(entity!.namespace).toBe('team');
      expect(entity!.observations).toContain('new obs');
    });
  });
});
