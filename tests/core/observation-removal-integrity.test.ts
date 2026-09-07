import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

const require = createRequire(import.meta.url);
let dir: string;
let db: ReturnType<typeof openDatabase>;
let kg: KnowledgeGraph;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-observation-integrity-'));
  db = openDatabase(path.join(dir, 'graph.db'));
  db.enableLoadExtension(true);
  try { require('sqlite-vec').load(db); } finally { db.enableLoadExtension(false); }
  db.exec('DROP TABLE IF EXISTS entities_vec');
  db.exec('CREATE VIRTUAL TABLE entities_vec USING vec0(embedding float[3])');
  kg = new KnowledgeGraph(db);
  kg.createEntity('edited', 'note', { title: 'gazelle title', observations: ['obsolete quokka', 'retained wombat'] });
  kg.createEntity('untouched', 'note', { observations: ['independent ibex'] });
  for (const name of ['edited', 'untouched']) {
    const id = kg.getEntity(name)!.id;
    db.prepare('INSERT INTO entities_vec(rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), Buffer.from(new Float32Array([1, 0, 0]).buffer));
  }
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function vectorIds(): number[] {
  return (db.prepare('SELECT rowid AS id FROM entities_vec ORDER BY rowid').all() as { id: number }[])
    .map(row => row.id);
}

function failingGraph(failOn: RegExp): KnowledgeGraph {
  return new KnowledgeGraph(new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        if (failOn.test(sql)) throw new Error('injected index failure');
        return target.prepare(sql);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }));
}

describe('observation removal integrity', () => {
  it('invalidates only the obsolete vector and keeps remaining text searchable', () => {
    expect(vectorIds()).toHaveLength(2);
    expect(kg.removeObservation('edited', 'obsolete quokka')).toEqual({
      removed: true, remainingObservations: 1, entityFound: true,
    });
    expect(kg.getEntity('edited')!.observations).toEqual(['retained wombat']);
    expect(kg.search('quokka')).toEqual([]);
    expect(kg.search('wombat').map(e => e.name)).toEqual(['edited']);
    expect(kg.search('gazelle').map(e => e.name)).toEqual(['edited']);
    expect(kg.search('ibex').map(e => e.name)).toEqual(['untouched']);
    expect(vectorIds()).toEqual([kg.getEntity('untouched')!.id]);
  });

  it.each([
    ['FTS rebuild', /INSERT INTO entities_fts \(rowid/],
    ['vector deletion', /DELETE FROM entities_vec/],
  ])('rolls back observations and both indexes on %s failure', (_label, failOn) => {
    const before = kg.getEntity('edited')!.observations;
    const beforeVectors = vectorIds();
    expect(() => failingGraph(failOn).removeObservation('edited', 'obsolete quokka'))
      .toThrow('injected index failure');
    expect(kg.getEntity('edited')!.observations).toEqual(before);
    expect(kg.search('quokka').map(e => e.name)).toEqual(['edited']);
    expect(kg.search('wombat').map(e => e.name)).toEqual(['edited']);
    expect(vectorIds()).toEqual(beforeVectors);
  });

  it('does not touch indexes when the observation or entity is missing', () => {
    const graph = failingGraph(/INSERT INTO entities_fts|DELETE FROM entities_vec/);
    expect(graph.removeObservation('edited', 'absent')).toEqual({
      removed: false, remainingObservations: 2, entityFound: true,
    });
    expect(graph.removeObservation('missing', 'absent')).toEqual({
      removed: false, remainingObservations: 0, entityFound: false,
    });
    expect(vectorIds()).toHaveLength(2);
    expect(kg.search('quokka').map(e => e.name)).toEqual(['edited']);
  });

  it('removes the final observation but preserves the entity title', () => {
    kg.removeObservation('edited', 'obsolete quokka');
    expect(kg.removeObservation('edited', 'retained wombat')).toEqual({
      removed: true, remainingObservations: 0, entityFound: true,
    });
    expect(kg.getEntity('edited')!.observations).toEqual([]);
    expect(kg.search('wombat')).toEqual([]);
    expect(kg.search('gazelle').map(e => e.name)).toEqual(['edited']);
    expect(vectorIds()).toEqual([kg.getEntity('untouched')!.id]);
  });

  it('works without the optional vector table', () => {
    db.exec('DROP TABLE entities_vec');
    expect(kg.removeObservation('edited', 'obsolete quokka').removed).toBe(true);
    expect(kg.search('quokka')).toEqual([]);
    expect(kg.search('wombat').map(e => e.name)).toEqual(['edited']);
  });

  it('does not reindex an archived entity', () => {
    const id = kg.getEntity('edited')!.id;
    kg.archiveEntity('edited');
    expect(db.prepare('SELECT rowid FROM entities_fts WHERE rowid = ?').all(id)).toEqual([]);
    expect(kg.removeObservation('edited', 'obsolete quokka').removed).toBe(true);
    expect(db.prepare('SELECT rowid FROM entities_fts WHERE rowid = ?').all(id)).toEqual([]);
    expect(db.prepare('SELECT status FROM entities WHERE name = ?').get('edited'))
      .toMatchObject({ status: 'archived' });
    expect(kg.search('wombat')).toEqual([]);
    expect(vectorIds()).toEqual([kg.getEntity('untouched')!.id]);
  });
});
