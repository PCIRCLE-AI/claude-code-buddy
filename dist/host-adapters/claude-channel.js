import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
export const CLAUDE_CHANNEL_CAPABILITIES = {
    experimental: { 'claude/channel': {} },
};
export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
const ROUTER_PROTOCOL = 'memesh.local-router/v1';
const ADAPTER_NAME = 'claude-channel';
const META_KEY = /^[A-Za-z0-9_]+$/;
const MAX_IDENTITY_BYTES = 200;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 16 * 1024;
const DEFAULT_MAX_META_ENTRIES = 16;
const DEFAULT_MAX_META_VALUE_BYTES = 512;
const DEFAULT_MAX_QUEUE_ITEMS = 32;
const DEFAULT_MAX_QUEUE_BYTES = 128 * 1024;
export function createClaudeChannelServer(serverInfo, instructions) {
    const options = {
        capabilities: CLAUDE_CHANNEL_CAPABILITIES,
        instructions,
    };
    return new Server(serverInfo, options);
}
export function createClaudeChannelAdapter(options) {
    const identity = normalizeIdentity(options.identity);
    const trustedRouterPrincipal = requireBoundedText(options.trustedRouterPrincipal, 'trustedRouterPrincipal', MAX_IDENTITY_BYTES);
    const routerSocketPath = requireRouterSocketPath(options.routerSocketPath);
    const limits = normalizeLimits(options);
    const connector = options.connector ?? privateLocalRouterConnector;
    let active = false;
    let busy = false;
    let socket;
    let receiveBuffer = Buffer.alloc(0);
    let queue = [];
    let queuedBytes = 0;
    function clearSessionState() {
        active = false;
        busy = false;
        receiveBuffer = Buffer.alloc(0);
        queue = [];
        queuedBytes = 0;
    }
    async function emit(notification) {
        try {
            await options.notifier.notification(notification);
            return true;
        }
        catch {
            clearSessionState();
            return false;
        }
    }
    async function flush() {
        while (active && !busy && queue.length > 0) {
            const entry = queue.shift();
            queuedBytes -= entry.bytes;
            if (!await emit(entry.notification))
                return;
        }
    }
    async function acceptRouterFrame(frame) {
        if (!active || !isDelivery(frame, trustedRouterPrincipal, identity, limits))
            return false;
        const notification = {
            method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
            params: {
                content: frame.content,
                meta: sanitizeMeta(frame.meta, limits),
            },
        };
        const bytes = byteLength(notification.params.content) + byteLength(JSON.stringify(notification.params.meta));
        if (busy) {
            if (queue.length >= limits.queueItems || queuedBytes + bytes > limits.queueBytes)
                return false;
            queue.push({ notification, bytes });
            queuedBytes += bytes;
            return true;
        }
        return emit(notification);
    }
    function receive(chunk) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length > limits.frameBytes || receiveBuffer.length + bytes.length > limits.frameBytes) {
            socket?.destroy();
            clearSessionState();
            return;
        }
        receiveBuffer = Buffer.concat([receiveBuffer, bytes]);
        for (;;) {
            const newline = receiveBuffer.indexOf(0x0a);
            if (newline < 0)
                return;
            const raw = receiveBuffer.subarray(0, newline);
            receiveBuffer = receiveBuffer.subarray(newline + 1);
            if (raw.length === 0 || raw.length > limits.frameBytes)
                continue;
            let frame;
            try {
                frame = JSON.parse(raw.toString('utf8'));
            }
            catch {
                continue;
            }
            void acceptRouterFrame(frame);
        }
    }
    return {
        get active() {
            return active;
        },
        async connect() {
            if (active)
                return;
            const connected = await connector.connect(routerSocketPath);
            socket = connected;
            connected.on('data', receive);
            connected.on('close', clearSessionState);
            connected.on('error', clearSessionState);
            try {
                connected.write(`${JSON.stringify({
                    type: 'register',
                    protocol: ROUTER_PROTOCOL,
                    adapter: ADAPTER_NAME,
                    identity,
                })}\n`);
                active = true;
            }
            catch {
                connected.destroy();
                clearSessionState();
                throw new Error('Could not register the Claude channel session with the local router.');
            }
        },
        disconnect() {
            socket?.destroy();
            socket = undefined;
            clearSessionState();
        },
        async setBusy(nextBusy) {
            if (!active)
                return;
            busy = nextBusy;
            if (!busy)
                await flush();
        },
        acceptRouterFrame,
    };
}
export function sanitizeClaudeChannelMeta(meta, limits = {
    metaEntries: DEFAULT_MAX_META_ENTRIES,
    metaValueBytes: DEFAULT_MAX_META_VALUE_BYTES,
}) {
    return sanitizeMeta(meta, limits);
}
export function assertPrivateLocalRouterSocket(socketPath) {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
        throw new Error('The local router socket must be owner-private.');
    }
}
const privateLocalRouterConnector = {
    async connect(socketPath) {
        assertPrivateLocalRouterSocket(socketPath);
        return new Promise((resolve, reject) => {
            const socket = createConnection({ path: socketPath });
            const rejectOnce = (error) => {
                socket.destroy();
                reject(error);
            };
            socket.once('error', rejectOnce);
            socket.once('connect', () => {
                socket.removeListener('error', rejectOnce);
                resolve(socket);
            });
        });
    },
};
function isDelivery(frame, trustedRouterPrincipal, identity, limits) {
    if (!isRecord(frame) || frame.type !== 'deliver' || frame.sender !== trustedRouterPrincipal)
        return false;
    if (!isExactIdentity(frame.target, identity))
        return false;
    if (typeof frame.content !== 'string' || byteLength(frame.content) > limits.contentBytes)
        return false;
    if (frame.meta !== undefined && !isRecord(frame.meta))
        return false;
    return true;
}
function isExactIdentity(value, expected) {
    if (!isRecord(value))
        return false;
    return value.principal === expected.principal
        && value.sessionInstance === expected.sessionInstance
        && value.generation === expected.generation
        && value.workspace === expected.workspace;
}
function sanitizeMeta(meta, limits) {
    if (!meta)
        return {};
    const safe = {};
    for (const [key, value] of Object.entries(meta)) {
        if (Object.keys(safe).length >= limits.metaEntries)
            break;
        if (!META_KEY.test(key) || typeof value !== 'string' || byteLength(value) > limits.metaValueBytes)
            continue;
        safe[key] = value;
    }
    return safe;
}
function normalizeIdentity(identity) {
    return {
        principal: requireBoundedText(identity.principal, 'principal', MAX_IDENTITY_BYTES),
        sessionInstance: requireBoundedText(identity.sessionInstance, 'sessionInstance', MAX_IDENTITY_BYTES),
        generation: requireBoundedText(identity.generation, 'generation', MAX_IDENTITY_BYTES),
        workspace: requireBoundedText(identity.workspace, 'workspace', MAX_IDENTITY_BYTES),
    };
}
function normalizeLimits(options) {
    return {
        frameBytes: positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes'),
        contentBytes: positiveInteger(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES, 'maxContentBytes'),
        metaEntries: positiveInteger(options.maxMetaEntries, DEFAULT_MAX_META_ENTRIES, 'maxMetaEntries'),
        metaValueBytes: positiveInteger(options.maxMetaValueBytes, DEFAULT_MAX_META_VALUE_BYTES, 'maxMetaValueBytes'),
        queueItems: positiveInteger(options.maxQueueItems, DEFAULT_MAX_QUEUE_ITEMS, 'maxQueueItems'),
        queueBytes: positiveInteger(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 'maxQueueBytes'),
    };
}
function requireRouterSocketPath(value) {
    if (!isAbsolute(value) || value.includes('\0')) {
        throw new Error('routerSocketPath must be an absolute local socket path.');
    }
    return value;
}
function requireBoundedText(value, field, maxBytes) {
    if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
        throw new Error(`${field} must be a bounded non-empty string.`);
    }
    return value;
}
function positiveInteger(value, fallback, field) {
    const normalized = value ?? fallback;
    if (!Number.isSafeInteger(normalized) || normalized < 1) {
        throw new Error(`${field} must be a positive integer.`);
    }
    return normalized;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function byteLength(value) {
    return Buffer.byteLength(value, 'utf8');
}
//# sourceMappingURL=claude-channel.js.map