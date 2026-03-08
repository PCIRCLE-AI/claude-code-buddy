/**
 * SQLite Connection Pool for better-sqlite3
 *
 * Provides connection pooling for SQLite databases to improve performance
 * and resource management under concurrent query scenarios.
 *
 * Features:
 * - Configurable pool size (default: 5 connections)
 * - Connection timeout handling (default: 5000ms)
 * - Idle timeout for connection recycling (default: 30000ms)
 * - Queue management for waiting requests
 * - Health checks for stale connections
 * - Automatic connection recycling
 * - Graceful shutdown support
 *
 * Architecture:
 * - Pre-creates a pool of connections on initialization
 * - Uses FIFO queue for fair resource allocation
 * - Implements idle timeout to prevent stale connections
 * - Validates connections before returning to pool
 * - Thread-safe operation with promise-based API
 *
 * @example
 * ```typescript
 * // Create pool
 * const pool = new ConnectionPool('/path/to/db.sqlite', {
 *   maxConnections: 5,
 *   connectionTimeout: 5000,
 *   idleTimeout: 30000
 * });
 *
 * // Acquire connection
 * const db = await pool.acquire();
 * try {
 *   // Use connection
 *   const result = db.prepare('SELECT * FROM users').all();
 * } finally {
 *   // Always release back to pool
 *   pool.release(db);
 * }
 *
 * // Check pool health
 * const stats = pool.getStats();
 * console.log(stats); // { total: 5, active: 2, idle: 3, waiting: 0 }
 *
 * // Cleanup on shutdown
 * await pool.shutdown();
 * ```
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import type { ILogger } from '../utils/ILogger.js';
import type { IDatabaseAdapter } from './IDatabaseAdapter.js';
import { BetterSqlite3Adapter, checkBetterSqlite3Availability } from './adapters/BetterSqlite3Adapter.js';

/**
 * Connection Pool Configuration Options
 *
 * Defines configurable parameters for connection pool behavior.
 * All timeouts are in milliseconds.
 */
export interface ConnectionPoolOptions {
  /**
   * Maximum number of connections in the pool
   *
   * Controls the size of the connection pool. Higher values allow more
   * concurrent queries but consume more memory.
   *
   * **Recommendations**:
   * - Development: 3-5 connections
   * - Production: 5-10 connections
   * - High-load: 10-20 connections
   *
   * **Default**: 5
   */
  maxConnections: number;

  /**
   * Maximum time to wait for an available connection (milliseconds)
   *
   * If a connection is not available within this timeout, acquire() will
   * reject with a timeout error. Prevents indefinite waiting.
   *
   * **Default**: 5000ms (5 seconds)
   */
  connectionTimeout: number;

  /**
   * Maximum idle time before connection is recycled (milliseconds)
   *
   * Connections idle longer than this timeout will be closed and recreated
   * to prevent stale connections and free up resources.
   *
   * **Default**: 30000ms (30 seconds)
   */
  idleTimeout: number;

  /**
   * Interval for health check sweep (milliseconds)
   *
   * How often to scan the pool for stale/idle connections.
   *
   * **Default**: 10000ms (10 seconds)
   */
  healthCheckInterval?: number;
}

/**
 * Pool Statistics
 *
 * Provides real-time metrics about the connection pool state.
 * Useful for monitoring, debugging, and capacity planning.
 */
export interface PoolStats {
  /**
   * Total number of connections in the pool
   *
   * This is the configured maxConnections value.
   */
  total: number;

  /**
   * Number of connections currently in use
   *
   * Connections that have been acquired and not yet released.
   */
  active: number;

  /**
   * Number of idle connections available
   *
   * Connections ready to be acquired immediately.
   */
  idle: number;

  /**
   * Number of requests waiting for a connection
   *
   * Indicates pool saturation. If this is consistently high,
   * consider increasing maxConnections.
   */
  waiting: number;

  /**
   * Total connections acquired since pool creation
   *
   * Lifetime counter, useful for usage tracking.
   */
  totalAcquired: number;

  /**
   * Total connections released since pool creation
   *
   * Should closely match totalAcquired in healthy pools.
   */
  totalReleased: number;

  /**
   * Number of connection recycling operations
   *
   * Indicates how often idle connections are being cleaned up.
   */
  totalRecycled: number;

  /**
   * Number of acquire timeout errors
   *
   * High values indicate pool undersizing or slow queries.
   */
  timeoutErrors: number;
}

/**
 * Connection Metadata
 *
 * Tracks per-connection state for health monitoring.
 *
 * @internal
 */
interface ConnectionMetadata {
  /** The actual database connection (using adapter interface) */
  db: IDatabaseAdapter;

  /** Timestamp when connection was last acquired */
  lastAcquired: number;

  /** Timestamp when connection was last released */
  lastReleased: number;

  /** Total number of times this connection has been used */
  usageCount: number;
}

/**
 * SQLite Connection Pool
 *
 * Manages a pool of SQLite database connections for improved performance
 * and resource utilization under concurrent workloads.
 *
 * **Thread Safety**: This implementation is NOT thread-safe at the JavaScript
 * level (single-threaded event loop), but handles async concurrency safely
 * using promises and queues.
 *
 * **Error Handling**: Failed connections are automatically removed and replaced.
 * Pool degradation is logged for monitoring.
 *
 * **Graceful Shutdown**: Call shutdown() before process exit to ensure all
 * connections are properly closed.
 */
/**
 * Maximum safe number of connections.
 *
 * SQLite uses file descriptors for each connection and the OS enforces a
 * per-process limit (commonly 256-1024 on macOS, 1024 on Linux).
 * Setting maxConnections too high can exhaust file descriptors and memory.
 * 100 is a conservative upper bound that leaves room for other file handles.
 */
const MAX_SAFE_CONNECTIONS = 100;

/**
 * Maximum safe timeout value (10 minutes).
 * Prevents unbounded resource holding from misconfiguration.
 */
const MAX_SAFE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Minimum safe connectionTimeout (1 second).
 * Values below this are unrealistic and likely misconfiguration.
 */
const MIN_CONNECTION_TIMEOUT_MS = 1000;

/**
 * Minimum safe idleTimeout (5 seconds).
 * Values below this cause excessive connection recycling.
 */
const MIN_IDLE_TIMEOUT_MS = 5000;

/**
 * Minimum safe healthCheckInterval (5 seconds).
 * Values below this cause a tight polling loop that wastes CPU.
 */
const MIN_HEALTH_CHECK_INTERVAL_MS = 5000;

/**
 * Maximum safe healthCheckInterval (10 minutes).
 * Values above this effectively disable health checks,
 * allowing stale connections to persist undetected.
 */
const MAX_HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export class ConnectionPool {
  private readonly dbPath: string;
  private readonly options: Required<ConnectionPoolOptions>;
  private readonly verboseLogger?: ILogger;
  private readonly pool: ConnectionMetadata[] = [];
  private readonly available: ConnectionMetadata[] = [];
  private readonly waiting: Array<{
    resolve: (db: IDatabaseAdapter) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
  }> = [];

  // Statistics
  private stats = {
    totalAcquired: 0,
    totalReleased: 0,
    totalRecycled: 0,
    timeoutErrors: 0,
  };

  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private isInitialized = false;

  // ✅ FIX P1-16: Track consecutive health check errors for escalation
  private healthCheckErrorCount: number = 0;
  private readonly MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS = 5;

  /**
   * Create a new ConnectionPool with graceful degradation for native modules.
   *
   * This static factory method checks if better-sqlite3 is available and creates
   * a connection pool using lazy-loaded adapters. If better-sqlite3 is unavailable,
   * it provides helpful error messages with fallback suggestions.
   *
   * @param dbPath - Path to SQLite database file (or ':memory:')
   * @param options - Pool configuration options
   * @param verboseLogger - Optional logger for verbose SQLite output
   * @returns Promise resolving to initialized ConnectionPool
   * @throws Error with fallback suggestions if better-sqlite3 unavailable
   *
   * @example
   * ```typescript
   * try {
   *   const pool = await ConnectionPool.create('/data/app.db');
   *   // Use pool normally
   * } catch (error) {
   *   console.error('Failed to create pool:', error.message);
   *   // Error message includes fallback suggestions (Cloud-only mode, sql.js, etc.)
   * }
   * ```
   */
  static async create(
    dbPath: string,
    options: Partial<ConnectionPoolOptions> = {},
    verboseLogger?: ILogger
  ): Promise<ConnectionPool> {
    // Check if better-sqlite3 is available
    const availability = await checkBetterSqlite3Availability();

    if (!availability.available) {
      const errorMsg =
        `Cannot create ConnectionPool: better-sqlite3 is unavailable.\n` +
        `Error: ${availability.error}\n` +
        `Suggestion: ${availability.fallbackSuggestion || 'Use Cloud-only mode with MEMESH_API_KEY'}`;

      logger.error('[ConnectionPool] Static factory failed', {
        error: availability.error,
        suggestion: availability.fallbackSuggestion,
      });

      throw new Error(errorMsg);
    }

    // Create and initialize pool
    const pool = new ConnectionPool(dbPath, options, verboseLogger);
    await pool.initialize();
    return pool;
  }

  /**
   * Create a new connection pool
   *
   * Initializes the pool with the specified number of connections.
   * All connections are pre-created and configured with optimal settings.
   *
   * @param dbPath - Path to SQLite database file (or ':memory:')
   * @param options - Pool configuration options
   * @param verboseLogger - Optional logger for verbose SQLite output (development mode)
   * @throws Error if pool initialization fails
   *
   * @example
   * ```typescript
   * // Default configuration
   * const pool = new ConnectionPool('/data/app.db');
   *
   * // Custom configuration
   * const pool = new ConnectionPool('/data/app.db', {
   *   maxConnections: 10,
   *   connectionTimeout: 3000,
   *   idleTimeout: 60000,
   *   healthCheckInterval: 15000
   * });
   *
   * // With verbose logging
   * const pool = new ConnectionPool('/data/app.db', {}, myLogger);
   * ```
   */
  constructor(
    dbPath: string,
    options: Partial<ConnectionPoolOptions> = {},
    verboseLogger?: ILogger
  ) {
    // Validate dbPath
    if (!dbPath || dbPath.trim().length === 0) {
      throw new Error('dbPath must be a non-empty string');
    }

    this.dbPath = dbPath;
    this.verboseLogger = verboseLogger;
    this.options = {
      maxConnections: options.maxConnections ?? 5,
      connectionTimeout: options.connectionTimeout ?? 5000,
      idleTimeout: options.idleTimeout ?? 30000,
      healthCheckInterval: options.healthCheckInterval ?? 10000,
    };

    // Validate options
    if (this.options.maxConnections < 1) {
      throw new Error('maxConnections must be at least 1');
    }

    if (this.options.maxConnections > MAX_SAFE_CONNECTIONS) {
      logger.warn(
        `[ConnectionPool] maxConnections (${this.options.maxConnections}) exceeds safe limit (${MAX_SAFE_CONNECTIONS}). ` +
        `Clamping to ${MAX_SAFE_CONNECTIONS} to prevent file descriptor exhaustion.`,
        {
          requested: this.options.maxConnections,
          clamped: MAX_SAFE_CONNECTIONS,
        }
      );
      this.options.maxConnections = MAX_SAFE_CONNECTIONS;
    }

    if (this.options.connectionTimeout < MIN_CONNECTION_TIMEOUT_MS) {
      logger.warn(
        `[ConnectionPool] connectionTimeout (${this.options.connectionTimeout}ms) below safe minimum (${MIN_CONNECTION_TIMEOUT_MS}ms). ` +
        `Clamping to ${MIN_CONNECTION_TIMEOUT_MS}ms.`,
        {
          requested: this.options.connectionTimeout,
          clamped: MIN_CONNECTION_TIMEOUT_MS,
        }
      );
      this.options.connectionTimeout = MIN_CONNECTION_TIMEOUT_MS;
    }

    if (this.options.connectionTimeout > MAX_SAFE_TIMEOUT_MS) {
      logger.warn(
        `[ConnectionPool] connectionTimeout (${this.options.connectionTimeout}ms) exceeds safe limit (${MAX_SAFE_TIMEOUT_MS}ms). ` +
        `Clamping to ${MAX_SAFE_TIMEOUT_MS}ms.`,
        {
          requested: this.options.connectionTimeout,
          clamped: MAX_SAFE_TIMEOUT_MS,
        }
      );
      this.options.connectionTimeout = MAX_SAFE_TIMEOUT_MS;
    }

    if (this.options.idleTimeout < MIN_IDLE_TIMEOUT_MS) {
      logger.warn(
        `[ConnectionPool] idleTimeout (${this.options.idleTimeout}ms) below safe minimum (${MIN_IDLE_TIMEOUT_MS}ms). ` +
        `Clamping to ${MIN_IDLE_TIMEOUT_MS}ms.`,
        {
          requested: this.options.idleTimeout,
          clamped: MIN_IDLE_TIMEOUT_MS,
        }
      );
      this.options.idleTimeout = MIN_IDLE_TIMEOUT_MS;
    }

    if (this.options.idleTimeout > MAX_SAFE_TIMEOUT_MS) {
      logger.warn(
        `[ConnectionPool] idleTimeout (${this.options.idleTimeout}ms) exceeds safe limit (${MAX_SAFE_TIMEOUT_MS}ms). ` +
        `Clamping to ${MAX_SAFE_TIMEOUT_MS}ms.`,
        {
          requested: this.options.idleTimeout,
          clamped: MAX_SAFE_TIMEOUT_MS,
        }
      );
      this.options.idleTimeout = MAX_SAFE_TIMEOUT_MS;
    }

    if (this.options.healthCheckInterval < MIN_HEALTH_CHECK_INTERVAL_MS) {
      logger.warn(
        `[ConnectionPool] healthCheckInterval (${this.options.healthCheckInterval}ms) below safe minimum (${MIN_HEALTH_CHECK_INTERVAL_MS}ms). ` +
        `Clamping to ${MIN_HEALTH_CHECK_INTERVAL_MS}ms to prevent tight polling loop.`,
        {
          requested: this.options.healthCheckInterval,
          clamped: MIN_HEALTH_CHECK_INTERVAL_MS,
        }
      );
      this.options.healthCheckInterval = MIN_HEALTH_CHECK_INTERVAL_MS;
    }

    if (this.options.healthCheckInterval > MAX_HEALTH_CHECK_INTERVAL_MS) {
      logger.warn(
        `[ConnectionPool] healthCheckInterval (${this.options.healthCheckInterval}ms) exceeds safe limit (${MAX_HEALTH_CHECK_INTERVAL_MS}ms). ` +
        `Clamping to ${MAX_HEALTH_CHECK_INTERVAL_MS}ms to ensure stale connections are detected.`,
        {
          requested: this.options.healthCheckInterval,
          clamped: MAX_HEALTH_CHECK_INTERVAL_MS,
        }
      );
      this.options.healthCheckInterval = MAX_HEALTH_CHECK_INTERVAL_MS;
    }

    logger.info('ConnectionPool constructor called', {
      dbPath: this.dbPath,
      maxConnections: this.options.maxConnections,
      connectionTimeout: this.options.connectionTimeout,
      idleTimeout: this.options.idleTimeout,
    });

    // Note: Initialization is async and must be called separately via initialize()
    // or use the static create() factory method
  }

  /**
   * Initialize the connection pool asynchronously.
   *
   * This method must be called after construction to set up connections.
   * Prefer using the static `ConnectionPool.create()` factory method which
   * handles this automatically.
   *
   * @throws Error if already initialized or initialization fails
   *
   * @example
   * ```typescript
   * const pool = new ConnectionPool('/data/app.db');
   * await pool.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('ConnectionPool already initialized');
    }

    logger.info('Initializing connection pool', {
      dbPath: this.dbPath,
      maxConnections: this.options.maxConnections,
    });

    // Pre-create connections asynchronously
    await this.initializePool();

    // Start health check timer
    this.startHealthCheck();

    this.isInitialized = true;

    logger.info(`Connection pool initialized with ${this.pool.length} connections`);
  }

  /**
   * Initialize the connection pool asynchronously
   *
   * Pre-creates all connections in the pool using lazy-loaded adapters.
   *
   * @private
   */
  private async initializePool(): Promise<void> {
    for (let i = 0; i < this.options.maxConnections; i++) {
      try {
        const db = await this.createConnection();
        const metadata: ConnectionMetadata = {
          db,
          lastAcquired: 0,
          lastReleased: Date.now(),
          usageCount: 0,
        };
        this.pool.push(metadata);
        this.available.push(metadata);
      } catch (error) {
        logger.error(`Failed to create connection ${i + 1}/${this.options.maxConnections}:`, error);
        throw new Error(`Pool initialization failed: ${error}`);
      }
    }
  }

  /**
   * Create a new database connection using adapter pattern
   *
   * Internal method to create and configure SQLite connections with lazy loading.
   * Uses dynamic import of better-sqlite3 to enable graceful degradation.
   *
   * ✅ FIX CRITICAL: Lazy loading via adapter pattern prevents module-level crashes
   * ✅ FIX HIGH-2: Removed retry logic to prevent event loop blocking
   * Retries are now handled by async callers (acquire, healthCheck, restorePoolSize)
   *
   * @returns Configured IDatabaseAdapter instance
   * @throws Error if connection creation fails
   *
   * @private
   */
  private async createConnection(): Promise<IDatabaseAdapter> {
    // Create adapter with lazy loading
    const adapter = await BetterSqlite3Adapter.create(this.dbPath, {
      verbose: this.verboseLogger ? ((msg: unknown) => this.verboseLogger!.debug('SQLite', { message: msg })) : undefined,
    });

    // Access the underlying Database instance to configure pragmas
    // We need to cast here because the adapter doesn't expose pragma method directly
    const db = (adapter as any).db as Database.Database;

    // Set busy timeout (5 seconds)
    try {
      db.pragma('busy_timeout = 5000');
    } catch (error) {
      logger.warn('[ConnectionPool] Could not set busy_timeout pragma:', error);
    }

    // ✅ FIX LOW-3: Graceful degradation when pragmas fail
    // Enable WAL mode for better concurrency (except in-memory)
    if (this.dbPath !== ':memory:') {
      try {
        const journalMode = db.pragma('journal_mode = WAL', { simple: true }) as string;
        if (journalMode.toLowerCase() !== 'wal') {
          logger.warn('[ConnectionPool] Failed to enable WAL mode, using: ' + journalMode);
        }
      } catch (error) {
        logger.warn('[ConnectionPool] Could not set journal_mode to WAL:', error);
      }

      // Increase cache size for better query performance (10MB)
      try {
        db.pragma('cache_size = -10000');
      } catch (error) {
        logger.debug('[ConnectionPool] Could not set cache_size:', error);
      }

      // Enable memory-mapped I/O (128MB)
      try {
        db.pragma('mmap_size = 134217728');
      } catch (error) {
        logger.debug('[ConnectionPool] Could not set mmap_size:', error);
      }
    }

    // Enable foreign key constraints (CRITICAL - database integrity depends on this)
    try {
      db.pragma('foreign_keys = ON');
      const fkEnabled = db.pragma('foreign_keys', { simple: true }) as number;
      if (fkEnabled !== 1) {
        throw new Error('Failed to enable foreign_keys pragma - database integrity cannot be guaranteed');
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('SQLITE_FULL')) {
        logger.error('[ConnectionPool] Database disk full. Consider freeing disk space.', {
          dbPath: this.dbPath,
          error: errMsg,
        });
        throw new Error('SQLITE_FULL: Database disk full. Consider freeing disk space.');
      }
      logger.error('[ConnectionPool] CRITICAL: Failed to enable foreign key constraints', { error });
      throw new Error(
        `Cannot create connection: foreign key constraints failed to enable. ` +
        `This is critical for database integrity. Error: ${error}`
      );
    }

    return adapter;
  }

  /**
   * Create connection with retry logic (async)
   *
   * ✅ FIX HIGH-2: Async retry logic with proper delays (no event loop blocking)
   *
   * @param context - Context string for logging
   * @returns Configured IDatabaseAdapter instance
   * @throws Error if connection creation fails after all retries
   *
   * @private
   */
  private async createConnectionWithRetry(context: string): Promise<IDatabaseAdapter> {
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [100, 300, 1000]; // Exponential backoff in ms

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.createConnection();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable (SQLITE_BUSY or database locked)
        const isRetryable =
          lastError.message.includes('SQLITE_BUSY') ||
          lastError.message.includes('database is locked') ||
          lastError.message.includes('SQLITE_LOCKED');

        if (!isRetryable || attempt === MAX_RETRIES - 1) {
          // Not retryable or last attempt - throw error
          throw lastError;
        }

        // Wait before retry (async, no event loop blocking!)
        const delay = RETRY_DELAYS[attempt];
        logger.warn(`[ConnectionPool] ${context}: Connection creation failed, retrying...`, {
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          delay,
          error: lastError.message,
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('Connection creation failed');
  }

  /**
   * Validate that a connection is still functional
   *
   * Executes a simple query to verify the connection is responsive.
   *
   * @param db - Database adapter to validate
   * @returns true if connection is valid, false otherwise
   *
   * @private
   */
  private isConnectionValid(db: IDatabaseAdapter): boolean {
    try {
      // Simple query to test connection is responsive
      db.prepare('SELECT 1').get();
      return db.open;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('SQLITE_FULL')) {
        logger.error('[ConnectionPool] Database disk full. Consider freeing disk space.', {
          dbPath: this.dbPath,
          error: msg,
        });
        throw new Error('SQLITE_FULL: Database disk full. Consider freeing disk space.');
      }
      return false;
    }
  }

  /**
   * Get a valid connection from available pool, recycling invalid ones
   *
   * @returns ConnectionMetadata with valid connection, or undefined if none available
   * @private
   */
  private async getValidConnection(): Promise<ConnectionMetadata | undefined> {
    while (this.available.length > 0) {
      const metadata = this.available.shift()!;

      if (this.isConnectionValid(metadata.db)) {
        return metadata;
      }

      // Connection is invalid - recycle it
      logger.warn('Found invalid connection in pool - recycling', {
        usageCount: metadata.usageCount,
      });

      try {
        metadata.db.close();
      } catch (error) {
        // Ignore close errors for invalid connections (already failed validation)
        logger.debug('[ConnectionPool] Ignoring close error for invalid connection', { error });
      }

      // Create replacement connection
      try {
        // ✅ FIX HIGH-2: Use async retry to avoid blocking event loop
        const newDb = await this.createConnectionWithRetry('acquire fallback');
        const newMetadata: ConnectionMetadata = {
          db: newDb,
          lastAcquired: 0,
          lastReleased: Date.now(),
          usageCount: 0,
        };

        // Replace in pool
        const poolIndex = this.pool.indexOf(metadata);
        if (poolIndex !== -1) {
          this.pool[poolIndex] = newMetadata;
        }

        // Add replacement back to available and continue loop
        this.available.push(newMetadata);
        this.stats.totalRecycled++;
      } catch (error) {
        logger.error('Failed to create replacement connection:', error);
        // Pool degradation - connection lost
      }
    }

    return undefined;
  }

  /**
   * Acquire a connection from the pool
   *
   * Returns an available connection or waits for one to become available.
   * If no connection is available within connectionTimeout, throws an error.
   *
   * **IMPORTANT**: Always release the connection back to the pool when done,
   * preferably in a try/finally block to ensure release even on errors.
   *
   * @returns Promise that resolves to a Database adapter
   * @throws Error if connection timeout, pool not initialized, or pool is shutting down
   *
   * @example
   * ```typescript
   * const db = await pool.acquire();
   * try {
   *   const users = db.prepare('SELECT * FROM users').all();
   *   // ... use connection ...
   * } finally {
   *   pool.release(db); // Always release
   * }
   * ```
   */
  async acquire(): Promise<IDatabaseAdapter> {
    if (!this.isInitialized) {
      throw new Error('ConnectionPool not initialized. Call initialize() or use ConnectionPool.create()');
    }
    // ✅ FIX MEDIUM-3: Wrap entire acquisition in timeout to prevent hangs
    let outerTimeoutId: NodeJS.Timeout | null = null;

    try {
      const result = await Promise.race([
        this._acquireInternal(),
        new Promise<never>((_, reject) => {
          outerTimeoutId = setTimeout(
            () => {
              // Track timeout error at outer level (Promise.race ensures this runs first)
              this.stats.timeoutErrors++;
              reject(new Error(`Connection acquisition timeout after ${this.options.connectionTimeout}ms`));
            },
            this.options.connectionTimeout
          );
        }),
      ]);

      // Success - cancel outer timeout to prevent timer leak
      if (outerTimeoutId) {
        clearTimeout(outerTimeoutId);
      }

      return result;
    } catch (error) {
      // Error (including timeout) - cancel outer timeout if still pending
      if (outerTimeoutId) {
        clearTimeout(outerTimeoutId);
      }
      throw error;
    }
  }

  /**
   * ✅ FIX MEDIUM-3: Internal acquisition logic (extracted for timeout wrapping)
   * @private
   */
  private async _acquireInternal(): Promise<IDatabaseAdapter> {
    if (this.isShuttingDown) {
      throw new Error('Pool is shutting down');
    }

    // Check for available valid connection
    const metadata = await this.getValidConnection();
    if (metadata) {
      metadata.lastAcquired = Date.now();
      metadata.usageCount++;
      this.stats.totalAcquired++;

      logger.debug('Connection acquired from pool', {
        active: this.pool.length - this.available.length,
        idle: this.available.length,
      });

      return metadata.db;
    }

    // No available connection - wait for one
    logger.debug('No available connection - queuing request', {
      waiting: this.waiting.length + 1,
    });

    return new Promise<IDatabaseAdapter>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove from waiting queue
        const index = this.waiting.findIndex(w => w.timeoutId === timeoutId);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }

        // Note: timeoutErrors is tracked at outer Promise.race level in acquire()
        reject(new Error(`Connection acquisition timeout after ${this.options.connectionTimeout}ms`));
      }, this.options.connectionTimeout);

      this.waiting.push({ resolve, reject, timeoutId });
    });
  }

  /**
   * Release a connection back to the pool
   *
   * Returns the connection to the available pool. If there are waiting
   * requests, the connection is immediately given to the next waiting request.
   *
   * **Important**: Only release connections that were acquired from this pool.
   * Releasing a foreign connection will cause undefined behavior.
   *
   * @param db - Database adapter to release
   *
   * @example
   * ```typescript
   * const db = await pool.acquire();
   * try {
   *   // ... use connection ...
   * } finally {
   *   pool.release(db); // Always release in finally
   * }
   * ```
   */
  release(db: IDatabaseAdapter): void {
    if (this.isShuttingDown) {
      logger.warn('Attempted to release connection during shutdown - ignoring');
      return;
    }

    // Find the connection metadata
    const metadata = this.pool.find(m => m.db === db);
    if (!metadata) {
      logger.error('Attempted to release unknown connection - ignoring');
      return;
    }

    // ✅ FIX MAJOR-4: Check for duplicate release BEFORE incrementing totalReleased
    // Guard against double release (prevents duplicate available entries and inflated metrics)
    const availableIndex = this.available.indexOf(metadata);
    if (availableIndex !== -1) {
      logger.warn('Connection already released - ignoring duplicate release');
      return;
    }

    metadata.lastReleased = Date.now();
    this.stats.totalReleased++;

    // Check if there are waiting requests
    const waiting = this.waiting.shift();
    if (waiting) {
      clearTimeout(waiting.timeoutId);
      metadata.lastAcquired = Date.now();
      metadata.usageCount++;
      this.stats.totalAcquired++;

      logger.debug('Connection immediately reassigned to waiting request', {
        waiting: this.waiting.length,
      });

      waiting.resolve(db);
      return;
    }

    // No waiting requests - return to available pool
    this.available.push(metadata);

    logger.debug('Connection released back to pool', {
      active: this.pool.length - this.available.length,
      idle: this.available.length,
    });
  }

  /**
   * Get pool statistics
   *
   * Returns real-time metrics about the pool state. Useful for monitoring,
   * debugging, and capacity planning.
   *
   * @returns Current pool statistics
   *
   * @example
   * ```typescript
   * const stats = pool.getStats();
   * console.log(`Pool: ${stats.active} active, ${stats.idle} idle, ${stats.waiting} waiting`);
   *
   * if (stats.waiting > stats.total * 0.5) {
   *   console.warn('Pool is saturated - consider increasing maxConnections');
   * }
   * ```
   */
  getStats(): PoolStats {
    return {
      total: this.pool.length,
      active: this.pool.length - this.available.length,
      idle: this.available.length,
      waiting: this.waiting.length,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
      totalRecycled: this.stats.totalRecycled,
      timeoutErrors: this.stats.timeoutErrors,
    };
  }

  /**
   * Start health check timer
   *
   * Periodically scans the pool for idle connections that exceed idleTimeout
   * and recycles them to prevent stale connections.
   *
   * @private
   */
  private startHealthCheck(): void {
    // ✅ FIX BUG-5: Clear existing timer before creating new one to prevent duplicates
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // ✅ FIX BUG-5: Wrap performHealthCheck in try-catch to prevent timer breakage
    // ✅ FIX P1-16: Track consecutive errors and escalate on persistent failures
    // ✅ FIX HIGH-2: Handle async performHealthCheck
    // ✅ FIX MINOR-2: Use .unref() to allow process exit when pool is only active timer
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck()
        .then(() => {
          // Reset error count on successful health check
          this.healthCheckErrorCount = 0;
        })
        .catch((error) => {
          this.healthCheckErrorCount++;

          logger.error('[ConnectionPool] Health check error:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            consecutiveErrors: this.healthCheckErrorCount,
          });

          // ✅ FIX P1-16: Escalate after consecutive failures
          if (this.healthCheckErrorCount >= this.MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS) {
            logger.error(
              `[ConnectionPool] Health check failed ${this.healthCheckErrorCount} times consecutively - shutting down pool`,
              {
                dbPath: this.dbPath,
                maxErrors: this.MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS,
              }
            );

            // Clear the timer to prevent further checks
            if (this.healthCheckTimer) {
              clearInterval(this.healthCheckTimer);
              this.healthCheckTimer = null;
            }

            // Initiate graceful shutdown
            this.shutdown().catch((shutdownError) => {
              logger.error('[ConnectionPool] Shutdown after health check failures failed:', {
                error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
              });
            });
          }
        });
    }, this.options.healthCheckInterval);

    // Allow Node.js process to exit if this timer is the only active handle
    this.healthCheckTimer.unref();
  }

  /**
   * Perform health check on pool
   *
   * Scans for idle connections that have exceeded idleTimeout and recycles them.
   * Recycling involves closing the stale connection and creating a fresh one.
   *
   * ✅ FIX MEDIUM-1: Skip health check if pool is shutting down
   * ✅ FIX HIGH-2: Made async to use non-blocking retry logic
   *
   * @private
   */
  private async performHealthCheck(): Promise<void> {
    // ✅ FIX MEDIUM-1: Don't perform health checks during shutdown
    if (this.isShuttingDown) {
      return;
    }

    const now = Date.now();
    let recycledCount = 0;

    // ✅ FIX CRITICAL-2: Scan-then-process pattern to avoid modifying array during async iteration
    // Phase 1: Scan - collect stale connections without modifying arrays
    const staleConnections: Array<{
      metadata: ConnectionMetadata;
      availableIndex: number;
      idleTime: number;
    }> = [];

    for (let i = this.available.length - 1; i >= 0; i--) {
      const metadata = this.available[i];
      const idleTime = now - metadata.lastReleased;

      if (idleTime > this.options.idleTimeout) {
        staleConnections.push({ metadata, availableIndex: i, idleTime });
      }
    }

    // Phase 2: Process - handle each stale connection
    // Process in reverse order of availableIndex to maintain correct splice indices
    for (const { metadata, idleTime } of staleConnections) {
      logger.debug('Recycling idle connection', {
        idleTime,
        usageCount: metadata.usageCount,
      });

      // Remove from available (re-find index as array may have changed from concurrent release())
      const currentAvailableIndex = this.available.indexOf(metadata);
      if (currentAvailableIndex !== -1) {
        this.available.splice(currentAvailableIndex, 1);
      }

      // Track if we successfully removed from pool (for replacement logic)
      let removedFromPool = false;
      let poolIndex = this.pool.indexOf(metadata);

      // Close stale connection
      try {
        metadata.db.close();
      } catch (error) {
        // ✅ FIX MEDIUM-1: Implement proper error recovery for zombie connections
        logger.error('[ConnectionPool] Error closing stale connection during health check', { error });

        // Force cleanup: remove zombie connection from pool to prevent accumulation
        if (poolIndex !== -1) {
          this.pool.splice(poolIndex, 1);
          removedFromPool = true;
          logger.warn('[ConnectionPool] Removed zombie connection from pool', {
            poolSize: this.pool.length,
            targetSize: this.options.maxConnections,
          });
        }
      }

      // Create new connection
      try {
        // ✅ FIX HIGH-2: Use async retry to avoid blocking event loop
        const newDb = await this.createConnectionWithRetry('health check');
        const newMetadata: ConnectionMetadata = {
          db: newDb,
          lastAcquired: 0,
          lastReleased: now,
          usageCount: 0,
        };

        // ✅ FIX MAJOR-3: Handle orphan connection from stale pool reference
        // Re-find poolIndex as it may have changed after zombie removal or concurrent operations
        poolIndex = this.pool.indexOf(metadata);
        if (poolIndex !== -1) {
          // Replace existing entry
          this.pool[poolIndex] = newMetadata;
        } else if (removedFromPool || this.pool.length < this.options.maxConnections) {
          // Metadata was removed (zombie) or pool is under capacity - add new connection
          this.pool.push(newMetadata);
        }
        // else: pool is at capacity and old metadata wasn't found - skip to avoid over-allocation

        // Add back to available
        this.available.push(newMetadata);
        recycledCount++;
        this.stats.totalRecycled++;
      } catch (error) {
        logger.error('Failed to create replacement connection:', error);
        // Pool degradation - connection lost
      }
    }

    if (recycledCount > 0) {
      logger.info(`Recycled ${recycledCount} idle connections`);
    }

    // ✅ FIX MAJOR-7: Restore pool to target size after degradation
    await this.restorePoolSize();
  }

  /**
   * ✅ FIX MAJOR-7: Restore degraded pool to maxConnections target
   * ✅ FIX HIGH-2: Made async to use non-blocking retry logic
   *
   * When connection recycling fails, the pool can degrade (shrink from 5 → 4 → 3 → 1).
   * This method detects degradation and attempts to restore the pool to its configured size.
   *
   * Called from performHealthCheck() to ensure pool maintains target size over time.
   */
  private async restorePoolSize(): Promise<void> {
    const currentSize = this.pool.length;
    const targetSize = this.options.maxConnections;
    const deficit = targetSize - currentSize;

    if (deficit > 0) {
      logger.warn('[ConnectionPool] Pool degraded - attempting restoration', {
        currentSize,
        targetSize,
        deficit,
      });

      let restored = 0;
      for (let i = 0; i < deficit; i++) {
        try {
          // ✅ FIX HIGH-2: Use async retry to avoid blocking event loop
          const newDb = await this.createConnectionWithRetry('pool restoration');
          const metadata: ConnectionMetadata = {
            db: newDb,
            lastAcquired: 0,
            lastReleased: Date.now(),
            usageCount: 0,
          };

          this.pool.push(metadata);
          this.available.push(metadata);
          restored++;
        } catch (error) {
          logger.error('[ConnectionPool] Failed to restore pool connection:', error);

          // If we can't create ANY connections, pool is critically degraded
          if (this.pool.length === 0) {
            throw new Error(
              'Connection pool completely degraded - no connections available. ' +
              'Database may be locked or inaccessible.'
            );
          }

          // Stop trying after first failure to avoid excessive error logging
          break;
        }
      }

      if (restored > 0) {
        logger.info('[ConnectionPool] Restored pool connections', {
          restored,
          newSize: this.pool.length,
        });
      }
    }
  }

  /**
   * Shutdown the connection pool
   *
   * Gracefully closes all connections and clears the pool. Should be called
   * during application shutdown to ensure proper cleanup.
   *
   * **Important**: This is irreversible. Once shutdown, the pool cannot be reused.
   * Create a new pool instance if needed.
   *
   * @returns Promise that resolves when all connections are closed
   *
   * @example
   * ```typescript
   * // Graceful shutdown
   * process.on('SIGTERM', async () => {
   *   console.log('Shutting down...');
   *   await pool.shutdown();
   *   process.exit(0);
   * });
   * ```
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Pool already shutting down');
      return;
    }

    this.isShuttingDown = true;
    logger.info('Shutting down connection pool');

    // Stop health check
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Reject all waiting requests
    for (const waiting of this.waiting) {
      clearTimeout(waiting.timeoutId);
      waiting.reject(new Error('Pool is shutting down'));
    }
    this.waiting.length = 0;

    // Close all connections
    const closePromises = this.pool.map(async (metadata) => {
      try {
        metadata.db.close();
      } catch (error) {
        logger.error('[ConnectionPool] Error closing connection during shutdown', { error });
      }
    });

    await Promise.all(closePromises);

    // Clear pools
    this.pool.length = 0;
    this.available.length = 0;

    logger.info('Connection pool shutdown complete');
  }

  /**
   * Check if pool is healthy
   *
   * Returns true if the pool has the expected number of connections
   * and no degradation has occurred.
   *
   * @returns true if pool is healthy, false if degraded
   *
   * @example
   * ```typescript
   * if (!pool.isHealthy()) {
   *   console.error('Pool degradation detected!');
   *   // Alert monitoring, restart pool, etc.
   * }
   * ```
   */
  isHealthy(): boolean {
    return this.pool.length === this.options.maxConnections;
  }
}
