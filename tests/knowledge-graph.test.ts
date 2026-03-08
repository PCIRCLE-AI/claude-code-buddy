import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import type { CreateEntityInput } from '../src/knowledge-graph.js';
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
  });

  describe('Forget (Delete)', () => {
    it('should cascade delete entity, observations, relations, tags, and FTS', () => {
      kg.createEntity('ToDelete', 'test', {
        observations: ['some observation'],
        tags: ['sometag'],
      });
      kg.createEntity('Related', 'test');
      kg.createRelation('ToDelete', 'Related', 'links-to');

      const result = kg.deleteEntity('ToDelete');
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
      const result = kg.deleteEntity('DoesNotExist');
      expect(result).toEqual({ deleted: false });
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
});
