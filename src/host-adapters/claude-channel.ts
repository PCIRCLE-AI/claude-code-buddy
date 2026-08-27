import { lstatSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { Server, type ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

/** The only Claude Code experimental capability this one-way adapter needs. */
export const CLAUDE_CHANNEL_CAPABILITIES = {
  experimental: { 'claude/channel': {} },
} as const;

export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel' as const;

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

export interface ClaudeChannelIdentity {
  /** Stable identity used by the local router. */
  principal: string;
  /** Unique to this Claude Code subprocess. */
  sessionInstance: string;
  /** Changes whenever a session instance is replaced. */
  generation: string;
  /** Exact workspace routing boundary. */
  workspace: string;
}

export interface ClaudeChannelNotification {
  method: typeof CLAUDE_CHANNEL_NOTIFICATION_METHOD;
  params: {
    content: string;
    meta: Record<string, string>;
  };
}

/**
 * Deliberately narrower than an MCP Server: later integration can pass the
 * spawned server's notification method without giving this adapter tools,
 * permissions, or process-level access.
 */
export interface ClaudeChannelNotifier {
  notification(notification: ClaudeChannelNotification): Promise<void>;
}

export interface ClaudeChannelRouterSocket {
  write(data: string): boolean;
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  destroy(): void;
}

export interface ClaudeChannelRouterConnector {
  connect(socketPath: string): Promise<ClaudeChannelRouterSocket>;
}

export interface ClaudeChannelDelivery {
  type: 'deliver';
  /** Must be the trusted local router principal, not a message-author claim. */
  sender: string;
  target: ClaudeChannelIdentity;
  content: string;
  meta?: Record<string, unknown>;
}

export interface ClaudeChannelAdapterOptions {
  routerSocketPath: string;
  /** The local router's authenticated, stable principal. */
  trustedRouterPrincipal: string;
  identity: ClaudeChannelIdentity;
  notifier: ClaudeChannelNotifier;
  connector?: ClaudeChannelRouterConnector;
  maxFrameBytes?: number;
  maxContentBytes?: number;
  maxMetaEntries?: number;
  maxMetaValueBytes?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
}

export interface ClaudeChannelAdapter {
  /** Connects and registers this exact spawned session with the private router. */
  connect(): Promise<void>;
  /** Marks the spawned session stale and discards queued, undelivered content. */
  disconnect(): void;
  /** Host lifecycle integration calls this while Claude is processing a turn. */
  setBusy(busy: boolean): Promise<void>;
  /** Narrow ingress point for a later router integration and focused tests. */
  acceptRouterFrame(frame: unknown): Promise<boolean>;
  readonly active: boolean;
}

interface QueueEntry {
  notification: ClaudeChannelNotification;
  bytes: number;
}

interface Limits {
  frameBytes: number;
  contentBytes: number;
  metaEntries: number;
  metaValueBytes: number;
  queueItems: number;
  queueBytes: number;
}

/**
 * Builds a standards-compliant, one-way Claude channel server. There is no
 * tools capability and no claude/channel/permission capability by design.
 */
export function createClaudeChannelServer(
  serverInfo: Implementation,
  instructions: string,
): Server {
  const options: ServerOptions = {
    capabilities: CLAUDE_CHANNEL_CAPABILITIES,
    instructions,
  };
  return new Server(serverInfo, options);
}

/** A small adapter surface intended for a future spawned-MCP entrypoint. */
export function createClaudeChannelAdapter(options: ClaudeChannelAdapterOptions): ClaudeChannelAdapter {
  const identity = normalizeIdentity(options.identity);
  const trustedRouterPrincipal = requireBoundedText(
    options.trustedRouterPrincipal,
    'trustedRouterPrincipal',
    MAX_IDENTITY_BYTES,
  );
  const routerSocketPath = requireRouterSocketPath(options.routerSocketPath);
  const limits = normalizeLimits(options);
  const connector = options.connector ?? privateLocalRouterConnector;

  let active = false;
  let busy = false;
  let socket: ClaudeChannelRouterSocket | undefined;
  let receiveBuffer = Buffer.alloc(0);
  let queue: QueueEntry[] = [];
  let queuedBytes = 0;

  function clearSessionState(): void {
    active = false;
    busy = false;
    receiveBuffer = Buffer.alloc(0);
    queue = [];
    queuedBytes = 0;
  }

  async function emit(notification: ClaudeChannelNotification): Promise<boolean> {
    try {
      await options.notifier.notification(notification);
      return true;
    } catch {
      // A failed notification must never be retried into a replacement session.
      clearSessionState();
      return false;
    }
  }

  async function flush(): Promise<void> {
    while (active && !busy && queue.length > 0) {
      const entry = queue.shift()!;
      queuedBytes -= entry.bytes;
      if (!await emit(entry.notification)) return;
    }
  }

  async function acceptRouterFrame(frame: unknown): Promise<boolean> {
    if (!active || !isDelivery(frame, trustedRouterPrincipal, identity, limits)) return false;

    const notification = {
      method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
      params: {
        content: frame.content,
        meta: sanitizeMeta(frame.meta, limits),
      },
    } satisfies ClaudeChannelNotification;
    const bytes = byteLength(notification.params.content) + byteLength(JSON.stringify(notification.params.meta));

    if (busy) {
      if (queue.length >= limits.queueItems || queuedBytes + bytes > limits.queueBytes) return false;
      queue.push({ notification, bytes });
      queuedBytes += bytes;
      return true;
    }

    return emit(notification);
  }

  function receive(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length > limits.frameBytes || receiveBuffer.length + bytes.length > limits.frameBytes) {
      socket?.destroy();
      clearSessionState();
      return;
    }

    receiveBuffer = Buffer.concat([receiveBuffer, bytes]);
    for (;;) {
      const newline = receiveBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const raw = receiveBuffer.subarray(0, newline);
      receiveBuffer = receiveBuffer.subarray(newline + 1);
      if (raw.length === 0 || raw.length > limits.frameBytes) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      void acceptRouterFrame(frame);
    }
  }

  return {
    get active() {
      return active;
    },
    async connect(): Promise<void> {
      if (active) return;
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
      } catch {
        connected.destroy();
        clearSessionState();
        throw new Error('Could not register the Claude channel session with the local router.');
      }
    },
    disconnect(): void {
      socket?.destroy();
      socket = undefined;
      clearSessionState();
    },
    async setBusy(nextBusy: boolean): Promise<void> {
      if (!active) return;
      busy = nextBusy;
      if (!busy) await flush();
    },
    acceptRouterFrame,
  };
}

export function sanitizeClaudeChannelMeta(
  meta: Record<string, unknown> | undefined,
  limits: Pick<Limits, 'metaEntries' | 'metaValueBytes'> = {
    metaEntries: DEFAULT_MAX_META_ENTRIES,
    metaValueBytes: DEFAULT_MAX_META_VALUE_BYTES,
  },
): Record<string, string> {
  return sanitizeMeta(meta, limits);
}

/** Reject non-Unix or group/world-readable endpoints before connecting. */
export function assertPrivateLocalRouterSocket(socketPath: string): void {
  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
    throw new Error('The local router socket must be owner-private.');
  }
}

const privateLocalRouterConnector: ClaudeChannelRouterConnector = {
  async connect(socketPath): Promise<ClaudeChannelRouterSocket> {
    assertPrivateLocalRouterSocket(socketPath);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: socketPath });
      const rejectOnce = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', rejectOnce);
      socket.once('connect', () => {
        socket.removeListener('error', rejectOnce);
        resolve(socket as Socket as ClaudeChannelRouterSocket);
      });
    });
  },
};

function isDelivery(
  frame: unknown,
  trustedRouterPrincipal: string,
  identity: ClaudeChannelIdentity,
  limits: Limits,
): frame is ClaudeChannelDelivery {
  if (!isRecord(frame) || frame.type !== 'deliver' || frame.sender !== trustedRouterPrincipal) return false;
  if (!isExactIdentity(frame.target, identity)) return false;
  if (typeof frame.content !== 'string' || byteLength(frame.content) > limits.contentBytes) return false;
  if (frame.meta !== undefined && !isRecord(frame.meta)) return false;
  return true;
}

function isExactIdentity(value: unknown, expected: ClaudeChannelIdentity): boolean {
  if (!isRecord(value)) return false;
  return value.principal === expected.principal
    && value.sessionInstance === expected.sessionInstance
    && value.generation === expected.generation
    && value.workspace === expected.workspace;
}

function sanitizeMeta(meta: Record<string, unknown> | undefined, limits: Pick<Limits, 'metaEntries' | 'metaValueBytes'>): Record<string, string> {
  if (!meta) return {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (Object.keys(safe).length >= limits.metaEntries) break;
    if (!META_KEY.test(key) || typeof value !== 'string' || byteLength(value) > limits.metaValueBytes) continue;
    safe[key] = value;
  }
  return safe;
}

function normalizeIdentity(identity: ClaudeChannelIdentity): ClaudeChannelIdentity {
  return {
    principal: requireBoundedText(identity.principal, 'principal', MAX_IDENTITY_BYTES),
    sessionInstance: requireBoundedText(identity.sessionInstance, 'sessionInstance', MAX_IDENTITY_BYTES),
    generation: requireBoundedText(identity.generation, 'generation', MAX_IDENTITY_BYTES),
    workspace: requireBoundedText(identity.workspace, 'workspace', MAX_IDENTITY_BYTES),
  };
}

function normalizeLimits(options: ClaudeChannelAdapterOptions): Limits {
  return {
    frameBytes: positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes'),
    contentBytes: positiveInteger(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES, 'maxContentBytes'),
    metaEntries: positiveInteger(options.maxMetaEntries, DEFAULT_MAX_META_ENTRIES, 'maxMetaEntries'),
    metaValueBytes: positiveInteger(options.maxMetaValueBytes, DEFAULT_MAX_META_VALUE_BYTES, 'maxMetaValueBytes'),
    queueItems: positiveInteger(options.maxQueueItems, DEFAULT_MAX_QUEUE_ITEMS, 'maxQueueItems'),
    queueBytes: positiveInteger(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 'maxQueueBytes'),
  };
}

function requireRouterSocketPath(value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error('routerSocketPath must be an absolute local socket path.');
  }
  return value;
}

function requireBoundedText(value: string, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
    throw new Error(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
