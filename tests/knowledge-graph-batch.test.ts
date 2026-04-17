import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, closeDatabase, getDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('KnowledgeGraph batch hydration', () => {
  let testDir: string;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-batch-test-'));
    process.env.MEMESH_DB_PATH = path.join(testDir, 'test.db');
    openDatabase();
    kg = new KnowledgeGraph(getDatabase());
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.MEMESH_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for empty ids', () => {
    expect(kg.getEntitiesByIds([])).toEqual([]);
  });

  it('hydrates multiple entities with observations and tags', () => {
    kg.createEntity('alpha', 'test', { observations: ['obs-a1', 'obs-a2'], tags: ['tag1'] });
    kg.createEntity('beta', 'test', { observations: ['obs-b1'], tags: ['tag2'] });
    kg.createEntity('gamma', 'test', { observations: ['obs-g1', 'obs-g2', 'obs-g3'] });

    const db = getDatabase();
    const alphaId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('alpha') as { id: number }).id;
    const betaId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('beta') as { id: number }).id;
    const gammaId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('gamma') as { id: number }).id;

    const results = kg.getEntitiesByIds([alphaId, betaId, gammaId]);

    expect(results).toHaveLength(3);
    expect(results.find(e => e.name === 'alpha')!.observations).toEqual(['obs-a1', 'obs-a2']);
    expect(results.find(e => e.name === 'alpha')!.tags).toEqual(['tag1']);
    expect(results.find(e => e.name === 'gamma')!.observations).toHaveLength(3);
  });

  it('preserves input order', () => {
    kg.createEntity('first', 'test', { observations: ['1'] });
    kg.createEntity('second', 'test', { observations: ['2'] });

    const db = getDatabase();
    const firstId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('first') as { id: number }).id;
    const secondId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('second') as { id: number }).id;

    const results = kg.getEntitiesByIds([secondId, firstId]);
    expect(results[0].name).toBe('second');
    expect(results[1].name).toBe('first');
  });

  it('skips non-existent ids', () => {
    kg.createEntity('exists', 'test', { observations: ['hi'] });
    const db = getDatabase();
    const existsId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('exists') as { id: number }).id;

    const results = kg.getEntitiesByIds([existsId, 99999]);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('exists');
  });

  it('includes relations in batch results', () => {
    kg.createEntity('source', 'test', { observations: ['src'] });
    kg.createEntity('target', 'test', { observations: ['tgt'] });
    kg.createRelation('source', 'target', 'related-to');

    const db = getDatabase();
    const sourceId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('source') as { id: number }).id;

    const results = kg.getEntitiesByIds([sourceId]);
    expect(results[0].relations).toBeDefined();
    expect(results[0].relations![0].to).toBe('target');
    expect(results[0].relations![0].type).toBe('related-to');
  });

  it('sets archived flag for archived entities', () => {
    kg.createEntity('old', 'test', { observations: ['data'] });
    kg.archiveEntity('old');

    const db = getDatabase();
    const oldId = (db.prepare('SELECT id FROM entities WHERE name = ?').get('old') as { id: number }).id;

    const results = kg.getEntitiesByIds([oldId]);
    expect(results[0].archived).toBe(true);
  });
});
