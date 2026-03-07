#!/usr/bin/env node
/**
 * MCP Server Bootstrap & CLI Entry Point
 *
 * This file serves two purposes:
 * 1. MCP Server: When called without arguments (by MCP client)
 * 2. CLI Commands: When called with arguments (memesh setup, etc.)
 *
 * MCP Server Mode (Daemon Architecture):
 * - First instance becomes the daemon (singleton)
 * - Subsequent instances connect as proxy clients
 * - Daemon manages shared state (knowledge graph, memory, etc.)
 *
 * CLI Mode:
 * - Detects command-line arguments
 * - Delegates to CLI handler for interactive commands
 *
 * CRITICAL: This file must have ZERO static imports except for types.
 */

// Type-only imports (no runtime cost, compliant with "zero static imports" rule)
import type { DaemonBootstrap } from './daemon/DaemonBootstrap.js';

// StdinBufferManager is a lightweight synchronous class with no transitive dependencies,
// so importing it statically is safe and compliant with the "zero heavy imports" intent.
import { StdinBufferManager } from './StdinBufferManager.js';

// Module-level flag for MCP client connection tracking
let mcpClientConnected = false;

// Singleton stdin buffer manager for use across all bootstrap paths
const stdinManager = new StdinBufferManager();

// ============================================================================
// 🚨 STEP 0: Check if this is a CLI command
// ============================================================================
const args = process.argv.slice(2);
const hasCliArgs = args.length > 0;

if (hasCliArgs) {
  // CLI mode - delegate to CLI handler
  (async () => {
    const { runCLI } = await import('../cli/index.js');
    await runCLI();
  })().catch((error) => {
    process.stderr.write(`CLI error: ${error}\n`);
    process.exit(1);
  });
} else {
  // MCP Server mode - determine daemon vs proxy
  bootstrapWithDaemon();
}

// ============================================================================
// Module-Level Shared Functions
// ============================================================================

/**
 * MCP Installation Helper
 *
 * Detects if the server was started manually (e.g., by user running `npx` directly)
 * and shows friendly installation instructions instead of hanging indefinitely.
 *
 * Configuration:
 * - DISABLE_MCP_WATCHDOG=1: Completely disable the watchdog
 * - MCP_WATCHDOG_TIMEOUT_MS=<number>: Set custom timeout (default: 15000ms)
 */
function startMCPClientWatchdog(): void {
  // Allow disabling watchdog for testing
  if (process.env.DISABLE_MCP_WATCHDOG === '1') {
    return;
  }

  // Configurable timeout (default 15 seconds - enough for Claude Code to connect)
  const DEFAULT_WATCHDOG_TIMEOUT_MS = 15000;
  const watchdogTimeoutMs = parseInt(process.env.MCP_WATCHDOG_TIMEOUT_MS || '', 10) || DEFAULT_WATCHDOG_TIMEOUT_MS;

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  // Listen for any data on stdin (MCP protocol communication)
  const stdinHandler = () => {
    mcpClientConnected = true;
    // Cancel watchdog timer when client connects (prevents resource leak)
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  // Set once listener to detect first MCP message
  process.stdin.once('data', stdinHandler);

  // Check after timeout if any MCP client connected
  watchdogTimer = setTimeout(async () => {
    if (!mcpClientConnected) {
      // No MCP client connected - show installation status and guidance
      const chalk = await import('chalk');
      const { default: boxen } = await import('boxen');

      // Get package location
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const packageRoot = join(__dirname, '../..');

      const message = `
${chalk.default.bold.yellow('⚠️  Manual Startup Detected')}

${chalk.default.bold('Why am I seeing this?')}
  You started the MCP server manually (e.g., ${chalk.default.cyan('npx @pcircle/memesh')}).
  MeMesh is designed to be launched ${chalk.default.bold('automatically by MCP clients')}
  (Claude Code, Cursor, etc.), not run directly by users.

${chalk.default.bold('Installation Status:')}
  ${chalk.default.green('✅')} Package installed successfully
  ${chalk.default.green('✅')} Location: ${chalk.default.dim(packageRoot)}
  ${chalk.default.yellow('⚠️')}  Not connected to any MCP client

${chalk.default.bold('Next Steps:')}

  ${chalk.default.yellow('1.')} ${chalk.default.bold('Configure your MCP client')}
     Add MeMesh to Claude Code or Cursor settings

  ${chalk.default.yellow('2.')} ${chalk.default.bold('Restart your IDE')}
     Reload window to enable MCP integration

  ${chalk.default.yellow('3.')} ${chalk.default.bold('Test the connection')}
     Ask Claude: ${chalk.default.italic('"List available MCP tools"')}

${chalk.default.bold('Configuration Example:')}

  ${chalk.default.dim('Add to your MCP settings.json:')}

  ${chalk.default.cyan('"mcpServers"')}: {
    ${chalk.default.cyan('"memesh"')}: {
      ${chalk.default.cyan('"command"')}: ${chalk.default.green('"npx"')},
      ${chalk.default.cyan('"args"')}: [${chalk.default.green('"-y"')}, ${chalk.default.green('"@pcircle/memesh"')}]
    }
  }

${chalk.default.bold('For Developers:')}
  Testing MCP protocol? Use ${chalk.default.cyan('DISABLE_MCP_WATCHDOG=1')} to disable this message.

${chalk.default.bold('Documentation:')}
  ${chalk.default.underline('https://github.com/PCIRCLE-AI/claude-code-buddy#installation')}
`;

      process.stderr.write(
        boxen(message, {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'yellow',
        }) + '\n'
      );
      process.exit(0);
    }
    watchdogTimer = null;
  }, watchdogTimeoutMs);

  // Allow the timer to not prevent process exit
  if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
    watchdogTimer.unref();
  }
}

// ============================================================================
// Daemon Architecture Bootstrap
// ============================================================================

/**
 * Bootstrap with daemon architecture
 *
 * Flow:
 * 1. Check if daemon is disabled → standalone mode
 * 2. Check if healthy daemon exists → proxy mode
 * 3. Otherwise → become the daemon
 */
async function bootstrapWithDaemon() {
  // CRITICAL: Set MCP_SERVER_MODE BEFORE importing logger to disable console output
  // This prevents stdout pollution that breaks JSON-RPC communication
  process.env.MCP_SERVER_MODE = 'true';

  // CRITICAL: Start buffering stdin IMMEDIATELY to prevent data loss during async bootstrap
  // Claude Code sends 'initialize' right after spawning - we must capture it before any async ops
  stdinManager.start();

  try {
    const { DaemonBootstrap, isDaemonDisabled } = await import('./daemon/DaemonBootstrap.js');
    const { logger } = await import('../utils/logger.js');

    // Read version from package.json
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const packageJson = require('../../package.json');
    const version = packageJson.version;

    // Check if daemon mode is disabled
    if (isDaemonDisabled()) {
      logger.info('[Bootstrap] Daemon mode disabled, running standalone');
      startMCPServer();
      return;
    }

    // Determine mode
    const bootstrapper = new DaemonBootstrap({ version });
    const result = await bootstrapper.determineMode();

    logger.info('[Bootstrap] Mode determined', {
      mode: result.mode,
      reason: result.reason,
      existingDaemon: result.existingDaemon,
    });

    switch (result.mode) {
      case 'daemon':
        // Become the daemon
        await startAsDaemon(bootstrapper, version);
        break;

      case 'proxy':
        // Connect to existing daemon as proxy
        await startAsProxy(bootstrapper);
        break;

      case 'standalone':
      default:
        // Fall back to standalone mode
        startMCPServer();
        break;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const errCode = (error as NodeJS.ErrnoException)?.code;

    // Classify error: unrecoverable errors should be reported clearly
    const isPermissionError = errCode === 'EACCES' || errCode === 'EPERM';
    const isDiskError = errCode === 'ENOSPC' || errCode === 'EROFS';
    const isSocketError = errCode === 'EADDRINUSE' || errCode === 'ECONNREFUSED' || errCode === 'ETIMEDOUT';

    if (isPermissionError || isDiskError) {
      process.stderr.write(
        `[Bootstrap] Daemon bootstrap failed (${errCode}): ${msg}\n` +
        `[Bootstrap] This may indicate a system-level issue. Falling back to standalone mode.\n`
      );
    } else if (isSocketError) {
      process.stderr.write(
        `[Bootstrap] Socket issue (${errCode}): ${msg}\n` +
        `[Bootstrap] Daemon may be unresponsive or stale socket exists. Falling back to standalone mode.\n`
      );
    } else {
      process.stderr.write(`[Bootstrap] Daemon bootstrap failed, falling back to standalone: ${msg}\n`);
    }

    startMCPServer();
  }
}

/**
 * Setup graceful shutdown signal handlers.
 * Extracts common signal handling logic used by both daemon and proxy modes.
 *
 * @param shutdownFn - Async function to execute on shutdown signal
 */
function setupSignalHandlers(shutdownFn: (signal: string) => Promise<void>): void {
  process.once('SIGTERM', () => shutdownFn('SIGTERM'));
  process.once('SIGINT', () => shutdownFn('SIGINT'));
}

// ============================================================================
// Global Error Handlers
// ============================================================================
// Registered at module level to catch errors in ALL modes (daemon, proxy, standalone).
// Uses process.stderr.write() instead of logger because:
// - Logger might not be initialized yet
// - MCP uses stdio transport, so stdout must not be polluted
// - stderr is the safe channel for error output
// ============================================================================

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const errorStack = reason instanceof Error ? reason.stack : undefined;
  process.stderr.write(
    `[MeMesh] Unhandled Promise Rejection: ${errorMessage}\n${errorStack || ''}\n`
  );
});

// Note: daemon mode registers its own uncaughtException handler with socket cleanup
// This module-level handler is for standalone/proxy modes only
if (!process.env.MEMESH_DAEMON_MODE) {
  process.on('uncaughtException', (error: Error) => {
    process.stderr.write(
      `[MeMesh] Uncaught Exception: ${error.message}\n${error.stack || ''}\n`
    );
    process.exit(1);
  });
}

/**
 * Start as the daemon (first instance)
 */
async function startAsDaemon(bootstrapper: DaemonBootstrap, version: string) {
  // CRITICAL: Set MCP_SERVER_MODE BEFORE importing logger to disable console output
  // This prevents stdout pollution that breaks JSON-RPC communication
  process.env.MCP_SERVER_MODE = 'true';
  // Signal daemon mode so module-level handlers defer to daemon-specific cleanup handlers
  process.env.MEMESH_DAEMON_MODE = '1';

  const { logger } = await import('../utils/logger.js');
  const { DaemonSocketServer } = await import('./daemon/DaemonSocketServer.js');
  const { DaemonLockManager } = await import('./daemon/DaemonLockManager.js');

  // Acquire the daemon lock
  const lockAcquired = await bootstrapper.acquireDaemonLock();
  if (!lockAcquired) {
    logger.warn('[Bootstrap] Failed to acquire daemon lock, falling back to standalone');
    startMCPServer();
    return;
  }

  logger.info('[Bootstrap] Starting as daemon', { version, pid: process.pid });

  // Set environment variable
  process.env.MCP_SERVER_MODE = 'true';

  // Initialize MCP server with error handling
  let mcpServer;
  try {
    const { ClaudeCodeBuddyMCPServer } = await import('./server.js');
    mcpServer = await ClaudeCodeBuddyMCPServer.create();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[Daemon] MCP server initialization failed', { error: msg });
    // Release lock and clean up transport since we can't serve as daemon
    try { await DaemonLockManager.releaseLock(); } catch { /* best effort */ }
    try { bootstrapper.getTransport().cleanup(); } catch { /* best effort */ }
    stdinManager.stopAndReplay();
    // Fall back to standalone which has its own error handling
    logger.warn('[Daemon] Falling back to standalone mode');
    startMCPServer();
    return;
  }

  // Create daemon socket server to accept proxy connections
  const transport = bootstrapper.getTransport();
  const socketServer = new DaemonSocketServer({
    transport,
    version,
  });

  // Handle client connection events (lock file client count is managed by DaemonSocketServer)
  socketServer.on('client_connect', (client) => {
    logger.info('[Daemon] Client connected', { clientId: client.clientId, version: client.version });
  });

  socketServer.on('client_disconnect', (clientId: string) => {
    logger.info('[Daemon] Client disconnected', { clientId });
  });

  // Start socket server with error handling
  // NOTE: MCP handler is registered AFTER mcpServer.start() below to prevent
  // proxy clients from sending requests to an unstarted MCP server.
  try {
    await socketServer.start();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[Daemon] Socket server failed to start', {
      error: msg,
      socketPath: transport.getPath(),
    });
    // Release lock since socket server can't accept connections
    try { await DaemonLockManager.releaseLock(); } catch { /* best effort */ }
    try { transport.cleanup(); } catch { /* best effort */ }
    // Fall back to standalone (stdio-only, no daemon socket)
    logger.warn('[Daemon] Socket server unavailable, falling back to standalone mode');
    stdinManager.stopAndReplay();
    await mcpServer.start();
    startMCPClientWatchdog();
    return;
  }
  logger.info('[Daemon] Socket server started', { path: transport.getPath() });

  // CRITICAL: Stop stdin buffering and replay data BEFORE starting MCP server
  // This ensures the 'initialize' message reaches the transport
  stdinManager.stopAndReplay();

  // Also start the MCP server for direct stdio communication (first client)
  await mcpServer.start();

  // Register MCP handler AFTER server is started to prevent race condition
  // where proxy clients send requests to an unstarted MCP server
  socketServer.setMcpHandler(async (request: unknown) => {
    return mcpServer.handleRequest(request);
  });

  // Cleanup function for socket and lock
  const cleanupDaemon = async (reason: string): Promise<void> => {
    logger.info('[Daemon] Cleanup started', { reason });

    try {
      // Stop accepting new connections
      await socketServer.stop();
    } catch (error) {
      logger.warn('[Daemon] Error stopping socket server', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Release lock
    try {
      await DaemonLockManager.releaseLock();
    } catch (error) {
      logger.warn('[Daemon] Error releasing lock', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // CRITICAL: Clean up socket file to prevent stale socket issues
    // This must happen AFTER socketServer.stop() closes all connections
    try {
      transport.cleanup();
      logger.info('[Daemon] Socket file cleaned up');
    } catch (error) {
      logger.warn('[Daemon] Error cleaning up socket file', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('[Daemon] Cleanup complete');
  };

  // Setup graceful shutdown for signals
  setupSignalHandlers(async (signal: string) => {
    logger.info('[Daemon] Shutdown requested', { signal });
    await cleanupDaemon(`signal:${signal}`);
    process.exit(0);
  });

  // Handle uncaught exceptions - cleanup socket before crashing
  process.once('uncaughtException', async (error: Error) => {
    logger.error('[Daemon] Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
    await cleanupDaemon('uncaughtException');
    process.exit(1);
  });

  // Handle unhandled promise rejections - cleanup socket before crashing
  process.once('unhandledRejection', async (reason: unknown) => {
    logger.error('[Daemon] Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    await cleanupDaemon('unhandledRejection');
    process.exit(1);
  });

  // Start watchdog for manual startup detection
  startMCPClientWatchdog();

  // Background preload ONNX embedding model — don't await, don't block startup
  // Daemon has longer lifetime, so preloading here eliminates 10-20s cold start on first semantic search
  import('../embeddings/EmbeddingService.js').then(({ LazyEmbeddingService }) => {
    LazyEmbeddingService.preload().catch(() => {
      // Non-critical, first search will load model on demand
    });
  });
}

/**
 * Start as proxy client (subsequent instances)
 */
async function startAsProxy(bootstrapper: DaemonBootstrap) {
  // CRITICAL: Set MCP_SERVER_MODE BEFORE importing logger to disable console output
  process.env.MCP_SERVER_MODE = 'true';

  const { logger } = await import('../utils/logger.js');
  const { StdioProxyClient } = await import('./daemon/StdioProxyClient.js');

  const version = bootstrapper.getVersion();
  logger.info('[Bootstrap] Starting as proxy client', { version });

  const transport = bootstrapper.getTransport();
  const proxyClient = new StdioProxyClient({
    transport,
    clientVersion: version,
    maxReconnectAttempts: 5,
    reconnectDelay: 1000,
  });

  // Handle proxy events
  proxyClient.on('connected', () => {
    logger.info('[Proxy] Connected to daemon');
  });

  proxyClient.on('disconnected', (reason: string) => {
    logger.warn('[Proxy] Disconnected from daemon', { reason });
  });

  proxyClient.on('error', (error: Error) => {
    logger.error('[Proxy] Error', { error: error.message });
  });

  proxyClient.on('shutdown', (reason: string) => {
    logger.info('[Proxy] Daemon requested shutdown', { reason });
    process.exit(0);
  });

  // CRITICAL: Stop stdin buffering and replay data BEFORE starting proxy
  // This ensures the 'initialize' message reaches the proxy client
  stdinManager.stopAndReplay();

  // Start proxying stdin/stdout to daemon with error handling
  try {
    await proxyClient.start();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[Proxy] Failed to connect to daemon', { error: msg });
    // Clean up partially-initialized proxy client
    try { await proxyClient.stop(); } catch { /* best effort */ }
    // Daemon may have died between determineMode() and start()
    // Fall back to standalone mode
    logger.warn('[Proxy] Falling back to standalone mode');
    startMCPServer();
    return;
  }

  logger.info('[Proxy] Proxy started, forwarding stdio to daemon');

  // Graceful shutdown
  setupSignalHandlers(async (signal: string) => {
    logger.info('[Proxy] Shutdown requested', { signal });
    await proxyClient.stop();
    process.exit(0);
  });
}

// ============================================================================
// Standalone Mode (Legacy / Fallback)
// ============================================================================

/**
 * Start MCP server in standalone mode (no daemon)
 */
function startMCPServer() {
  // Set MCP_SERVER_MODE before ANY imports
  process.env.MCP_SERVER_MODE = 'true';

  async function bootstrap() {
    try {
      // Start initialization watchdog to detect incorrect usage
      startMCPClientWatchdog();

      // Dynamic import ensures environment variable is set BEFORE module loading
      const { ClaudeCodeBuddyMCPServer } = await import('./server.js');

      // Start MCP server (using async factory method)
      const mcpServer = await ClaudeCodeBuddyMCPServer.create();

      // CRITICAL: Stop stdin buffering and replay data BEFORE starting MCP server
      // This ensures the 'initialize' message reaches the transport
      stdinManager.stopAndReplay();

      await mcpServer.start();

      // server.connect() keeps the process alive - no need for infinite promise
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const errCode = (error as NodeJS.ErrnoException)?.code;
      process.stderr.write(`[MeMesh] Fatal startup error: ${msg}\n`);

      // Provide recovery hints for common errors
      if (errCode === 'EACCES' || errCode === 'EPERM') {
        process.stderr.write('[MeMesh] Hint: Check file permissions for the MeMesh data directory.\n');
      } else if (msg.includes('better-sqlite3') || msg.includes('SQLite')) {
        process.stderr.write('[MeMesh] Hint: Run "npm rebuild better-sqlite3" to rebuild native module.\n');
      } else if (msg.includes('ENOSPC')) {
        process.stderr.write('[MeMesh] Hint: Disk is full. Free up space and try again.\n');
      }
      process.exit(1);
    }
  }

  /**
   * Graceful shutdown handler with timeout protection
   * Note: No console output in MCP stdio mode to avoid polluting the protocol channel
   */
  async function shutdown(signal: string): Promise<void> {
    const SHUTDOWN_TIMEOUT_MS = 5000;
    const shutdownTimeout = setTimeout(() => {
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Cleanup work would go here
      clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch {
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  }

  // Setup signal handlers for graceful shutdown
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  // Start bootstrap
  bootstrap();
}
