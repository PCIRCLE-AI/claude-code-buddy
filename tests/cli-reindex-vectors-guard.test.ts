/**
 * `memesh reindex` refuses before it destroys anything, and nothing points a
 * user at a flag that no longer exists.
 *
 * `--vectors` used to consent to dropping every stored embedding before the
 * refill began. Generations removed that step — a rebuild now happens beside
 * the live index and replaces it only when complete — so the flag has no
 * meaning left and is gone rather than kept as a no-op. Three properties
 * survive that removal and are pinned here:
 *
 *   1. The retired flag is refused AS AN UNKNOWN OPTION, and refuses before
 *      anything opens the database. The status code alone cannot show this: a
 *      plain `reindex` also exits 1 in this fixture (the pre-flight probe finds
 *      no usable provider), so only the parser's own message distinguishes
 *      "retired" from "failed for some other reason" — and without that
 *      assertion the test passed even with the flag re-added as a no-op.
 *   2. A run that regenerated nothing does not print a tick or exit 0.
 *   3. No shipped source file tells a user to run a flag the CLI rejects. That
 *      is a scan, not a spawn, because the two offending strings lived in
 *      `src/core/*` where the existing CLI-hint detector never looked.
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
import type { SqlInputValue } from '../src/storage/sqlite.js';

const require = createRequire(import.meta.url);

describe('memesh reindex refuses before it destroys anything', () => {
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

  function run(
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
  ): { status: number; stderr: string; stdout: string } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      MEMESH_DIR: path.join(home, '.memesh'),
      MEMESH_DB_PATH: dbPath,
      ...extraEnv,
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
    // The discriminating assertion. `reindex` with NO flag also exits 1 here,
    // so without this line the test passes whether or not the flag was retired.
    expect(
      result.stderr,
      'the flag was accepted rather than refused by the parser',
    ).toContain('has been retired');
    // A refusal that does not name the replacement is the bare Commander error
    // wearing a costume. The user must leave knowing what to run instead.
    expect(result.stderr, 'the user was not told what to run instead').toContain('memesh reindex');
    expect(result.stderr, 'the user was not told how to change provider').toContain('embedder.provider');
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
    expect(result.stderr).toContain('Nothing was rebuilt');
    // This fixture CONFIGURES openai (and deletes the key), so it is the
    // "configured but not answering" case and the advice must be to check the
    // provider — not to configure one, which the user already did.
    expect(result.stderr, 'advice for the wrong problem').toContain('API key is valid');
    expect(result.stderr, 'advice for the wrong problem').not.toContain('no embedding provider is configured');
    expect(result.stderr, 'the user was not told their index survived').toContain('untouched');
    // And the stale vector is still there, for a stronger reason than before:
    // a refused rebuild never publishes at all.
    expect(vectorCount()).toBe(1);
  });

  it('an incomplete rebuild prints no tick and exits 1 — reached through reindex(), not the probe', async () => {
    // The test above stops AT the pre-flight probe: it exits before
    // `withDatabase` and never calls `reindex()`. So the verdict rendering —
    // the incomplete banner and `process.exitCode = 1` — has been unguarded
    // since that probe was added, and nothing else spawns this CLI.
    //
    // Reaching the loop offline needs a provider that answers TWICE,
    // differently: at the configured width for the one probe string, and at the
    // wrong width for the corpus. An in-process `http.createServer` CANNOT do
    // it — `run()` uses `execFileSync`, which blocks this process's event loop,
    // so the stub never answers the child and every request times out
    // (measured: "Ollama embedding request timed out"). The stub therefore runs
    // as its OWN process, which has its own event loop and keeps serving while
    // this one is blocked.
    const stubPath = path.join(home, 'embed-stub.mjs');
    fs.writeFileSync(stubPath, `
import http from 'node:http';
const PROBE = 'memesh vector index rebuild probe';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let input = '';
    try { input = String(JSON.parse(body || '{}').input ?? ''); } catch {}
    // Right width for the probe so the pre-flight passes; wrong width for every
    // real entity so the corpus fails and the run is genuinely incomplete.
    const n = input === PROBE ? 768 : 8;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: [Array.from({ length: n }, () => 0.1)] }));
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\\n');
});
`);

    const { spawn } = await import('node:child_process');
    const stub = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const port: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stub server never reported a port')), 10_000);
      stub.stdout.on('data', (d: Buffer) => {
        const m = /PORT=(\d+)/.exec(String(d));
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      stub.on('error', reject);
    });

    try {
      fs.writeFileSync(
        path.join(home, '.memesh', 'config.json'),
        JSON.stringify({ embedder: { provider: 'ollama' } }),
      );
      // Seed with the provider UNREACHABLE so `remember`'s own embed writes
      // nothing and the stale vector can be inserted by hand. (`INSERT OR
      // REPLACE` does not work on a vec0 table — see embedder.ts — so the row
      // must not already exist, and it would if the stub were reachable here.)
      const seeded = run(
        ['remember', '--name', 'stale-note', '--type', 'note', '--obs', 'a memory worth keeping'],
        { OLLAMA_HOST: 'http://127.0.0.1:1' },
      );
      expect(seeded.status, `setup: remember failed — ${seeded.stderr}`).toBe(0);

      const sqliteVec = require('sqlite-vec');
      const seedDb = new Database(dbPath, { allowExtension: true });
      seedDb.enableLoadExtension(true);
      try { sqliteVec.load(seedDb); } finally { seedDb.enableLoadExtension(false); }
      const seedId = (seedDb.prepare("SELECT id FROM entities WHERE name = 'stale-note'")
        .get() as { id: number }).id;
      const seedDim = parseInt(
        (seedDb.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'")
          .get() as { value: string }).value,
        10,
      );
      seedDb.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
        BigInt(seedId),
        Buffer.from(new Float32Array(seedDim).fill(0.25).buffer) as unknown as SqlInputValue,
      );
      seedDb.close();
      expect(vectorCount(), 'setup: a stale vector is on disk').toBe(1);

      const result = run(['reindex'], { OLLAMA_HOST: `http://127.0.0.1:${port}` });

      // Anti-vacuity: prove the probe was PASSED and the loop actually ran.
      // Without these two, the test would be satisfied by the probe refusing —
      // which is the other test, and the exact way this one used to prove
      // nothing.
      expect(
        result.stderr,
        'the run never got past the pre-flight probe, so it did not test the verdict',
      ).not.toContain('Nothing was rebuilt');
      expect(result.stderr, 'the reindex loop never started').toContain('Reindexing');

      expect(result.stdout, 'a tick over a run that embedded nothing').not.toContain('✅');
      expect(result.stdout, 'the incomplete verdict is not rendered').toContain('Reindex incomplete');
      expect(result.status, 'an incomplete run exited 0 — `memesh reindex && deploy` would proceed').toBe(1);
      expect(vectorCount(), 'a failed rebuild published into the live index').toBe(1);
    } finally {
      stub.kill();
    }
  });

  // Kept for the record:
  // the CLI verdict (the incomplete banner + `process.exitCode = 1`) has been
  // unguarded since the pre-flight probe was added — the test above stops AT the
  // probe and never calls `reindex()`. Reaching the loop without a network needs a
  // provider that answers the probe at the configured width and the corpus at the
  // wrong one. An in-process `http.createServer` CANNOT do that: `run()` uses
  // `execFileSync`, which blocks this process’s event loop, so the stub never
  // answers the child and every request times out (measured: "Ollama embedding
  // request timed out"). A working version has to spawn the stub as its OWN
  // process — a small script plus `spawn` — before invoking the CLI.

  it('--discard-generation reclaims a half-built index without touching the live one', () => {
    // The deliberate way out. Two situations need it: a rebuild the user has
    // abandoned (the staging index otherwise sits on disk indefinitely and
    // nothing reclaims it), and a generation whose marker cannot be read, where
    // the code refuses to choose between resuming and discarding.
    seedVectorIndex();
    // vec0 is an extension: a plain handle cannot even CREATE the staging table
    // ("no such module: vec0"). Same load dance as the helpers above.
    const sqliteVec = require('sqlite-vec');
    const db = new Database(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
    db.exec('CREATE TABLE IF NOT EXISTS memesh_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec_next USING vec0(embedding float[1536])');
    db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(1), Buffer.alloc(1536 * 4) as unknown as SqlInputValue);
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('vector_generation', ?)")
      .run(JSON.stringify({ dimension: 1536, provider: 'openai', startedAt: '2026-01-01T00:00:00.000Z' }));
    const stagedBefore = (db.prepare('SELECT count(*) AS c FROM entities_vec_next')
      .get() as { c: number }).c;
    db.close();
    expect(stagedBefore, 'fixture: a half-built index is present').toBe(1);

    const result = run(['reindex', '--discard-generation']);

    expect(result.status, `discarding a generation is not a failure — ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Discarded a half-built vector index');

    const after = new Database(dbPath, { allowExtension: true });
    after.enableLoadExtension(true);
    try { sqliteVec.load(after); } finally { after.enableLoadExtension(false); }
    const stagingGone = (after.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE name = 'entities_vec_next'"
    ).get() as { c: number }).c;
    const live = (after.prepare('SELECT count(*) AS c FROM entities_vec').get() as { c: number }).c;
    after.close();

    expect(stagingGone, 'the staging index survived a discard').toBe(0);
    expect(live, 'discarding the staging index touched the LIVE index').toBe(1);
  });

  it('with NO embedder configured, says to configure one — not to check a key that does not exist', () => {
    // QA on the packaged CLI: a fresh install with nothing configured was told
    // "check that Ollama is running (or that your OpenAI API key is valid)".
    // There was no key and no server — the advice was for a different problem.
    // No config file at all; run() deletes OPENAI_API_KEY (the only key it
    // deletes), and no OLLAMA_HOST is set here: embeddings resolve to tfidf.
    seedVectorIndex();
    const result = run(['reindex']);
    expect(result.status).toBe(1);
    expect(result.stderr, 'unconfigured install got advice for a configured one')
      .toContain('no embedding provider is configured');
    expect(result.stderr, 'the user was not told HOW to configure one')
      .toContain('config set embedder.provider');
    expect(result.stderr).not.toContain('API key is valid');
    expect(vectorCount(), 'a refused run touched the index').toBe(1);
  });

  it('a complete rebuild prints the tick, exits 0, and --json agrees', async () => {
    // Review finding M6: the CLI verdict's clean path was asserted nowhere
    // through the spawned binary — only "Reindex incomplete" was — so a
    // mutation that deleted the other-namespace-behind branch survived the
    // suite. Same spawned-stub pattern as the incomplete-path test; the stub
    // answers EVERY request at the configured width.
    const stubPath = path.join(home, 'embed-stub-ok.mjs');
    fs.writeFileSync(stubPath, `
import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }));
  });
});
server.listen(0, '127.0.0.1', () => { process.stdout.write('PORT=' + server.address().port + '\\n'); });
`);
    const { spawn } = await import('node:child_process');
    const stub = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const port: number = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stub never reported a port')), 10_000);
      stub.stdout.on('data', (d: Buffer) => { const m = /PORT=(\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      stub.on('error', reject);
    });
    try {
      fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ embedder: { provider: 'ollama' } }));
      const env = { OLLAMA_HOST: `http://127.0.0.1:${port}` };
      expect(run(['remember', '--name', 'n1', '--type', 'note', '--obs', 'first'], env).status).toBe(0);
      expect(run(['remember', '--name', 'n2', '--type', 'note', '--obs', 'second'], env).status).toBe(0);

      const text = run(['reindex'], env);
      expect(text.status, `a complete rebuild exited non-zero: ${text.stderr}`).toBe(0);
      expect(text.stdout, 'the clean path did not print the tick').toContain('✅ Reindex complete');
      expect(text.stdout).not.toContain('Reindex incomplete');
      expect(text.stdout, 'the clean path printed the other-namespace note').not.toContain('other namespaces');

      const json = run(['reindex', '--json'], env);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.generationSwapped, 'a second clean run should still swap').toBe(true);
      expect(parsed.pendingReindexCleared).toBe(true);
    } finally {
      stub.kill();
    }
  });

  it('a namespace-scoped success still says the OTHER namespace is behind', async () => {
    // The verdict's third branch: everything asked for succeeded, but another
    // namespace still has no vectors, so the database-wide flag stays set and
    // the tick carries a Note. A mutation deleting this branch survived the
    // suite in review because nothing drove it through the binary.
    const stubPath = path.join(home, 'embed-stub-ns.mjs');
    fs.writeFileSync(stubPath, `
import http from 'node:http';
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }));
  });
});
server.listen(0, '127.0.0.1', () => { process.stdout.write('PORT=' + server.address().port + '\\n'); });
`);
    const { spawn } = await import('node:child_process');
    const stub = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const port: number = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stub never reported a port')), 10_000);
      stub.stdout.on('data', (d: Buffer) => { const m = /PORT=(\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      stub.on('error', reject);
    });
    try {
      fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ embedder: { provider: 'ollama' } }));
      const dead = { OLLAMA_HOST: 'http://127.0.0.1:1' };
      // Seed with the provider UNREACHABLE so neither entity gets a vector.
      expect(run(['remember', '--name', 'p1', '--type', 'note', '--obs', 'personal one', '--namespace', 'personal'], dead).status).toBe(0);
      expect(run(['remember', '--name', 'w1', '--type', 'note', '--obs', 'team one', '--namespace', 'team'], dead).status).toBe(0);

      const result = run(['reindex', '--namespace', 'personal'], { OLLAMA_HOST: `http://127.0.0.1:${port}` });
      expect(result.status, `the scoped run failed: ${result.stderr}`).toBe(0);
      expect(result.stdout, 'the scoped success did not print the tick').toContain('✅ Reindex complete');
      expect(result.stdout, 'the other-namespace-behind Note was not printed').toContain('other namespaces');
    } finally {
      stub.kill();
    }
  });

  it('a typo\'d embedder.provider is reported as INVALID, not as "none configured"', () => {
    // Review finding: 'olama' resolved to keyword-only, and the message said
    // "no embedding provider is configured" while `config list` showed one.
    seedVectorIndex();
    fs.writeFileSync(path.join(home, '.memesh', 'config.json'), JSON.stringify({ embedder: { provider: 'olama' } }));
    const result = run(['reindex']);
    expect(result.status).toBe(1);
    expect(result.stderr, 'an invalid value was reported as absent').not.toContain('no embedding provider is configured');
    expect(result.stderr, 'the bad value was not named').toContain("set to 'olama'");
    expect(result.stderr).toContain('config set embedder.provider');
  });

  it('--json is honoured on the retired flag, a bad --namespace, and a thrown error too', () => {
    // Review finding: three exits still printed prose (or nothing) under --json.
    seedVectorIndex();
    const retired = run(['reindex', '--vectors', '--json']);
    expect(retired.status).toBe(1);
    expect(() => JSON.parse(retired.stdout), `retired flag under --json was not JSON: ${retired.stdout}`).not.toThrow();
    expect(JSON.parse(retired.stdout)).toMatchObject({ refused: true, indexTouched: false });
  });

  it('--json is honoured on every reindex path, not only the happy one', () => {
    // QA on the packaged CLI found `--json` silently ignored on two paths: the
    // pre-flight refusal printed an emoji banner, and --discard-generation
    // printed prose. --help documents --json for the whole command, so a script
    // doing `memesh reindex --json | jq` broke on exactly the paths where it
    // most needs a machine-readable answer.
    seedVectorIndex();

    const refused = run(['reindex', '--json']);
    expect(refused.status, 'a refused run must still exit 1 under --json').toBe(1);
    expect(() => JSON.parse(refused.stdout), `refusal was not JSON: ${refused.stdout}`).not.toThrow();
    expect(JSON.parse(refused.stdout)).toMatchObject({ refused: true, indexTouched: false });
    expect(refused.stdout, 'prose leaked into the JSON channel').not.toContain('❌');

    const nothing = run(['reindex', '--discard-generation', '--json']);
    expect(nothing.status).toBe(0);
    expect(JSON.parse(nothing.stdout)).toEqual({ discarded: false, staged: 0 });
  });

  it('--discard-generation says so plainly when there is nothing to discard', () => {
    seedVectorIndex();
    const result = run(['reindex', '--discard-generation']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing to discard');
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

describe('no shipped source tells a user to run a flag the CLI rejects', () => {
  // The two worst defects of the --vectors removal were not in the CLI at all.
  // `src/core/embedder.ts` and `src/core/operations.ts` each printed "run
  // 'memesh reindex --vectors'" on a dimension mismatch — the exact situation
  // the generation mechanism exists to handle — so the user was handed a
  // command that exits 1 with `error: unknown option '--vectors'`. The existing
  // detector (tests/cli-hints-name-real-commands.test.ts) could not see it: it
  // reads only cli.ts and matches only `.command('name')` registrations, never
  // options and never src/core/*. This closes both gaps: options, everywhere
  // that prints advice.
  const ADVICE_SOURCES = [
    'src/transports/cli/cli.ts',
    'src/core/embedder.ts',
    'src/core/operations.ts',
    'src/core/doctor.ts',
    'src/db.ts',
  ];

  it('every "memesh <cmd> --flag" in a user-facing string is a flag cli.ts registers', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const cli = fs.readFileSync(path.join(repoRoot, 'src/transports/cli/cli.ts'), 'utf8');
    const registered = new Set(
      [...cli.matchAll(/\.option\(\s*'(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]),
    );
    expect(
      registered.size,
      'the .option() extraction stopped matching cli.ts — fix the pattern, do not delete the test',
    ).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const rel of ADVICE_SOURCES) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      text.split('\n').forEach((line, i) => {
        // The retirement message names the dead flag on purpose — that is its
        // whole job. It is fenced by a marker so the scan skips it and nothing else.
        if (line.includes('retired-flag-message:')) return;
        // Comments talk to maintainers, not users; only shipped strings count.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const m of line.matchAll(/memesh\s+[a-z][a-z-]*\s+(--[a-z][a-z0-9-]*)/g)) {
          if (!registered.has(m[1])) offenders.push(`${rel}:${i + 1} recommends ${m[1]}`);
        }
      });
    }
    expect(
      offenders,
      `these lines tell a user to run a flag the CLI would reject:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
