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
 * supports Node >= 22.5 — so on the whole Node 22 LTS line every CLI
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
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = loadNodeSqlite();

/** A prepared statement. Named so call sites do not import from node:sqlite. */
export type SqliteStatement = import('node:sqlite').StatementSync;

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
