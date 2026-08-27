import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AgentJsonObject, AgentMessagePayload } from '../core/agent-messaging.js';
import { AGENT_ROUTER_MAX_FRAME_BYTES } from '../core/agent-router.js';

const DEFAULT_INITIAL_RETRY_MS = 100;
const DEFAULT_MAX_RETRY_MS = 5_000;
const DEFAULT_RETRY_JITTER = 0.2;
const DEFAULT_INITIAL_ATTEMPTS = 6;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 5_000;
const MIN_RETRY_MS = 10;

export interface RouterHostIdentity {
  project: string;
  principal_id: string;
  session_instance_id: string;
  adapter_kind: string;
}

export interface RouterDelivery {
  attempt_id: string;
  delivery_id: string;
  connection_id: string;
  generation: number;
  hops: number;
  envelope: AgentMessagePayload;
}

export interface RouterHostConnection {
  readonly connection_id: string;
  readonly generation: number;
  close(): Promise<void>;
}

export interface RouterClientResilienceOptions {
  initial_retry_ms?: number;
  max_retry_ms?: number;
  retry_jitter?: number;
  initial_attempts?: number;
  registration_timeout_ms?: number;
  /** Test seam; production starts the packaged router entrypoint without a shell. */
  start_router?: () => void | Promise<void>;
  /** Test seam for deterministic jitter. Must return a value between zero and one. */
  random?: () => number;
}

export interface ConnectRouterHostInput {
  socket_path: string;
  auth_token: string;
  identity: RouterHostIdentity;
  deliver(delivery: RouterDelivery): Promise<AgentJsonObject>;
  resilience?: RouterClientResilienceOptions;
}

type NormalizedResilienceOptions = {
  initial_retry_ms: number;
  max_retry_ms: number;
  retry_jitter: number;
  initial_attempts: number;
  registration_timeout_ms: number;
  start_router: () => Promise<void>;
  random: () => number;
};

class RouterTransportError extends Error {}

class ActiveRouterHostConnection implements RouterHostConnection {
  private currentConnectionId = '';
  private currentGeneration = 0;
  private currentSocket: net.Socket | null = null;
  private connectingSocket: net.Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private cancelRetryWait: (() => void) | null = null;
  private reconnectTask: Promise<void> | null = null;
  private closed = false;
  private deliveryTail = Promise.resolve();
  private readonly acceptedDeliveries = new Map<string, AgentJsonObject>();

  constructor(
    private readonly input: ConnectRouterHostInput,
    private readonly resilience: NormalizedResilienceOptions,
  ) {}

  get connection_id(): string {
    return this.currentConnectionId;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async connectInitial(): Promise<void> {
    let lastError: unknown = new RouterTransportError('Could not connect to the router.');
    for (let attempt = 0; attempt < this.resilience.initial_attempts; attempt += 1) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
        if (this.closed || !isRetryableTransportError(error)) throw error;
        if (attempt + 1 < this.resilience.initial_attempts) {
          await this.waitForRetry(this.retryDelay(attempt));
        }
      }
    }
    throw lastError;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    this.cancelPendingRetry();

    const connecting = this.connectingSocket;
    this.connectingSocket = null;
    connecting?.destroy();

    const socket = this.currentSocket;
    this.currentSocket = null;
    if (!socket) return;
    try {
      this.write(socket, {
        version: 1,
        type: 'disconnect',
        request_id: randomUUID(),
        project: this.input.identity.project,
        session_instance_id: this.input.identity.session_instance_id,
        connection_id: this.currentConnectionId,
        generation: this.currentGeneration,
        hops: 0,
      });
    } finally {
      socket.destroy();
    }
  }

  private async connectOnce(): Promise<void> {
    try {
      assertPrivateRouterSocket(this.input.socket_path);
      const socket = net.createConnection(this.input.socket_path);
      this.connectingSocket = socket;
      try {
        await waitForSocketConnect(socket);
        if (this.closed) throw new RouterTransportError('Router host connection was closed.');
        await this.registerSocket(socket);
      } catch (error) {
        socket.destroy();
        throw error;
      } finally {
        if (this.connectingSocket === socket) this.connectingSocket = null;
      }
    } catch (error) {
      if (!this.closed && isRouterUnavailable(error)) {
        try {
          await this.resilience.start_router();
        } catch {
          // Another concurrent client may have won the bind race. The next
          // delayed connection attempt is authoritative, not the spawn result.
        }
      }
      throw error;
    }
  }

  private registerSocket(socket: net.Socket): Promise<void> {
    const registerId = randomUUID();
    let buffer = Buffer.alloc(0);
    let connectionId = '';
    let generation = 0;
    let registrationSettled = false;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new RouterTransportError('Router registration timed out.'));
      }, this.resilience.registration_timeout_ms);
      timer.unref();

      const finish = (error?: Error) => {
        if (registrationSettled) return;
        registrationSettled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > AGENT_ROUTER_MAX_FRAME_BYTES && !buffer.includes(0x0a)) {
          socket.destroy(new Error('Router frame exceeds the byte limit.'));
          return;
        }
        for (;;) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const raw = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (raw.length === 0 || raw.length > AGENT_ROUTER_MAX_FRAME_BYTES) continue;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { continue; }
          if (!registrationSettled && frame.request_id === registerId) {
            if (frame.ok !== true || !isRecord(frame.result)) {
              finish(new Error('Router registration was rejected.'));
              continue;
            }
            try {
              connectionId = requiredFrameString(frame.result.connection_id);
              generation = requiredFrameInteger(frame.result.generation);
              const leaseMs = requiredFrameInteger(frame.result.lease_ms);
              this.activate(socket, connectionId, generation, leaseMs);
              finish();
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
            continue;
          }
          if (frame.type === 'session_superseded'
            && frame.connection_id === connectionId
            && frame.generation === generation) {
            this.closed = true;
            this.clearHeartbeat();
            if (this.currentSocket === socket) this.currentSocket = null;
            socket.destroy();
            continue;
          }
          if (frame.type !== 'deliver') continue;
          this.deliveryTail = this.deliveryTail.then(
            () => this.handleDelivery(socket, frame, connectionId, generation),
          ).catch(() => undefined);
        }
      });
      socket.on('error', (error) => {
        if (!registrationSettled) finish(error);
      });
      socket.once('close', () => {
        if (!registrationSettled) {
          finish(new RouterTransportError('Router disconnected during registration.'));
          return;
        }
        this.handleDisconnect(socket);
      });

      this.write(socket, {
        version: 1,
        type: 'register',
        request_id: registerId,
        ...this.input.identity,
        auth_token: this.input.auth_token,
        hops: 0,
      });
    });
  }

  private activate(socket: net.Socket, connectionId: string, generation: number, leaseMs: number): void {
    this.currentSocket = socket;
    this.currentConnectionId = connectionId;
    this.currentGeneration = generation;
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.closed || this.currentSocket !== socket) return;
      this.write(socket, {
        version: 1,
        type: 'heartbeat',
        request_id: randomUUID(),
        project: this.input.identity.project,
        session_instance_id: this.input.identity.session_instance_id,
        connection_id: connectionId,
        generation,
        hops: 0,
      });
    }, Math.max(100, Math.floor(leaseMs / 2)));
    this.heartbeat.unref();
  }

  private async handleDelivery(
    socket: net.Socket,
    frame: Record<string, unknown>,
    connectionId: string,
    generation: number,
  ): Promise<void> {
    if (this.closed || !isDelivery(frame, connectionId, generation)) return;
    const common = {
      version: 1,
      request_id: randomUUID(),
      attempt_id: frame.attempt_id,
      delivery_id: frame.delivery_id,
      connection_id: connectionId,
      generation,
      hops: frame.hops,
    } as const;
    try {
      const duplicateReceipt = this.acceptedDeliveries.get(frame.delivery_id);
      const receipt = duplicateReceipt ?? await this.input.deliver(frame);
      if (!duplicateReceipt) {
        this.acceptedDeliveries.set(frame.delivery_id, receipt);
        if (this.acceptedDeliveries.size > 1024) {
          const oldest = this.acceptedDeliveries.keys().next().value;
          if (typeof oldest === 'string') this.acceptedDeliveries.delete(oldest);
        }
      }
      this.write(socket, { ...common, type: 'host_accept', receipt });
    } catch (error) {
      this.write(socket, { ...common, type: 'host_reject', failure_code: failureCode(error) });
    }
  }

  private handleDisconnect(socket: net.Socket): void {
    if (this.currentSocket !== socket) return;
    this.currentSocket = null;
    this.clearHeartbeat();
    if (!this.closed) this.beginReconnect();
  }

  private beginReconnect(): void {
    if (this.closed || this.reconnectTask) return;
    const task = this.reconnectLoop();
    this.reconnectTask = task;
    void task.finally(() => {
      if (this.reconnectTask === task) this.reconnectTask = null;
      if (!this.closed && !this.currentSocket) this.beginReconnect();
    });
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      if (!await this.waitForRetry(this.retryDelay(attempt))) return;
      attempt += 1;
      try {
        await this.connectOnce();
        if (this.currentSocket) return;
      } catch {
        // Active hosts remain eligible for recovery. Every retry is delayed
        // and capped, including non-startup transport and protocol failures.
      }
    }
  }

  private retryDelay(attempt: number): number {
    const exponent = Math.min(attempt, 30);
    const base = Math.min(
      this.resilience.max_retry_ms,
      this.resilience.initial_retry_ms * (2 ** exponent),
    );
    const random = Math.min(1, Math.max(0, this.resilience.random()));
    return Math.max(MIN_RETRY_MS, Math.floor(base * (1 - this.resilience.retry_jitter * random)));
  }

  private waitForRetry(delayMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (continueRetrying: boolean) => {
        if (this.retryTimer === timer) this.retryTimer = null;
        if (this.cancelRetryWait === cancel) this.cancelRetryWait = null;
        resolve(continueRetrying);
      };
      const timer = setTimeout(() => finish(!this.closed), delayMs);
      const cancel = () => {
        clearTimeout(timer);
        finish(false);
      };
      this.retryTimer = timer;
      this.cancelRetryWait = cancel;
    });
  }

  private cancelPendingRetry(): void {
    this.cancelRetryWait?.();
    this.cancelRetryWait = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private write(socket: net.Socket, frame: AgentJsonObject): void {
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
    if (encoded.length > AGENT_ROUTER_MAX_FRAME_BYTES) throw new Error('Router frame exceeds the byte limit.');
    if (!socket.destroyed) socket.write(encoded);
  }
}

export async function connectRouterHost(input: ConnectRouterHostInput): Promise<RouterHostConnection> {
  const connection = new ActiveRouterHostConnection(input, normalizeResilience(input.resilience));
  await connection.connectInitial();
  return connection;
}

function waitForSocketConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new RouterTransportError('Router disconnected before connection.'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function assertPrivateRouterSocket(socketPath: string): void {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
    throw new Error('The router socket must be owner-private.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('The router socket must be owned by the current user.');
  }
}

function normalizeResilience(options: RouterClientResilienceOptions = {}): NormalizedResilienceOptions {
  const initialRetryMs = boundedInteger(
    options.initial_retry_ms ?? DEFAULT_INITIAL_RETRY_MS,
    MIN_RETRY_MS,
    60_000,
    'initial_retry_ms',
  );
  return {
    initial_retry_ms: initialRetryMs,
    max_retry_ms: boundedInteger(
      options.max_retry_ms ?? DEFAULT_MAX_RETRY_MS,
      initialRetryMs,
      60_000,
      'max_retry_ms',
    ),
    retry_jitter: boundedNumber(options.retry_jitter ?? DEFAULT_RETRY_JITTER, 0, 1, 'retry_jitter'),
    initial_attempts: boundedInteger(options.initial_attempts ?? DEFAULT_INITIAL_ATTEMPTS, 1, 100, 'initial_attempts'),
    registration_timeout_ms: boundedInteger(
      options.registration_timeout_ms ?? DEFAULT_REGISTRATION_TIMEOUT_MS,
      100,
      60_000,
      'registration_timeout_ms',
    ),
    start_router: async () => {
      if (options.start_router) await options.start_router();
      else await startPackagedRouter();
    },
    random: options.random ?? Math.random,
  };
}

function startPackagedRouter(): Promise<void> {
  const entrypoint = fileURLToPath(new URL('./router.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

function isDelivery(
  value: Record<string, unknown>,
  connectionId: string,
  generation: number,
): value is Record<string, unknown> & RouterDelivery {
  return value.type === 'deliver'
    && value.connection_id === connectionId
    && value.generation === generation
    && typeof value.attempt_id === 'string'
    && typeof value.delivery_id === 'string'
    && Number.isInteger(value.hops)
    && isRecord(value.envelope);
}

function isRouterUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof RouterTransportError || isRouterUnavailable(error)) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boundedNumber(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function requiredFrameString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid router string field.');
  return value;
}

function requiredFrameInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid router integer field.');
  return value as number;
}

function failureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'host_rejected';
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120) || 'host_rejected';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
