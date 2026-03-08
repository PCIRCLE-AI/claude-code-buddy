import { logger } from '../../utils/logger.js';
export async function checkBetterSqlite3Availability() {
    try {
        const module = await import('better-sqlite3');
        const testDb = new module.default(':memory:');
        testDb.close();
        logger.debug('[BetterSqlite3Adapter] Availability check passed');
        return {
            available: true,
            name: 'better-sqlite3',
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let fallbackSuggestion = '';
        if (errorMessage.includes('Cannot find module')) {
            fallbackSuggestion = 'Run: npm install better-sqlite3';
        }
        else if (errorMessage.includes('was compiled against')) {
            fallbackSuggestion = 'Run: npm rebuild better-sqlite3';
        }
        else if (errorMessage.includes('node-gyp') || errorMessage.includes('compilation')) {
            fallbackSuggestion = 'Native compilation failed. Consider using Cloud-only mode with MEMESH_API_KEY.';
        }
        else {
            fallbackSuggestion = 'Try rebuilding: npm rebuild better-sqlite3, or use Cloud-only mode.';
        }
        logger.warn('[BetterSqlite3Adapter] Availability check failed', {
            error: errorMessage,
            suggestion: fallbackSuggestion,
        });
        return {
            available: false,
            name: 'better-sqlite3',
            error: errorMessage,
            fallbackSuggestion,
        };
    }
}
export class BetterSqlite3Adapter {
    db;
    constructor(db) {
        this.db = db;
    }
    static async create(dbPath, options) {
        try {
            const Database = (await import('better-sqlite3')).default;
            const db = new Database(dbPath, options);
            if (dbPath !== ':memory:') {
                try {
                    const result = db.pragma('quick_check', { simple: true });
                    if (result !== 'ok') {
                        logger.warn('[BetterSqlite3Adapter] Database quick_check failed', {
                            dbPath,
                            result,
                        });
                        db.close();
                        throw new Error(`Database integrity check failed: ${result}`);
                    }
                }
                catch (error) {
                    if (error instanceof Error && error.message.startsWith('Database integrity check failed')) {
                        throw error;
                    }
                    logger.warn('[BetterSqlite3Adapter] Could not run quick_check pragma', {
                        dbPath,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            logger.debug('[BetterSqlite3Adapter] Successfully loaded native module', {
                dbPath,
                inMemory: dbPath === ':memory:',
            });
            return new BetterSqlite3Adapter(db);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('[BetterSqlite3Adapter] Failed to load better-sqlite3', {
                error: errorMessage,
                dbPath,
            });
            throw new Error(`Failed to load better-sqlite3: ${errorMessage}. ` +
                `Consider using Cloud-only mode by setting MEMESH_API_KEY environment variable.`);
        }
    }
    prepare(sql) {
        const stmt = this.db.prepare(sql);
        return {
            all: (...params) => {
                return stmt.all(...params);
            },
            get: (...params) => {
                return stmt.get(...params);
            },
            run: (...params) => {
                const result = stmt.run(...params);
                return {
                    changes: result.changes,
                    lastInsertRowid: result.lastInsertRowid,
                };
            },
            iterate: (...params) => {
                return stmt.iterate(...params);
            },
        };
    }
    exec(sql) {
        this.db.exec(sql);
    }
    close() {
        if (this.db.open) {
            this.db.close();
            logger.debug('[BetterSqlite3Adapter] Database connection closed');
        }
    }
    get inMemory() {
        return this.db.memory;
    }
    get name() {
        return 'better-sqlite3';
    }
    get open() {
        return this.db.open;
    }
}
//# sourceMappingURL=BetterSqlite3Adapter.js.map