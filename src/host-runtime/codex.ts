#!/usr/bin/env node

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerDisconnectedError,
  CodexAppServerTimeoutError,
  createCodexAppServerAdapter,
  startCodexAppServerThread,
  type CodexAppServerAdapterOptions,
  type CodexAppServerThread,
  type StartCodexAppServerThreadInput,
} from '../host-adapters/codex-app-server.js';
import {
  assertSecureLocalHostRuntimeSupported,
  readHostConfig,
  readTokenFile,
  requiredString,
} from './config.js';
import { connectRouterHost, type RouterHostConnection } from './router-client.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_RETRY_MS = 50;

type SpawnManagedCodex = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type StartManagedThread = (
  input: StartCodexAppServerThreadInput,
  options?: CodexAppServerAdapterOptions,
) => Promise<CodexAppServerThread>;

export interface ManagedCodexHostConfig extends Record<string, unknown> {
  router_socket: unknown;
  token_file: unknown;
  project: unknown;
  principal_id: unknown;
  /** A caller may supply the launcher-created session id; otherwise a new one is created once. */
  session_instance_id?: unknown;
  control_socket: unknown;
  workspace: unknown;
  codex_command?: unknown;
  startup_timeout_ms?: unknown;
}

export interface ManagedCodexHost {
  readonly thread_id: string;
  readonly session_instance_id: string;
  readonly process: ChildProcess;
  close(): Promise<void>;
}

export interface ManagedCodexHostDependencies {
  spawn?: SpawnManagedCodex;
  start_thread?: StartManagedThread;
  create_adapter?: typeof createCodexAppServerAdapter;
  connect_router_host?: typeof connectRouterHost;
  wait?: (milliseconds: number) => Promise<void>;
}

interface NormalizedConfig {
  routerSocket: string;
  tokenFile: unknown;
  project: string;
  principalId: string;
  sessionInstanceId: string;
  controlSocket: string;
  workspace: string;
  codexCommand: string;
  startupTimeoutMs: number;
}

/**
 * Start an owned `codex app-server`, create its active thread, then and only
 * then register that exact session with the router. It intentionally has no
 * path for attaching to an arbitrary externally-created Codex session.
 */
export async function startManagedCodexHost(
  config: ManagedCodexHostConfig,
  dependencies: ManagedCodexHostDependencies = {},
): Promise<ManagedCodexHost> {
  assertSecureLocalHostRuntimeSupported();
  const normalized = normalizeConfig(config);
  assertUnusedPrivateSocketPath(normalized.controlSocket);

  const spawnManagedCodex = dependencies.spawn ?? spawn;
  const startThread = dependencies.start_thread ?? startCodexAppServerThread;
  const createAdapter = dependencies.create_adapter ?? createCodexAppServerAdapter;
  const connectHost = dependencies.connect_router_host ?? connectRouterHost;
  const wait = dependencies.wait ?? delay;
  const child = spawnManagedCodex(normalized.codexCommand, [
    'app-server',
    '--listen',
    `unix://${normalized.controlSocket}`,
  ], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  let routerConnection: RouterHostConnection | undefined;
  let closeTask: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeTask ??= (async () => {
      await routerConnection?.close();
      if (isChildRunning(child)) child.kill('SIGTERM');
    })();
    return closeTask;
  };
  const onChildEnded = () => { void close(); };
  child.once('exit', onChildEnded);
  child.once('error', onChildEnded);

  try {
    const thread = await waitForManagedThread({
      child,
      controlSocket: normalized.controlSocket,
      workspace: normalized.workspace,
      timeoutMs: normalized.startupTimeoutMs,
      startThread,
      wait,
    });
    assertPrivateControlSocket(normalized.controlSocket);

    const adapter = createAdapter();
    routerConnection = await connectHost({
      socket_path: normalized.routerSocket,
      auth_token: readTokenFile(normalized.tokenFile),
      identity: {
        project: normalized.project,
        principal_id: normalized.principalId,
        session_instance_id: normalized.sessionInstanceId,
        adapter_kind: 'codex-app-server',
      },
      async deliver(delivery) {
        const receipt = await adapter.queue({
          control_socket_path: normalized.controlSocket,
          thread_id: thread.thread_id,
          routing: {
            project: delivery.envelope.project,
            sender: delivery.envelope.sender,
            recipient: delivery.envelope.recipient,
            message_id: delivery.envelope.message_id,
            delivery_id: delivery.delivery_id,
            correlation_id: delivery.envelope.correlation_id,
          },
          envelope: delivery.envelope,
        });
        return {
          host: receipt.host,
          status: receipt.status,
          thread_id: receipt.thread_id,
          client_user_message_id: receipt.client_user_message_id,
          queued_submission_id: receipt.queued_submission_id,
        };
      },
    });
    return {
      thread_id: thread.thread_id,
      session_instance_id: normalized.sessionInstanceId,
      process: child,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function waitForManagedThread(input: {
  child: ChildProcess;
  controlSocket: string;
  workspace: string;
  timeoutMs: number;
  startThread: StartManagedThread;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<CodexAppServerThread> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: Error | undefined;
  for (;;) {
    if (!isChildRunning(input.child)) {
      throw new Error('Managed Codex app-server exited before creating a thread.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new Error('Managed Codex app-server did not become ready before the startup timeout.');
    }
    try {
      return await input.startThread({
        control_socket_path: input.controlSocket,
        workspace: input.workspace,
        timeout_ms: Math.min(remaining, 1_000),
      });
    } catch (error) {
      if (!isReadinessTransportError(error)) throw error;
      lastError = error;
      await input.wait(Math.min(STARTUP_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

function isReadinessTransportError(error: unknown): error is Error {
  return error instanceof CodexAppServerDisconnectedError || error instanceof CodexAppServerTimeoutError;
}

function normalizeConfig(config: ManagedCodexHostConfig): NormalizedConfig {
  const controlSocket = requiredAbsolutePath(config.control_socket, 'control_socket');
  const workspace = fs.realpathSync(requiredAbsolutePath(config.workspace, 'workspace'));
  if (!fs.statSync(workspace).isDirectory()) throw new Error('workspace must be an existing directory.');
  return {
    routerSocket: requiredString(config.router_socket, 'router_socket'),
    tokenFile: config.token_file,
    project: requiredString(config.project, 'project'),
    principalId: requiredString(config.principal_id, 'principal_id'),
    sessionInstanceId: config.session_instance_id === undefined
      ? randomUUID()
      : requiredString(config.session_instance_id, 'session_instance_id'),
    controlSocket,
    workspace,
    codexCommand: requiredString(config.codex_command ?? 'codex', 'codex_command'),
    startupTimeoutMs: boundedStartupTimeout(config.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS),
  };
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const resolved = requiredString(value, field);
  if (!path.isAbsolute(resolved)) throw new Error(`${field} must be an absolute path.`);
  return resolved;
}

function boundedStartupTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error('startup_timeout_ms must be an integer between 100 and 60000.');
  }
  return value;
}

function assertUnusedPrivateSocketPath(socketPath: string): void {
  const parent = fs.lstatSync(path.dirname(socketPath));
  assertOwnerPrivate(parent, 'control socket parent directory');
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error('The control socket parent must be a real owner-private directory.');
  }
  if (fs.lstatSync(socketPath, { throwIfNoEntry: false })) {
    throw new Error('The managed control socket path must not already exist.');
  }
}

function assertPrivateControlSocket(socketPath: string): void {
  const socket = fs.lstatSync(socketPath);
  if (!socket.isSocket()) throw new Error('The managed control socket must be a Unix socket.');
  assertOwnerPrivate(socket, 'managed control socket');
}

function assertOwnerPrivate(stat: fs.Stats, label: string): void {
  if ((stat.mode & 0o077) !== 0) throw new Error(`The ${label} must be owner-private.`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`The ${label} must be owned by the current user.`);
  }
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runManagedCodexHost(): Promise<void> {
  const host = await startManagedCodexHost(readHostConfig<ManagedCodexHostConfig>());
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  host.process.once('exit', () => {
    if (!shuttingDown) process.exitCode = 1;
  });
}

const entryPath = process.argv[1];
if (entryPath && isExecutedModule(entryPath, import.meta.url)) {
  await runManagedCodexHost();
}

function isExecutedModule(entryPath: string, moduleUrl: string): boolean {
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
