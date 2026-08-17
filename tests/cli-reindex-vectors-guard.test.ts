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
import { MemeshDatabase as Database } from '../src/storage/sqlite.js';

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
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const sqliteVec = require('sqlite-vec');
    // node:sqlite gates extension loading twice: `allowExtension` at open
    // and `enableLoadExtension`. Same dance as src/db.ts.
    const db = new Database(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
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
    const sqliteVec = require('sqlite-vec');
    // node:sqlite gates extension loading twice: `allowExtension` at open
    // and `enableLoadExtension`. Same dance as src/db.ts.
    const db = new Database(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
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
    const sqliteVec = require('sqlite-vec');
    // node:sqlite gates extension loading twice: `allowExtension` at open
    // and `enableLoadExtension`. Same dance as src/db.ts.
    const db = new Database(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
    const n = (db.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
    db.close();
    return n;
  }

  it('the retired --vectors flag is rejected, and rejects before touching anything', () => {
    // `--vectors` existed to consent to dropping every stored embedding before
    // the refill began. Generations removed that step — a rebuild now happens
    // beside the live index and replaces it only when complete — so the flag
    // has no meaning left and is gone rather than kept as a no-op. What must
    // NOT happen is that a script still passing it destroys anything on the
    // way to the error.
    seedVectorIndex();

    const result = run(['reindex', '--vectors']);

    expect(result.status, 'an unknown flag must not exit 0').toBe(1);
    expect(vectorCount(), 'a rejected command destroyed vectors').toBe(1);
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
    //   - no embedder configured (keyword-only)     -> `no_embedding`
    //   - an embedder at the wrong width            -> a vector against a
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
    expect(result.stdout, 'a tick over a run that wrote nothing').not.toContain('✅');
    // It now refuses BEFORE spending the run, and names the actual HTTP status
    // instead of a generic failure — the pre-flight probe embeds one string,
    // and a 401 is configuration, not weather. Previously this same setup ran
    // the whole corpus, failed every write, and reported "0 memories still
    // have no vector", which was true and completely misleading.
    expect(result.stderr).toContain('nothing was rebuilt');
    expect(result.stderr, 'the user was not told their index survived').toContain('untouched');
    // And the stale vector is still there, for a stronger reason than before:
    // a refused rebuild never publishes at all.
    expect(vectorCount()).toBe(1);
  });

  it('--namespace on its own is still accepted', () => {
    // The guards must reject the combination, not the flag. A namespace-scoped
    // reindex at the current dimension destroys nothing and stays available.
    const result = run(['reindex', '--namespace', 'personal', '--json']);

    // Exit 0 or a genuine "no embedding provider" failure are both fine here;
    // what must NOT happen is the argument refusal.
    expect(result.stderr).not.toContain('unknown option');
  });
});
