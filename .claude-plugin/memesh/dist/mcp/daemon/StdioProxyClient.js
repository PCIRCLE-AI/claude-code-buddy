import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MessageType, createHandshake, createMcpRequest, parseMessage, serializeMessage, MESSAGE_DELIMITER, } from './DaemonProtocol.js';
import { logger } from '../../utils/logger.js';
export const DEFAULT_MAX_RECEIVE_BUFFER_SIZE = 10 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 60000;
export const MESSAGE_STALE_THRESHOLD_MS = 5 * 60 * 1000;
export class StdioProxyClient extends EventEmitter {
    config;
    socket = null;
    clientId;
    assignedClientId = null;
    connected = false;
    connecting = false;
    stopped = false;
    connectionStartTime = null;
    receiveBuffer = '';
    pendingRequests = new Map();
    messageBuffer = [];
    bufferSize = 0;
    reconnectAttempts = 0;
    reconnectTimer = null;
    heartbeatTimer = null;
    requestsForwarded = 0;
    reconnects = 0;
    stdinDataListener = null;
    stdinEndListener = null;
    stdinBuffer = '';
    handshakeBuffer = '';
    constructor(config) {
        super();
        this.config = {
            transport: config.transport,
            clientVersion: config.clientVersion,
            maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
            reconnectDelay: config.reconnectDelay ?? 1000,
            bufferSizeLimit: config.bufferSizeLimit ?? DEFAULT_MAX_RECEIVE_BUFFER_SIZE,
            maxReceiveBufferSize: config.maxReceiveBufferSize ?? DEFAULT_MAX_RECEIVE_BUFFER_SIZE,
            maxStdinBufferSize: config.maxStdinBufferSize ?? DEFAULT_MAX_RECEIVE_BUFFER_SIZE,
            heartbeatInterval: config.heartbeatInterval ?? 30000,
            stdin: config.stdin ?? process.stdin,
            stdout: config.stdout ?? process.stdout,
            capabilities: config.capabilities ?? [],
        };
        this.clientId = uuidv4();
    }
    async start() {
        if (this.connected || this.connecting) {
            throw new Error('Proxy client already started');
        }
        this.stopped = false;
        this.setupStdinHandler();
        try {
            await this.connectToDaemon();
            this.startHeartbeat();
        }
        catch (error) {
            if (this.stdinDataListener) {
                this.config.stdin.removeListener('data', this.stdinDataListener);
                this.stdinDataListener = null;
            }
            if (this.stdinEndListener) {
                this.config.stdin.removeListener('end', this.stdinEndListener);
                this.stdinEndListener = null;
            }
            this.stopped = true;
            throw error;
        }
    }
    async stop() {
        this.stopped = true;
        this.connecting = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopHeartbeat();
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Proxy client stopped'));
        }
        this.pendingRequests.clear();
        this.messageBuffer = [];
        this.bufferSize = 0;
        this.stdinBuffer = '';
        this.handshakeBuffer = '';
        if (this.stdinDataListener) {
            this.config.stdin.removeListener('data', this.stdinDataListener);
            this.stdinDataListener = null;
        }
        if (this.stdinEndListener) {
            this.config.stdin.removeListener('end', this.stdinEndListener);
            this.stdinEndListener = null;
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.connectionStartTime = null;
    }
    isConnected() {
        return this.connected;
    }
    getStats() {
        return {
            requestsForwarded: this.requestsForwarded,
            reconnects: this.reconnects,
            bufferedMessages: this.messageBuffer.length,
            bufferSizeBytes: this.bufferSize,
            connectionUptime: this.connectionStartTime ? Date.now() - this.connectionStartTime : 0,
        };
    }
    getClientId() {
        return this.assignedClientId ?? this.clientId;
    }
    async connectToDaemon() {
        this.connecting = true;
        try {
            this.socket = await this.config.transport.connect({
                timeout: 5000,
            });
            this.setupSocketHandlers();
            await this.performHandshake();
            this.connected = true;
            this.connecting = false;
            this.connectionStartTime = Date.now();
            this.reconnectAttempts = 0;
            await this.flushMessageBuffer();
            this.emit('connected');
            logger.info('[StdioProxyClient] Connected to daemon', {
                clientId: this.getClientId(),
            });
        }
        catch (error) {
            this.connecting = false;
            if (this.socket) {
                this.socket.destroy();
                this.socket = null;
            }
            this.receiveBuffer = '';
            this.handshakeBuffer = '';
            throw error;
        }
    }
    setupSocketHandlers() {
        if (!this.socket)
            return;
        this.socket.on('data', (data) => {
            this.handleSocketData(data);
        });
        this.socket.on('close', () => {
            this.handleDisconnect('socket_closed');
        });
        this.socket.on('error', (error) => {
            logger.error('[StdioProxyClient] Socket error', {
                error: error.message,
            });
            this.emit('error', error);
        });
        this.socket.on('end', () => {
            this.handleDisconnect('socket_ended');
        });
    }
    handleSocketData(data) {
        const dataStr = data.toString();
        const incomingSize = Buffer.byteLength(dataStr, 'utf8');
        const currentSize = Buffer.byteLength(this.receiveBuffer, 'utf8');
        if (currentSize + incomingSize > this.config.maxReceiveBufferSize) {
            logger.error('[StdioProxyClient] Receive buffer overflow - clearing buffer to recover', {
                currentBufferSize: currentSize,
                incomingDataSize: incomingSize,
                maxBufferSize: this.config.maxReceiveBufferSize,
                bufferPreview: this.receiveBuffer.slice(0, 200),
            });
            this.receiveBuffer = '';
            this.emit('error', new Error(`Receive buffer overflow: buffer size (${currentSize}) + incoming data (${incomingSize}) ` +
                `exceeds limit (${this.config.maxReceiveBufferSize}). Buffer cleared.`));
            return;
        }
        this.receiveBuffer += dataStr;
        let newlineIndex;
        while ((newlineIndex = this.receiveBuffer.indexOf(MESSAGE_DELIMITER)) !== -1) {
            const messageStr = this.receiveBuffer.slice(0, newlineIndex);
            this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
            if (messageStr.trim()) {
                this.handleDaemonMessage(messageStr);
            }
        }
    }
    handleDaemonMessage(messageStr) {
        const message = parseMessage(messageStr);
        if (!message) {
            logger.warn('[StdioProxyClient] Failed to parse daemon message', {
                message: messageStr.slice(0, 100),
            });
            return;
        }
        switch (message.type) {
            case MessageType.MCP_RESPONSE:
                this.handleMcpResponse(message);
                break;
            case MessageType.HEARTBEAT_ACK:
                logger.debug('[StdioProxyClient] Heartbeat acknowledged');
                break;
            case MessageType.SHUTDOWN:
                this.handleShutdown(message);
                break;
            case MessageType.ERROR:
                this.handleError(message);
                break;
            case MessageType.UPGRADE_PENDING:
                logger.info('[StdioProxyClient] Upgrade pending', {
                    message,
                });
                break;
            default:
                logger.debug('[StdioProxyClient] Unhandled message type', {
                    type: message.type,
                });
        }
    }
    handleMcpResponse(response) {
        const pending = this.pendingRequests.get(response.requestId);
        if (!pending) {
            logger.warn('[StdioProxyClient] Received response for unknown request', {
                requestId: response.requestId,
            });
            return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.requestId);
        this.writeToStdout(response.payload);
        pending.resolve(response.payload);
    }
    handleShutdown(message) {
        logger.info('[StdioProxyClient] Daemon shutting down', {
            reason: message.reason,
            gracePeriod: message.gracePeriod,
        });
        this.emit('shutdown', message.reason);
        if (!this.stopped && message.reason === 'upgrade') {
            setTimeout(() => {
                this.attemptReconnect();
            }, message.gracePeriod + 1000);
        }
    }
    handleError(message) {
        logger.error('[StdioProxyClient] Daemon error', {
            code: message.code,
            message: message.message,
            requestId: message.requestId,
        });
        if (message.requestId) {
            const pending = this.pendingRequests.get(message.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(message.requestId);
                pending.reject(new Error(`Daemon error: ${message.code} - ${message.message}`));
            }
        }
    }
    handleDisconnect(reason) {
        if (this.stopped)
            return;
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.receiveBuffer = '';
        if (wasConnected) {
            logger.warn('[StdioProxyClient] Disconnected from daemon', { reason });
            this.emit('disconnected', reason);
        }
        if (!this.stopped) {
            this.attemptReconnect();
        }
    }
    async performHandshake() {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Socket not connected'));
                return;
            }
            this.handshakeBuffer = '';
            const timeoutId = setTimeout(() => {
                this.socket?.removeListener('data', handleHandshakeData);
                this.handshakeBuffer = '';
                reject(new Error('Handshake timeout'));
            }, 5000);
            const handleHandshakeData = (data) => {
                this.handshakeBuffer += data.toString();
                const newlineIndex = this.handshakeBuffer.indexOf(MESSAGE_DELIMITER);
                if (newlineIndex === -1) {
                    return;
                }
                const messageStr = this.handshakeBuffer.slice(0, newlineIndex).trim();
                this.handshakeBuffer = this.handshakeBuffer.slice(newlineIndex + 1);
                const message = parseMessage(messageStr);
                if (!message || message.type !== MessageType.HANDSHAKE_ACK) {
                    clearTimeout(timeoutId);
                    this.socket?.removeListener('data', handleHandshakeData);
                    this.handshakeBuffer = '';
                    reject(new Error(`Invalid handshake response: ${messageStr.slice(0, 100)}`));
                    return;
                }
                const ack = message;
                if (!ack.success) {
                    clearTimeout(timeoutId);
                    this.socket?.removeListener('data', handleHandshakeData);
                    this.handshakeBuffer = '';
                    reject(new Error(`Handshake failed: ${ack.error}`));
                    return;
                }
                this.assignedClientId = ack.assignedClientId;
                if (ack.upgradeRecommended) {
                    this.emit('upgrade_available', ack.daemonVersion);
                }
                clearTimeout(timeoutId);
                this.socket?.removeListener('data', handleHandshakeData);
                this.handshakeBuffer = '';
                resolve();
            };
            this.socket.on('data', handleHandshakeData);
            const handshake = createHandshake(this.clientId, this.config.clientVersion, this.config.capabilities);
            this.socket.write(serializeMessage(handshake));
        });
    }
    setupStdinHandler() {
        this.stdinDataListener = (data) => {
            const dataStr = data.toString();
            const incomingSize = Buffer.byteLength(dataStr, 'utf8');
            const currentSize = Buffer.byteLength(this.stdinBuffer, 'utf8');
            if (currentSize + incomingSize > this.config.maxStdinBufferSize) {
                logger.error('[StdioProxyClient] Stdin buffer overflow - clearing buffer to recover', {
                    currentBufferSize: currentSize,
                    incomingDataSize: incomingSize,
                    maxBufferSize: this.config.maxStdinBufferSize,
                    bufferPreview: this.stdinBuffer.slice(0, 200),
                });
                this.stdinBuffer = '';
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32700,
                        message: `Stdin buffer overflow: input exceeded ${this.config.maxStdinBufferSize} bytes without delimiter`,
                    },
                };
                this.writeToStdout(errorResponse);
                return;
            }
            this.stdinBuffer += dataStr;
            let newlineIndex;
            while ((newlineIndex = this.stdinBuffer.indexOf('\n')) !== -1) {
                const line = this.stdinBuffer.slice(0, newlineIndex);
                this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
                if (line.trim()) {
                    this.handleStdinMessage(line);
                }
            }
        };
        this.stdinEndListener = () => {
            logger.info('[StdioProxyClient] stdin ended');
            this.stop();
        };
        this.config.stdin.on('data', this.stdinDataListener);
        this.config.stdin.on('end', this.stdinEndListener);
    }
    handleStdinMessage(messageStr) {
        let payload;
        try {
            payload = JSON.parse(messageStr);
        }
        catch (error) {
            logger.error('[StdioProxyClient] Failed to parse stdin JSON', {
                error: error instanceof Error ? error.message : String(error),
                message: messageStr.slice(0, 100),
            });
            return;
        }
        this.forwardMcpRequest(payload);
    }
    forwardMcpRequest(payload) {
        const requestId = uuidv4();
        if (!this.connected) {
            this.bufferMessage(requestId, payload);
            return;
        }
        this.sendMcpRequest(requestId, payload);
    }
    sendMcpRequest(requestId, payload) {
        if (!this.socket || !this.connected) {
            this.bufferMessage(requestId, payload);
            return;
        }
        const pending = {
            requestId,
            resolve: () => { },
            reject: () => { },
            timeout: setTimeout(() => {
                this.pendingRequests.delete(requestId);
                logger.warn('[StdioProxyClient] Request timeout', { requestId });
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: payload?.id ?? null,
                    error: {
                        code: -32000,
                        message: 'Request timeout - daemon did not respond',
                    },
                };
                this.writeToStdout(errorResponse);
            }, REQUEST_TIMEOUT_MS),
        };
        new Promise((resolve, reject) => {
            pending.resolve = resolve;
            pending.reject = reject;
        }).catch(() => {
        });
        this.pendingRequests.set(requestId, pending);
        const request = createMcpRequest(requestId, this.getClientId(), payload);
        this.socket.write(serializeMessage(request));
        this.requestsForwarded++;
        logger.debug('[StdioProxyClient] Forwarded MCP request', {
            requestId,
            method: payload?.method,
        });
    }
    bufferMessage(requestId, payload) {
        const messageStr = JSON.stringify(payload);
        const messageSize = Buffer.byteLength(messageStr, 'utf8');
        if (this.bufferSize + messageSize > this.config.bufferSizeLimit) {
            logger.error('[StdioProxyClient] Message buffer full, dropping message', {
                requestId,
                bufferSize: this.bufferSize,
                limit: this.config.bufferSizeLimit,
            });
            const errorResponse = {
                jsonrpc: '2.0',
                id: payload?.id ?? null,
                error: {
                    code: -32000,
                    message: 'Daemon disconnected and message buffer full',
                },
            };
            this.writeToStdout(errorResponse);
            return;
        }
        this.messageBuffer.push({
            requestId,
            payload,
            timestamp: Date.now(),
        });
        this.bufferSize += messageSize;
        logger.debug('[StdioProxyClient] Buffered message during reconnect', {
            requestId,
            bufferCount: this.messageBuffer.length,
            bufferSize: this.bufferSize,
        });
    }
    async flushMessageBuffer() {
        if (this.messageBuffer.length === 0)
            return;
        logger.info('[StdioProxyClient] Flushing buffered messages', {
            count: this.messageBuffer.length,
        });
        const messages = [...this.messageBuffer];
        this.messageBuffer = [];
        this.bufferSize = 0;
        for (const buffered of messages) {
            if (Date.now() - buffered.timestamp > MESSAGE_STALE_THRESHOLD_MS) {
                logger.warn('[StdioProxyClient] Dropping stale buffered message', {
                    requestId: buffered.requestId,
                    age: Date.now() - buffered.timestamp,
                });
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: buffered.payload?.id ?? null,
                    error: {
                        code: -32000,
                        message: 'Request expired during reconnection',
                    },
                };
                this.writeToStdout(errorResponse);
                continue;
            }
            this.sendMcpRequest(buffered.requestId, buffered.payload);
        }
    }
    attemptReconnect() {
        if (this.stopped || this.connecting || this.connected)
            return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            logger.error('[StdioProxyClient] Max reconnect attempts reached', {
                attempts: this.reconnectAttempts,
                maxAttempts: this.config.maxReconnectAttempts,
            });
            this.rejectAllPending('Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        this.reconnects++;
        const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        logger.info('[StdioProxyClient] Attempting reconnect', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.config.maxReconnectAttempts,
            delay,
        });
        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connectToDaemon();
                this.startHeartbeat();
            }
            catch (error) {
                logger.warn('[StdioProxyClient] Reconnect failed', {
                    error: error instanceof Error ? error.message : String(error),
                });
                this.attemptReconnect();
            }
        }, delay);
    }
    rejectAllPending(reason) {
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(reason));
        }
        this.pendingRequests.clear();
        for (const buffered of this.messageBuffer) {
            const errorResponse = {
                jsonrpc: '2.0',
                id: buffered.payload?.id ?? null,
                error: {
                    code: -32000,
                    message: reason,
                },
            };
            this.writeToStdout(errorResponse);
        }
        this.messageBuffer = [];
        this.bufferSize = 0;
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.connected || !this.socket)
                return;
            const heartbeat = {
                type: MessageType.HEARTBEAT,
                timestamp: Date.now(),
                clientId: this.getClientId(),
            };
            this.socket.write(serializeMessage(heartbeat));
            logger.debug('[StdioProxyClient] Sent heartbeat');
        }, this.config.heartbeatInterval);
        this.heartbeatTimer.unref();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    writeToStdout(payload) {
        const output = JSON.stringify(payload) + '\n';
        this.config.stdout.write(output);
    }
}
export function createStdioProxyClient(transport, clientVersion, options) {
    return new StdioProxyClient({
        transport,
        clientVersion,
        ...options,
    });
}
//# sourceMappingURL=StdioProxyClient.js.map