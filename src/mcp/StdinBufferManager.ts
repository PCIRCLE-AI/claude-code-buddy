/**
 * StdinBufferManager - Handles stdin buffering during MCP initialization
 *
 * Problem: Claude Code sends 'initialize' immediately after spawning the server.
 * During daemon/proxy bootstrap (lock checks, socket setup, etc.), stdin data
 * arrives BEFORE the MCP transport is connected, causing "Method not found" errors.
 *
 * Solution: Pause stdin immediately, buffer data during bootstrap, then replay
 * once the transport is connected.
 */
export class StdinBufferManager {
  private buffer: Buffer[] = [];
  private active = false;
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  /**
   * Start buffering stdin data.
   * Call this IMMEDIATELY when MCP server mode starts, before any async operations.
   */
  start(): void {
    if (this.active) return;
    this.active = true;

    // Check if stdin is readable before attempting to pause
    if (!process.stdin.readable) {
      this.active = false;
      return;
    }

    try {
      process.stdin.pause();
    } catch (err) {
      // stdin may already be in an unusable state
      this.active = false;
      return;
    }

    // Buffer any data that arrives
    this.dataHandler = (chunk: Buffer) => {
      this.buffer.push(chunk);
    };

    this.errorHandler = (err: Error) => {
      // On stdin error, stop buffering and attempt replay of what we have
      process.stderr.write(`[Bootstrap] stdin error during buffering: ${err.message}\n`);
      this.stopAndReplay();
    };

    process.stdin.on('data', this.dataHandler);
    process.stdin.once('error', this.errorHandler);
  }

  /**
   * Stop buffering and replay buffered data.
   * Call this AFTER the MCP transport is connected.
   */
  stopAndReplay(): void {
    if (!this.active) return;
    this.active = false;

    // Remove our buffer handler
    if (this.dataHandler) {
      process.stdin.removeListener('data', this.dataHandler);
      this.dataHandler = null;
    }

    // Remove error handler
    if (this.errorHandler) {
      process.stdin.removeListener('error', this.errorHandler);
      this.errorHandler = null;
    }

    // Replay buffered data by unshifting back to the stream
    // The MCP transport will receive this data when it starts reading
    if (this.buffer.length > 0) {
      const combined = Buffer.concat(this.buffer);
      this.buffer.length = 0; // Clear buffer

      // Unshift the data back to stdin so the transport receives it
      process.stdin.unshift(combined);
    }

    // Resume stdin for normal operation
    try {
      process.stdin.resume();
    } catch (err) {
      process.stderr.write(`[StdinBufferManager] Failed to resume stdin: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /**
   * Whether stdin buffering is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Number of buffered chunks.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
