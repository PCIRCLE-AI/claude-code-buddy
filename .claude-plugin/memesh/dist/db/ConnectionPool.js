import { logger } from '../utils/logger.js';
import { BetterSqlite3Adapter, checkBetterSqlite3Availability } from './adapters/BetterSqlite3Adapter.js';
const MAX_SAFE_CONNECTIONS = 100;
const MAX_SAFE_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_CONNECTION_TIMEOUT_MS = 1000;
const MIN_IDLE_TIMEOUT_MS = 5000;
const MIN_HEALTH_CHECK_INTERVAL_MS = 5000;
const MAX_HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export class ConnectionPool {
    dbPath;
    options;
    verboseLogger;
    pool = [];
    available = [];
    waiting = [];
    stats = {
        totalAcquired: 0,
        totalReleased: 0,
        totalRecycled: 0,
        timeoutErrors: 0,
    };
    healthCheckTimer = null;
    isShuttingDown = false;
    isInitialized = false;
    healthCheckErrorCount = 0;
    MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS = 5;
    static async create(dbPath, options = {}, verboseLogger) {
        const availability = await checkBetterSqlite3Availability();
        if (!availability.available) {
            const errorMsg = `Cannot create ConnectionPool: better-sqlite3 is unavailable.\n` +
                `Error: ${availability.error}\n` +
                `Suggestion: ${availability.fallbackSuggestion || 'Use Cloud-only mode with MEMESH_API_KEY'}`;
            logger.error('[ConnectionPool] Static factory failed', {
                error: availability.error,
                suggestion: availability.fallbackSuggestion,
            });
            throw new Error(errorMsg);
        }
        const pool = new ConnectionPool(dbPath, options, verboseLogger);
        await pool.initialize();
        return pool;
    }
    constructor(dbPath, options = {}, verboseLogger) {
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
        if (this.options.maxConnections < 1) {
            throw new Error('maxConnections must be at least 1');
        }
        if (this.options.maxConnections > MAX_SAFE_CONNECTIONS) {
            logger.warn(`[ConnectionPool] maxConnections (${this.options.maxConnections}) exceeds safe limit (${MAX_SAFE_CONNECTIONS}). ` +
                `Clamping to ${MAX_SAFE_CONNECTIONS} to prevent file descriptor exhaustion.`, {
                requested: this.options.maxConnections,
                clamped: MAX_SAFE_CONNECTIONS,
            });
            this.options.maxConnections = MAX_SAFE_CONNECTIONS;
        }
        if (this.options.connectionTimeout < MIN_CONNECTION_TIMEOUT_MS) {
            logger.warn(`[ConnectionPool] connectionTimeout (${this.options.connectionTimeout}ms) below safe minimum (${MIN_CONNECTION_TIMEOUT_MS}ms). ` +
                `Clamping to ${MIN_CONNECTION_TIMEOUT_MS}ms.`, {
                requested: this.options.connectionTimeout,
                clamped: MIN_CONNECTION_TIMEOUT_MS,
            });
            this.options.connectionTimeout = MIN_CONNECTION_TIMEOUT_MS;
        }
        if (this.options.connectionTimeout > MAX_SAFE_TIMEOUT_MS) {
            logger.warn(`[ConnectionPool] connectionTimeout (${this.options.connectionTimeout}ms) exceeds safe limit (${MAX_SAFE_TIMEOUT_MS}ms). ` +
                `Clamping to ${MAX_SAFE_TIMEOUT_MS}ms.`, {
                requested: this.options.connectionTimeout,
                clamped: MAX_SAFE_TIMEOUT_MS,
            });
            this.options.connectionTimeout = MAX_SAFE_TIMEOUT_MS;
        }
        if (this.options.idleTimeout < MIN_IDLE_TIMEOUT_MS) {
            logger.warn(`[ConnectionPool] idleTimeout (${this.options.idleTimeout}ms) below safe minimum (${MIN_IDLE_TIMEOUT_MS}ms). ` +
                `Clamping to ${MIN_IDLE_TIMEOUT_MS}ms.`, {
                requested: this.options.idleTimeout,
                clamped: MIN_IDLE_TIMEOUT_MS,
            });
            this.options.idleTimeout = MIN_IDLE_TIMEOUT_MS;
        }
        if (this.options.idleTimeout > MAX_SAFE_TIMEOUT_MS) {
            logger.warn(`[ConnectionPool] idleTimeout (${this.options.idleTimeout}ms) exceeds safe limit (${MAX_SAFE_TIMEOUT_MS}ms). ` +
                `Clamping to ${MAX_SAFE_TIMEOUT_MS}ms.`, {
                requested: this.options.idleTimeout,
                clamped: MAX_SAFE_TIMEOUT_MS,
            });
            this.options.idleTimeout = MAX_SAFE_TIMEOUT_MS;
        }
        if (this.options.healthCheckInterval < MIN_HEALTH_CHECK_INTERVAL_MS) {
            logger.warn(`[ConnectionPool] healthCheckInterval (${this.options.healthCheckInterval}ms) below safe minimum (${MIN_HEALTH_CHECK_INTERVAL_MS}ms). ` +
                `Clamping to ${MIN_HEALTH_CHECK_INTERVAL_MS}ms to prevent tight polling loop.`, {
                requested: this.options.healthCheckInterval,
                clamped: MIN_HEALTH_CHECK_INTERVAL_MS,
            });
            this.options.healthCheckInterval = MIN_HEALTH_CHECK_INTERVAL_MS;
        }
        if (this.options.healthCheckInterval > MAX_HEALTH_CHECK_INTERVAL_MS) {
            logger.warn(`[ConnectionPool] healthCheckInterval (${this.options.healthCheckInterval}ms) exceeds safe limit (${MAX_HEALTH_CHECK_INTERVAL_MS}ms). ` +
                `Clamping to ${MAX_HEALTH_CHECK_INTERVAL_MS}ms to ensure stale connections are detected.`, {
                requested: this.options.healthCheckInterval,
                clamped: MAX_HEALTH_CHECK_INTERVAL_MS,
            });
            this.options.healthCheckInterval = MAX_HEALTH_CHECK_INTERVAL_MS;
        }
        logger.info('ConnectionPool constructor called', {
            dbPath: this.dbPath,
            maxConnections: this.options.maxConnections,
            connectionTimeout: this.options.connectionTimeout,
            idleTimeout: this.options.idleTimeout,
        });
    }
    async initialize() {
        if (this.isInitialized) {
            throw new Error('ConnectionPool already initialized');
        }
        logger.info('Initializing connection pool', {
            dbPath: this.dbPath,
            maxConnections: this.options.maxConnections,
        });
        await this.initializePool();
        this.startHealthCheck();
        this.isInitialized = true;
        logger.info(`Connection pool initialized with ${this.pool.length} connections`);
    }
    async initializePool() {
        for (let i = 0; i < this.options.maxConnections; i++) {
            try {
                const db = await this.createConnection();
                const metadata = {
                    db,
                    lastAcquired: 0,
                    lastReleased: Date.now(),
                    usageCount: 0,
                };
                this.pool.push(metadata);
                this.available.push(metadata);
            }
            catch (error) {
                logger.error(`Failed to create connection ${i + 1}/${this.options.maxConnections}:`, error);
                throw new Error(`Pool initialization failed: ${error}`);
            }
        }
    }
    async createConnection() {
        const adapter = await BetterSqlite3Adapter.create(this.dbPath, {
            verbose: this.verboseLogger ? ((msg) => this.verboseLogger.debug('SQLite', { message: msg })) : undefined,
        });
        const db = adapter.db;
        try {
            db.pragma('busy_timeout = 5000');
        }
        catch (error) {
            logger.warn('[ConnectionPool] Could not set busy_timeout pragma:', error);
        }
        if (this.dbPath !== ':memory:') {
            try {
                const journalMode = db.pragma('journal_mode = WAL', { simple: true });
                if (journalMode.toLowerCase() !== 'wal') {
                    logger.warn('[ConnectionPool] Failed to enable WAL mode, using: ' + journalMode);
                }
            }
            catch (error) {
                logger.warn('[ConnectionPool] Could not set journal_mode to WAL:', error);
            }
            try {
                db.pragma('cache_size = -10000');
            }
            catch (error) {
                logger.debug('[ConnectionPool] Could not set cache_size:', error);
            }
            try {
                db.pragma('mmap_size = 134217728');
            }
            catch (error) {
                logger.debug('[ConnectionPool] Could not set mmap_size:', error);
            }
        }
        try {
            db.pragma('foreign_keys = ON');
            const fkEnabled = db.pragma('foreign_keys', { simple: true });
            if (fkEnabled !== 1) {
                throw new Error('Failed to enable foreign_keys pragma - database integrity cannot be guaranteed');
            }
        }
        catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            if (errMsg.includes('SQLITE_FULL')) {
                logger.error('[ConnectionPool] Database disk full. Consider freeing disk space.', {
                    dbPath: this.dbPath,
                    error: errMsg,
                });
                throw new Error('SQLITE_FULL: Database disk full. Consider freeing disk space.');
            }
            logger.error('[ConnectionPool] CRITICAL: Failed to enable foreign key constraints', { error });
            throw new Error(`Cannot create connection: foreign key constraints failed to enable. ` +
                `This is critical for database integrity. Error: ${error}`);
        }
        return adapter;
    }
    async createConnectionWithRetry(context) {
        const MAX_RETRIES = 3;
        const RETRY_DELAYS = [100, 300, 1000];
        let lastError;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                return await this.createConnection();
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const isRetryable = lastError.message.includes('SQLITE_BUSY') ||
                    lastError.message.includes('database is locked') ||
                    lastError.message.includes('SQLITE_LOCKED');
                if (!isRetryable || attempt === MAX_RETRIES - 1) {
                    throw lastError;
                }
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
        throw lastError || new Error('Connection creation failed');
    }
    isConnectionValid(db) {
        try {
            db.prepare('SELECT 1').get();
            return db.open;
        }
        catch (error) {
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
    async getValidConnection() {
        while (this.available.length > 0) {
            const metadata = this.available.shift();
            if (this.isConnectionValid(metadata.db)) {
                return metadata;
            }
            logger.warn('Found invalid connection in pool - recycling', {
                usageCount: metadata.usageCount,
            });
            try {
                metadata.db.close();
            }
            catch (error) {
                logger.debug('[ConnectionPool] Ignoring close error for invalid connection', { error });
            }
            try {
                const newDb = await this.createConnectionWithRetry('acquire fallback');
                const newMetadata = {
                    db: newDb,
                    lastAcquired: 0,
                    lastReleased: Date.now(),
                    usageCount: 0,
                };
                const poolIndex = this.pool.indexOf(metadata);
                if (poolIndex !== -1) {
                    this.pool[poolIndex] = newMetadata;
                }
                this.available.push(newMetadata);
                this.stats.totalRecycled++;
            }
            catch (error) {
                logger.error('Failed to create replacement connection:', error);
            }
        }
        return undefined;
    }
    async acquire() {
        if (!this.isInitialized) {
            throw new Error('ConnectionPool not initialized. Call initialize() or use ConnectionPool.create()');
        }
        let outerTimeoutId = null;
        try {
            const result = await Promise.race([
                this._acquireInternal(),
                new Promise((_, reject) => {
                    outerTimeoutId = setTimeout(() => {
                        this.stats.timeoutErrors++;
                        reject(new Error(`Connection acquisition timeout after ${this.options.connectionTimeout}ms`));
                    }, this.options.connectionTimeout);
                }),
            ]);
            if (outerTimeoutId) {
                clearTimeout(outerTimeoutId);
            }
            return result;
        }
        catch (error) {
            if (outerTimeoutId) {
                clearTimeout(outerTimeoutId);
            }
            throw error;
        }
    }
    async _acquireInternal() {
        if (this.isShuttingDown) {
            throw new Error('Pool is shutting down');
        }
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
        logger.debug('No available connection - queuing request', {
            waiting: this.waiting.length + 1,
        });
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                const index = this.waiting.findIndex(w => w.timeoutId === timeoutId);
                if (index !== -1) {
                    this.waiting.splice(index, 1);
                }
                reject(new Error(`Connection acquisition timeout after ${this.options.connectionTimeout}ms`));
            }, this.options.connectionTimeout);
            this.waiting.push({ resolve, reject, timeoutId });
        });
    }
    release(db) {
        if (this.isShuttingDown) {
            logger.warn('Attempted to release connection during shutdown - ignoring');
            return;
        }
        const metadata = this.pool.find(m => m.db === db);
        if (!metadata) {
            logger.error('Attempted to release unknown connection - ignoring');
            return;
        }
        const availableIndex = this.available.indexOf(metadata);
        if (availableIndex !== -1) {
            logger.warn('Connection already released - ignoring duplicate release');
            return;
        }
        metadata.lastReleased = Date.now();
        this.stats.totalReleased++;
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
        this.available.push(metadata);
        logger.debug('Connection released back to pool', {
            active: this.pool.length - this.available.length,
            idle: this.available.length,
        });
    }
    getStats() {
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
    startHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        this.healthCheckTimer = setInterval(() => {
            this.performHealthCheck()
                .then(() => {
                this.healthCheckErrorCount = 0;
            })
                .catch((error) => {
                this.healthCheckErrorCount++;
                logger.error('[ConnectionPool] Health check error:', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    consecutiveErrors: this.healthCheckErrorCount,
                });
                if (this.healthCheckErrorCount >= this.MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS) {
                    logger.error(`[ConnectionPool] Health check failed ${this.healthCheckErrorCount} times consecutively - shutting down pool`, {
                        dbPath: this.dbPath,
                        maxErrors: this.MAX_CONSECUTIVE_HEALTH_CHECK_ERRORS,
                    });
                    if (this.healthCheckTimer) {
                        clearInterval(this.healthCheckTimer);
                        this.healthCheckTimer = null;
                    }
                    this.shutdown().catch((shutdownError) => {
                        logger.error('[ConnectionPool] Shutdown after health check failures failed:', {
                            error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
                        });
                    });
                }
            });
        }, this.options.healthCheckInterval);
        this.healthCheckTimer.unref();
    }
    async performHealthCheck() {
        if (this.isShuttingDown) {
            return;
        }
        const now = Date.now();
        let recycledCount = 0;
        const staleConnections = [];
        for (let i = this.available.length - 1; i >= 0; i--) {
            const metadata = this.available[i];
            const idleTime = now - metadata.lastReleased;
            if (idleTime > this.options.idleTimeout) {
                staleConnections.push({ metadata, availableIndex: i, idleTime });
            }
        }
        for (const { metadata, idleTime } of staleConnections) {
            logger.debug('Recycling idle connection', {
                idleTime,
                usageCount: metadata.usageCount,
            });
            const currentAvailableIndex = this.available.indexOf(metadata);
            if (currentAvailableIndex !== -1) {
                this.available.splice(currentAvailableIndex, 1);
            }
            let removedFromPool = false;
            let poolIndex = this.pool.indexOf(metadata);
            try {
                metadata.db.close();
            }
            catch (error) {
                logger.error('[ConnectionPool] Error closing stale connection during health check', { error });
                if (poolIndex !== -1) {
                    this.pool.splice(poolIndex, 1);
                    removedFromPool = true;
                    logger.warn('[ConnectionPool] Removed zombie connection from pool', {
                        poolSize: this.pool.length,
                        targetSize: this.options.maxConnections,
                    });
                }
            }
            try {
                const newDb = await this.createConnectionWithRetry('health check');
                const newMetadata = {
                    db: newDb,
                    lastAcquired: 0,
                    lastReleased: now,
                    usageCount: 0,
                };
                poolIndex = this.pool.indexOf(metadata);
                if (poolIndex !== -1) {
                    this.pool[poolIndex] = newMetadata;
                }
                else if (removedFromPool || this.pool.length < this.options.maxConnections) {
                    this.pool.push(newMetadata);
                }
                this.available.push(newMetadata);
                recycledCount++;
                this.stats.totalRecycled++;
            }
            catch (error) {
                logger.error('Failed to create replacement connection:', error);
            }
        }
        if (recycledCount > 0) {
            logger.info(`Recycled ${recycledCount} idle connections`);
        }
        await this.restorePoolSize();
    }
    async restorePoolSize() {
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
                    const newDb = await this.createConnectionWithRetry('pool restoration');
                    const metadata = {
                        db: newDb,
                        lastAcquired: 0,
                        lastReleased: Date.now(),
                        usageCount: 0,
                    };
                    this.pool.push(metadata);
                    this.available.push(metadata);
                    restored++;
                }
                catch (error) {
                    logger.error('[ConnectionPool] Failed to restore pool connection:', error);
                    if (this.pool.length === 0) {
                        throw new Error('Connection pool completely degraded - no connections available. ' +
                            'Database may be locked or inaccessible.');
                    }
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
    async shutdown() {
        if (this.isShuttingDown) {
            logger.warn('Pool already shutting down');
            return;
        }
        this.isShuttingDown = true;
        logger.info('Shutting down connection pool');
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        for (const waiting of this.waiting) {
            clearTimeout(waiting.timeoutId);
            waiting.reject(new Error('Pool is shutting down'));
        }
        this.waiting.length = 0;
        const closePromises = this.pool.map(async (metadata) => {
            try {
                metadata.db.close();
            }
            catch (error) {
                logger.error('[ConnectionPool] Error closing connection during shutdown', { error });
            }
        });
        await Promise.all(closePromises);
        this.pool.length = 0;
        this.available.length = 0;
        logger.info('Connection pool shutdown complete');
    }
    isHealthy() {
        return this.pool.length === this.options.maxConnections;
    }
}
//# sourceMappingURL=ConnectionPool.js.map