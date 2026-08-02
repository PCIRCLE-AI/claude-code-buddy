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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      MEMESH_DIR: path.join(home, '.memesh'),
      MEMESH_DB_PATH: dbPath,
    };
    // A real key in the developer's shell would send these test entities to
    // OpenAI and make the offline cases below depend on the network.
    delete env.OPENAI_API_KEY;
    try {
      const stdout = execFileSync('node', [path.resolve('dist/transports/cli/cli.js'), ...args], {
        env,
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

  /**
   * One active entity, one observation, and a vector already on disk for it —
   * the state a working install is in before the embedding provider breaks.
   *
   * The entity is written through the CLI so the schema, the FTS rows and the
   * vector table's declared width all come from the real code path rather than
   * a copy of the DDL that could drift from it. The vector is then inserted
   * directly, at whatever width the database says it uses, so the row is
   * genuinely stale: present, and not written by the run under test.
   */
  function seedEntityWithStaleVector(): void {
    const seeded = run(['remember', '--name', 'stale-note', '--type', 'note', '--obs', 'a memory worth keeping']);
    expect(seeded.status, `setup: remember failed — ${seeded.stderr}`).toBe(0);

    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    const db = new Database(dbPath);
    sqliteVec.load(db);
    const id = (db.prepare("SELECT id FROM entities WHERE name = 'stale-note'").get() as { id: number }).id;
    const dim = parseInt(
      (db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'")
        .get() as { value: string }).value,
      10
    );
    db.prepare('INSERT OR REPLACE INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
      BigInt(id),
      Buffer.from(new Float32Array(dim).fill(0.25).buffer)
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

  it('does not print a tick and exit 0 when it regenerated nothing', () => {
    // The verdict, at the layer the user and their shell scripts actually see.
    //
    // Every assertion elsewhere about this checks `ReindexResult`. This one
    // spawns the CLI, because `process.exitCode = 1` and the `✅` are the
    // contract — `memesh reindex && deploy` is built on the exit code, not on
    // a field of a TypeScript interface.
    //
    // The setup is the real failure and it needs no network: the config NAMES
    // openai, so `isEmbeddingAvailable()` says yes and the run proceeds, but
    // with no API key `embedWithOpenAI` returns null before it fetches
    // anything. What happens next depends on the machine, and BOTH outcomes are
    // the bug:
    //
    //   - no local ONNX model cached (a CI runner)  -> `no_embedding`
    //   - a cached ONNX model (a developer's box)   -> 384-dim vector against a
    //     1536-dim index -> `dimension_mismatch`, which is the "the configured
    //     provider failed and a fallback was used" case `embedAndStore` warns
    //     about by name
    //
    // Either way every embed fails while the entity keeps the vector seeded
    // below — which is precisely what made the old code report success: the
    // end-state check found a vector for every entity and never asked whether
    // THIS run wrote any of them. Asserting on the verdict rather than on the
    // outcome keeps the test true on both kinds of machine.
    fs.writeFileSync(
      path.join(home, '.memesh', 'config.json'),
      JSON.stringify({ embedder: { provider: 'openai' } })
    );
    seedEntityWithStaleVector();

    const result = run(['reindex']);

    expect(result.status, 'a run that regenerated nothing exited 0').toBe(1);
    expect(result.stdout).toContain('Reindex incomplete');
    expect(result.stdout, 'a tick over a run that wrote nothing').not.toContain('✅');
    // The line that tells the user what actually happened, rather than
    // "0 memories still have no vector" — true, and completely misleading.
    expect(result.stdout).toContain('Could not be regenerated');
    // And the stale vector is still there. The run failed; it did not destroy.
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
