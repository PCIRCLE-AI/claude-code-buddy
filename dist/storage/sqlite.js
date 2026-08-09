import { createRequire } from 'node:module';
function loadNodeSqlite() {
    const require = createRequire(import.meta.url);
    const original = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
        const text = typeof warning === 'string' ? warning : String(warning?.message ?? warning);
        if (text.includes('SQLite is an experimental feature'))
            return;
        return original.call(process, warning, ...rest);
    };
    try {
        return require('node:sqlite');
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`memesh needs Node's built-in SQLite, which this runtime (${process.version}) does not provide. ` +
            'It became usable without a flag in Node 22.13.0 — upgrade Node to 22.13 or newer and run memesh again. ' +
            `(${detail})`, { cause: err });
    }
    finally {
        process.emitWarning = original;
    }
}
const { DatabaseSync } = loadNodeSqlite();
const BUSY_TIMEOUT_MS = 5000;
export class MemeshDatabase extends DatabaseSync {
    #depth = 0;
    constructor(path, options = {}) {
        super(path, options);
        this.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
    pragma(statement) {
        this.exec(`PRAGMA ${statement}`);
    }
    transaction(fn) {
        const run = (mode, ...args) => {
            const nested = this.#depth > 0;
            const savepoint = `memesh_sp_${this.#depth}`;
            this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN${mode}`);
            this.#depth++;
            try {
                const result = fn(...args);
                this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
                return result;
            }
            catch (err) {
                try {
                    this.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
                    if (nested)
                        this.exec(`RELEASE ${savepoint}`);
                }
                catch { }
                throw err;
            }
            finally {
                this.#depth--;
            }
        };
        const callable = ((...args) => run('', ...args));
        callable.immediate = (...args) => run(' IMMEDIATE', ...args);
        return callable;
    }
}
//# sourceMappingURL=sqlite.js.map