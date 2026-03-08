export class StdinBufferManager {
    buffer = [];
    active = false;
    dataHandler = null;
    errorHandler = null;
    start() {
        if (this.active)
            return;
        this.active = true;
        if (!process.stdin.readable) {
            this.active = false;
            return;
        }
        try {
            process.stdin.pause();
        }
        catch (err) {
            this.active = false;
            return;
        }
        this.dataHandler = (chunk) => {
            this.buffer.push(chunk);
        };
        this.errorHandler = (err) => {
            process.stderr.write(`[Bootstrap] stdin error during buffering: ${err.message}\n`);
            this.stopAndReplay();
        };
        process.stdin.on('data', this.dataHandler);
        process.stdin.once('error', this.errorHandler);
    }
    stopAndReplay() {
        if (!this.active)
            return;
        this.active = false;
        if (this.dataHandler) {
            process.stdin.removeListener('data', this.dataHandler);
            this.dataHandler = null;
        }
        if (this.errorHandler) {
            process.stdin.removeListener('error', this.errorHandler);
            this.errorHandler = null;
        }
        if (this.buffer.length > 0) {
            const combined = Buffer.concat(this.buffer);
            this.buffer.length = 0;
            process.stdin.unshift(combined);
        }
        try {
            process.stdin.resume();
        }
        catch (err) {
            process.stderr.write(`[StdinBufferManager] Failed to resume stdin: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    isActive() {
        return this.active;
    }
    getBufferSize() {
        return this.buffer.length;
    }
}
//# sourceMappingURL=StdinBufferManager.js.map