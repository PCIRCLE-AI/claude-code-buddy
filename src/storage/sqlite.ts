/**
 * The SQLite driver, and the two methods node:sqlite does not ship.
 *
 * memesh used to run on `better-sqlite3`, whose install script is
 * `prebuild-install || node-gyp rebuild`. That binds the compiled binary to a
 * Node ABI, so a Node upgrade breaks it and `--ignore-scripts` never builds it
 * at all — which is exactly how a `/plugin install` produced a memesh whose
 * hooks silently did nothing, because Claude Code installs plugins with
 * `--ignore-scripts`. `node:sqlite` is part of the runtime: no binary, no
 * install script, nothing to rebuild.
 *
 * The only two things better-sqlite3 had that node:sqlite does not are
 * `db.pragma()` and `db.transaction()`. They are re-added here as a subclass
 * rather than as free functions on purpose: every existing call site keeps its
 * shape, so the migration is a change of driver and not a rewrite of 17
 * transaction bodies whose rollback behaviour is load-bearing.
 */
import { createRequire } from 'node:module';

/**
 * Load node:sqlite without printing Node 22's experimental warning.
 *
 * The warning is emitted once, when the module is first loaded, and memesh
 * supports Node >= 22.13 — so on the rest of the Node 22 LTS line every CLI
 * invocation, every hook and every MCP handshake would print a line users
 * cannot act on. Node 24 and 26 emit nothing.
 *
 * The patch is surgical and temporary: it drops only this one warning, passes
 * every other warning through untouched, and `process.emitWarning` is restored
 * before this function returns — including when the load throws, which is why
 * the restore is in a `finally`. Verified on 22.23.2 (warning suppressed, an
 * unrelated warning still emitted, hook stayed restored), 24.15.0 and 26.5.1.
 *
 * `createRequire` rather than `await import()`: a top-level await here would
 * make every importer of this module async for no gain, and `node:sqlite` is a
 * builtin so `require` resolves it in an ESM file without a file lookup.
 */
function loadNodeSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
    if (text.includes('SQLite is an experimental feature')) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any).call(process, warning, ...rest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch (err) {
    // A runtime below the floor fails HERE, during module evaluation, before
    // any diagnostic code exists to explain it — `memesh doctor` included,
    // since it imports this module. Node's own text is
    // `No such built-in module: node:sqlite`, which says nothing about what to
    // do. Replacing it is the only chance to tell the user anything at all, so
    // the sentence has to carry the whole answer.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `memesh needs Node's built-in SQLite, which this runtime (${process.version}) does not provide. ` +
      'It became usable without a flag in Node 22.13.0 — upgrade Node to 22.13 or newer and run memesh again. ' +
      `(${detail})`,
      { cause: err },
    );
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = loadNodeSqlite();

/** A prepared statement. Named so call sites do not import from node:sqlite. */
export type SqliteStatement = import('node:sqlite').StatementSync;

/** What SQLite hands back in a column, and what it will accept in a binding. */
export type SqlOutputValue = import('node:sqlite').SQLOutputValue;
export type SqlInputValue = import('node:sqlite').SQLInputValue;

/**
 * How a database is opened.
 *
 * `readOnly` is spelled with a capital O, and that is not a detail. Passing
 * better-sqlite3's `readonly` spelling to node:sqlite is not an error — the
 * option is simply not recognised, and the database opens WRITABLE. Three
 * production read paths (the `view` CLI and two hooks) depend on this, so the
 * option is retyped here to make the wrong spelling a compile error rather than
 * a silent loss of protection, and `sqlite-driver.test.ts` proves a read-only
 * handle REJECTS a write rather than merely proving it opens.
 */
export interface OpenOptions {
  readOnly?: boolean;
  /** Required before `loadExtension` — sqlite-vec is loaded that way. */
  allowExtension?: boolean;
}

/**
 * How long SQLite waits for a held write lock before giving up.
 *
 * node:sqlite's default is 0 — the first contended write fails instantly with
 * "database is locked". better-sqlite3's was 5000, and memesh was built on
 * that: seven hooks, the CLI, the MCP server and the HTTP server all open one
 * database file, `runOnceMigration` takes the write lock with `.immediate()`,
 * and `tests/migration-atomicity.test.ts` sets `busy_timeout = 1` with the
 * comment "the default 5s would only make the test slow". Carrying the driver
 * swap without carrying this number would have turned every overlap — a
 * post-commit hook landing while a session-summary writes — into a lost
 * capture.
 *
 * Set through PRAGMA rather than the constructor's `timeout` option, which is
 * Node >= 24 and would raise the floor for nothing.
 *
 * Raised from 5000 once one bounded maintenance operation grew past it.
 * `swapVectorGeneration` copies every embedding inside a single transaction —
 * that copy IS the atomicity guarantee, because a `vec0` table cannot be
 * renamed — and the copy is O(rows): measured at ~272-302us per row (768-dim,
 * vec0-only database on an SSD, so a floor), i.e. 5.4s at 20k vectors and 9.1s
 * at 30k. Against the old 5s a rebuild on a graph past roughly 16.5k vectors
 * did not make concurrent writers WAIT, it made them FAIL — reproduced, a hook
 * writing during a 30k swap lost its capture after 5213ms. 30s holds for a
 * graph around 100k vectors, and a writer that waits is the whole point of this
 * number.
 */
const BUSY_TIMEOUT_MS = 30_000;

/** What a `transaction()` wrapper can be called as. */
export interface TransactionFunction<A extends unknown[], R> {
  (...args: A): R;
  /**
   * Take the write lock at BEGIN instead of at the first write, so a
   * concurrent writer fails immediately rather than half way through.
   */
  immediate(...args: A): R;
}

export class MemeshDatabase extends DatabaseSync {
  /** Nesting depth, so an inner transaction becomes a SAVEPOINT. */
  #depth = 0;

  // Defaulted rather than forwarded: node:sqlite rejects an explicit
  // `undefined` for `options` with "The options argument must be an object",
  // so `new MemeshDatabase(p)` would throw if the parameter were passed
  // straight through.
  constructor(path: string, options: OpenOptions = {}) {
    super(path, options);
    this.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }

  /**
   * Run a PRAGMA. node:sqlite has no helper, and every memesh call site
   * (`journal_mode = WAL`, `foreign_keys = ON`) sets rather than reads, so this
   * discards the result. Reads go through `prepare('PRAGMA x').get()`, which
   * the migration code already uses.
   */
  pragma(statement: string): void {
    this.exec(`PRAGMA ${statement}`);
  }

  /**
   * better-sqlite3's `db.transaction()`, reproduced.
   *
   * Two behaviours are load-bearing and `tests/migration-atomicity.test.ts`
   * judges them:
   *
   *   - A throw inside the callback rolls back and re-throws. Returning
   *     normally commits.
   *   - A nested call becomes a SAVEPOINT, not a second BEGIN. SQLite rejects
   *     `BEGIN` inside a transaction outright ("cannot start a transaction
   *     within a transaction"), so a flat implementation would turn a nested
   *     write into a runtime error in a write path — the kind of failure that
   *     only appears under the exact call ordering that nests.
   *
   * The returned function is callable directly (deferred) or as
   * `.immediate()`. better-sqlite3 also offers `.deferred`/`.exclusive`;
   * nothing here uses them, so they are not implemented.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R> {
    const run = (mode: '' | ' IMMEDIATE', ...args: A): R => {
      const nested = this.#depth > 0;
      const savepoint = `memesh_sp_${this.#depth}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode}`);
      this.#depth++;
      try {
        const result = fn(...args);
        this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (err) {
        // Unwinding must not mask the original error: if the connection is
        // already gone, or SQLite rolled the transaction back itself, the
        // rollback throws and the caller still needs to see `err`.
        try {
          this.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) this.exec(`RELEASE ${savepoint}`);
        } catch { /* already unwound */ }
        throw err;
      } finally {
        this.#depth--;
      }
    };

    const callable = ((...args: A) => run('', ...args)) as TransactionFunction<A, R>;
    callable.immediate = (...args: A) => run(' IMMEDIATE', ...args);
    return callable;
  }
}
