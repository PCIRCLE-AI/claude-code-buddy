/**
 * `memesh reindex --vectors` destroys data on purpose, so the two ways it can
 * destroy MORE than the user asked for are refused at the CLI, before anything
 * opens the database.
 *
 *   1. `--vectors --namespace X` — `entities_vec` is ONE table for the whole
 *      database, so the rebuild drops every namespace's vectors, while
 *      `--namespace` would refill only X. The other namespaces lose their
 *      embeddings permanently and silently, outside anything the user asked
 *      for: the destruction is wider than the repair.
 *
 *   2. `--vectors --fts` — two different indexes, one flag each.
 *
 * Spawns the built CLI with HOME pointed at a tmpdir, because the guards live
 * in the command's action and the ordering relative to `openDatabase` is the
 * property under test. Asserting on source order would pass a rewrite that
 * kept the lines and lost the meaning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

describe('memesh reindex --vectors refuses to destroy more than asked', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-reidx-cli-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    dbPath = path.join(home, '.memesh', 'kg.db');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stderr: string; stdout: string } {
    try {
      const stdout = execFileSync('node', [path.resolve('dist/transports/cli/cli.js'), ...args], {
        env: { ...process.env, HOME: home, MEMESH_DIR: path.join(home, '.memesh'), MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout?: string; stderr?: string };
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  /** A database with a populated vector index, built without going through the CLI. */
  function seedVectorIndex(): void {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(embedding float[384])');
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(1),
      Buffer.from(new Float32Array(384).fill(0.25).buffer)
    );
    db.close();
  }

  function vectorCount(): number {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(dbPath);
    sqliteVec.load(db);
    const n = (db.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
    db.close();
    return n;
  }

  it('refuses --vectors with --namespace, and leaves the index untouched', () => {
    seedVectorIndex();

    const result = run(['reindex', '--vectors', '--namespace', 'personal']);

    expect(result.status, 'a refusal must not exit 0').toBe(1);
    expect(result.stderr).toContain('--namespace');
    // The point of the refusal: nothing was dropped on the way to it.
    expect(vectorCount(), 'vectors were destroyed by a command that refused').toBe(1);
  });

  it('refuses --vectors with --fts', () => {
    seedVectorIndex();

    const result = run(['reindex', '--vectors', '--fts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('separately');
    expect(vectorCount()).toBe(1);
  });

  it('--namespace on its own is still accepted', () => {
    // The guards must reject the combination, not the flag. A namespace-scoped
    // reindex at the current dimension destroys nothing and stays available.
    const result = run(['reindex', '--namespace', 'personal', '--json']);

    // Exit 0 or a genuine "no embedding provider" failure are both fine here;
    // what must NOT happen is the argument refusal.
    expect(result.stderr).not.toContain('--vectors rebuilds the whole vector index');
    expect(result.stderr).not.toContain('rebuild different indexes');
  });
});
