import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { runAutoDecay, getDecayStatus } from '../../src/core/lifecycle.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-lifecycle-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Auto-Decay', () => {
  it('should decay stale entities after 30 days', () => {
    const db = getDatabase();

    // Create entity with old access time (60 days ago)
    db.prepare('INSERT INTO entities (name, type, confidence, last_accessed_at) VALUES (?, ?, ?, ?)')
      .run('old-entity', 'note', 1.0, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    // Force decay by clearing last_decay_at so the throttle does not block us
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    const result = runAutoDecay(db);
    expect(result.decayed).toBe(1);

    const entity = db.prepare('SELECT confidence FROM entities WHERE name = ?').get('old-entity') as any;
    expect(entity.confidence).toBeCloseTo(0.9, 2);
  });

  it('should NOT decay recently accessed entities', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence, last_accessed_at) VALUES (?, ?, ?, ?)')
      .run('fresh-entity', 'note', 1.0, new Date().toISOString());

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    const result = runAutoDecay(db);
    expect(result.decayed).toBe(0);

    const entity = db.prepare('SELECT confidence FROM entities WHERE name = ?').get('fresh-entity') as any;
    expect(entity.confidence).toBe(1.0);
  });

  it('should respect confidence floor of 0.01', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence, last_accessed_at) VALUES (?, ?, ?, ?)')
      .run('low-entity', 'note', 0.02, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    runAutoDecay(db);

    const entity = db.prepare('SELECT confidence FROM entities WHERE name = ?').get('low-entity') as any;
    expect(entity.confidence).toBeGreaterThanOrEqual(0.01);
  });

  it('should skip if last decay was less than 24h ago', () => {
    const db = getDatabase();

    // openDatabase() already ran decay and recorded last_decay_at.
    // Running again immediately should skip (throttle active).
    const result = runAutoDecay(db);
    expect(result.decayed).toBe(0);
  });

  it('should not decay archived entities', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence, last_accessed_at, status) VALUES (?, ?, ?, ?, ?)')
      .run('archived-entity', 'note', 1.0, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), 'archived');

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    runAutoDecay(db);

    const entity = db.prepare('SELECT confidence FROM entities WHERE name = ?').get('archived-entity') as any;
    expect(entity.confidence).toBe(1.0);
  });

  it('should decay entities with NULL last_accessed_at (never accessed)', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence) VALUES (?, ?, ?)')
      .run('never-accessed', 'note', 1.0);

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    const result = runAutoDecay(db);
    expect(result.decayed).toBe(1);

    const entity = db.prepare('SELECT confidence FROM entities WHERE name = ?').get('never-accessed') as any;
    expect(entity.confidence).toBeCloseTo(0.9, 2);
  });

  it('should not decay entity already at confidence floor', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence, last_accessed_at) VALUES (?, ?, ?, ?)')
      .run('floor-entity', 'note', 0.01, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    const result = runAutoDecay(db);
    // confidence = 0.01 which equals MIN_CONFIDENCE, so WHERE confidence > MIN_CONFIDENCE excludes it
    expect(result.decayed).toBe(0);
  });

  it('should update last_decay_at after running', () => {
    const db = getDatabase();

    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");

    const before = Date.now();
    runAutoDecay(db);
    const after = Date.now();

    const row = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get() as any;
    expect(row).not.toBeNull();
    const ts = new Date(row.value).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('Decay Status', () => {
  it('should report last decay time after openDatabase', () => {
    const db = getDatabase();
    const status = getDecayStatus(db);
    // openDatabase() runs decay, so last_decay_at should be set
    expect(status.lastDecayAt).not.toBeNull();
  });

  it('should report null lastDecayAt before any decay has run', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_decay_at'");
    const status = getDecayStatus(db);
    expect(status.lastDecayAt).toBeNull();
  });

  it('should count entities below confidence 0.5', () => {
    const db = getDatabase();

    db.prepare('INSERT INTO entities (name, type, confidence) VALUES (?, ?, ?)')
      .run('low-conf', 'note', 0.3);
    db.prepare('INSERT INTO entities (name, type, confidence) VALUES (?, ?, ?)')
      .run('high-conf', 'note', 0.9);

    const status = getDecayStatus(db);
    expect(status.entitiesBelowThreshold).toBeGreaterThanOrEqual(1);
  });
});
