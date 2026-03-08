/**
 * Better-SQLite3 Adapter
 *
 * Lazy-loaded adapter for better-sqlite3 native module.
 * Uses dynamic imports to enable graceful degradation when native module unavailable.
 *
 * @example
 * ```typescript
 * // Check availability first
 * const availability = await checkBetterSqlite3Availability();
 * if (!availability.available) {
 *   console.error('better-sqlite3 unavailable:', availability.error);
 *   console.log('Suggestion:', availability.fallbackSuggestion);
 *   // Fall back to another adapter or Cloud-only mode
 *   return;
 * }
 *
 * // Create adapter
 * const adapter = await BetterSqlite3Adapter.create('./data.db');
 * const stmt = adapter.prepare('SELECT * FROM users WHERE id = ?');
 * const user = stmt.get(123);
 * ```
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import type {
  IDatabaseAdapter,
  IStatement,
  IRunResult,
  AdapterAvailability,
} from '../IDatabaseAdapter.js';

/**
 * Check if better-sqlite3 is available and can be loaded.
 *
 * This function attempts to dynamically import better-sqlite3 and create
 * a test in-memory database to verify it works correctly.
 *
 * @returns Availability result with error details and suggestions if unavailable
 */
export async function checkBetterSqlite3Availability(): Promise<AdapterAvailability> {
  try {
    // Attempt to dynamically import better-sqlite3
    const module = await import('better-sqlite3');

    // Try to create a test database to ensure it actually works
    const testDb = new module.default(':memory:');
    testDb.close();

    logger.debug('[BetterSqlite3Adapter] Availability check passed');
    return {
      available: true,
      name: 'better-sqlite3',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Provide helpful suggestions based on error type
    let fallbackSuggestion = '';

    if (errorMessage.includes('Cannot find module')) {
      fallbackSuggestion = 'Run: npm install better-sqlite3';
    } else if (errorMessage.includes('was compiled against')) {
      fallbackSuggestion = 'Run: npm rebuild better-sqlite3';
    } else if (errorMessage.includes('node-gyp') || errorMessage.includes('compilation')) {
      fallbackSuggestion = 'Native compilation failed. Consider using Cloud-only mode with MEMESH_API_KEY.';
    } else {
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

/**
 * Better-SQLite3 adapter implementation.
 *
 * Wraps better-sqlite3 Database instance with IDatabaseAdapter interface.
 */
export class BetterSqlite3Adapter implements IDatabaseAdapter {
  private db: Database.Database;

  /**
   * Private constructor - use static create() method instead
   */
  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a new BetterSqlite3Adapter instance.
   *
   * This method dynamically imports better-sqlite3 and creates a database instance.
   * If the import fails, it throws with a helpful error message.
   *
   * @param dbPath Path to database file or ':memory:' for in-memory database
   * @param options better-sqlite3 options
   * @returns Promise resolving to adapter instance
   * @throws Error if better-sqlite3 cannot be loaded
   */
  static async create(
    dbPath: string,
    options?: Database.Options
  ): Promise<BetterSqlite3Adapter> {
    try {
      // Dynamic import to enable lazy loading
      const Database = (await import('better-sqlite3')).default;

      const db = new Database(dbPath, options);

      // Run quick integrity check on file-based databases
      if (dbPath !== ':memory:') {
        try {
          const result = db.pragma('quick_check', { simple: true }) as string;
          if (result !== 'ok') {
            logger.warn('[BetterSqlite3Adapter] Database quick_check failed', {
              dbPath,
              result,
            });
            db.close();
            throw new Error(`Database integrity check failed: ${result}`);
          }
        } catch (error) {
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[BetterSqlite3Adapter] Failed to load better-sqlite3', {
        error: errorMessage,
        dbPath,
      });

      throw new Error(
        `Failed to load better-sqlite3: ${errorMessage}. ` +
        `Consider using Cloud-only mode by setting MEMESH_API_KEY environment variable.`
      );
    }
  }

  prepare(sql: string): IStatement {
    const stmt = this.db.prepare(sql);

    // Wrap better-sqlite3 Statement to match IStatement interface
    return {
      all: <T = any>(...params: any[]): T[] => {
        return stmt.all(...params) as T[];
      },

      get: <T = any>(...params: any[]): T | undefined => {
        return stmt.get(...params) as T | undefined;
      },

      run: (...params: any[]): IRunResult => {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },

      iterate: <T = any>(...params: any[]): IterableIterator<T> => {
        return stmt.iterate(...params) as IterableIterator<T>;
      },
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
      logger.debug('[BetterSqlite3Adapter] Database connection closed');
    }
  }

  get inMemory(): boolean {
    return this.db.memory;
  }

  get name(): string {
    return 'better-sqlite3';
  }

  get open(): boolean {
    return this.db.open;
  }
}
