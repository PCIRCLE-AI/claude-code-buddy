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
    finally {
        process.emitWarning = original;
    }
}
const { DatabaseSync } = loadNodeSqlite();
export class MemeshDatabase extends DatabaseSync {
    #depth = 0;
    constructor(path, options = {}) {
        super(path, options);
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