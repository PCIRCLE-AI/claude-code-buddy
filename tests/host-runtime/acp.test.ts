import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AcpProcessExitError,
  AcpRemoteError,
  AcpUnsupportedCapabilityError,
  type AcpClientOptions,
  type AcpDeliveryResult,
  type AcpRouterRegistration,
} from '../../src/host-adapters/acp-client.js';
import {
  ACP_SESSION_UPDATE_MAX_FILE_BYTES,
  ACP_SESSION_UPDATE_MAX_RECORD_BYTES,
  ACP_SESSION_UPDATE_MAX_RECORDS,
  createAcpSessionUpdateSink,
  resolveManagedAcpLaunch,
  startManagedAcpHost,
  type ConnectRouterHost,
} from '../../src/host-runtime/acp.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-acp-updates-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n');
}

function managedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const directory = privateDirectory();
  const tokenFile = path.join(directory, 'router.token');
  fs.writeFileSync(tokenFile, 'router-secret\n', { mode: 0o600 });
  return {
    router_socket: path.join(directory, 'router.sock'),
    token_file: tokenFile,
    project: 'managed-project',
    principal_id: 'gemini-managed',
    workspace: process.cwd(),
    model: 'gemini-current',
    work_summary: 'review ACP boundary',
    ...overrides,
  };
}

function managedConnector(
  events: string[],
  deliver: AcpRouterRegistration['deliver'],
  capture?: (options: AcpClientOptions) => void,
) {
  return async (options: AcpClientOptions) => {
    capture?.(options);
    events.push(`spawn:${options.command}:${options.args?.join(' ')}`);
    events.push('initialize');
    events.push(`session:${options.session?.kind ?? 'new'}`);
    const registration: AcpRouterRegistration = {
      host: 'acp',
      principal_id: options.principal_id,
      session_instance_id: options.session_instance_id,
      generation: options.generation,
      workspace: options.workspace,
      acp_session_id: options.session?.kind === 'load'
        ? options.session.acp_session_id
        : 'gemini-acp-session',
      deliver,
      cancel: () => { events.push('cancel'); },
    };
    const connection = await options.router.register(registration);
    const unregister = typeof connection === 'function'
      ? connection
      : connection?.unregister;
    return {
      acp_session_id: registration.acp_session_id,
      async close() {
        registration.cancel();
        await unregister?.();
        events.push('terminate');
      },
    };
  };
}

describe('ACP runtime session update output', () => {
  it('is disabled by default and creates no output', () => {
    const directory = privateDirectory();
    expect(createAcpSessionUpdateSink(undefined)).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes only opted-in ACP session updates to an owner-private JSONL file', () => {
    const directory = privateDirectory();
    const output = path.join(directory, 'session-updates.jsonl');
    const sink = createAcpSessionUpdateSink(output);
    expect(sink).toBeDefined();

    sink?.write({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'model feedback for dogfood' },
      },
    });
    sink?.close();

    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readLines(output)[0])).toEqual({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'model feedback for dogfood' },
      },
    });
  });

  it.skipIf(process.platform === 'win32')('rejects non-private paths and symlink output targets', () => {
    const directory = privateDirectory();
    const publicDirectory = path.join(directory, 'public');
    fs.mkdirSync(publicDirectory, { mode: 0o755 });
    expect(() => createAcpSessionUpdateSink(path.join(publicDirectory, 'updates.jsonl')))
      .toThrow(/parent.*owner-private/);

    const publicFile = path.join(directory, 'public.jsonl');
    fs.writeFileSync(publicFile, '', { mode: 0o644 });
    expect(() => createAcpSessionUpdateSink(publicFile)).toThrow(/file.*owner-private/);

    const realFile = path.join(directory, 'real.jsonl');
    const symlinkFile = path.join(directory, 'linked.jsonl');
    fs.writeFileSync(realFile, '', { mode: 0o600 });
    fs.symlinkSync(realFile, symlinkFile);
    expect(() => createAcpSessionUpdateSink(symlinkFile)).toThrow(/owner-private regular file/);
  });

  it.skipIf(process.platform === 'win32')('bounds individual records, total bytes, and record count', () => {
    const directory = privateDirectory();

    const recordFile = path.join(directory, 'record-bound.jsonl');
    const recordSink = createAcpSessionUpdateSink(recordFile);
    recordSink?.write({
      sessionId: 'record-bound',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x'.repeat(ACP_SESSION_UPDATE_MAX_RECORD_BYTES * 2) },
      },
    });
    recordSink?.close();
    const recordLines = readLines(recordFile);
    expect(Buffer.byteLength(recordLines[0], 'utf8') + 1).toBeLessThanOrEqual(ACP_SESSION_UPDATE_MAX_RECORD_BYTES);
    expect(JSON.parse(recordLines[0])).toMatchObject({
      sessionId: 'record-bound',
      update: { truncated: true },
    });

    const countFile = path.join(directory, 'count-bound.jsonl');
    const countSink = createAcpSessionUpdateSink(countFile);
    for (let index = 0; index < ACP_SESSION_UPDATE_MAX_RECORDS + 10; index += 1) {
      countSink?.write({
        sessionId: 'count-bound',
        update: { sessionUpdate: 'agent_message_chunk', index },
      });
    }
    countSink?.close();
    expect(readLines(countFile)).toHaveLength(ACP_SESSION_UPDATE_MAX_RECORDS);

    const byteFile = path.join(directory, 'byte-bound.jsonl');
    const byteSink = createAcpSessionUpdateSink(byteFile);
    for (let index = 0; index < ACP_SESSION_UPDATE_MAX_RECORDS; index += 1) {
      byteSink?.write({
        sessionId: 'byte-bound',
        update: {
          sessionUpdate: 'agent_message_chunk',
          index,
          content: { type: 'text', text: 'x'.repeat(ACP_SESSION_UPDATE_MAX_RECORD_BYTES * 2) },
        },
      });
    }
    byteSink?.close();
    expect(fs.statSync(byteFile).size).toBeLessThanOrEqual(ACP_SESSION_UPDATE_MAX_FILE_BYTES);
    expect(readLines(byteFile).length).toBeLessThan(ACP_SESSION_UPDATE_MAX_RECORDS);
  });
});

describe('managed Gemini ACP runtime', () => {
  it.skipIf(process.platform === 'win32')('generates one exact process identity, forces ACP mode, creates the session before registration, and closes in order', async () => {
    const events: string[] = [];
    let acpOptions: AcpClientOptions | undefined;
    let routerOptions: Parameters<ConnectRouterHost>[0] | undefined;
    let deliveredEnvelope: unknown;
    const connectRouterHost: ConnectRouterHost = async (options) => {
      routerOptions = options;
      events.push('router-register');
      return {
        generation: 4,
        close() { events.push('disconnect'); },
      };
    };
    const connectAcpHost = managedConnector(
      events,
      async ({ envelope }) => {
        events.push('prompt');
        deliveredEnvelope = envelope;
        return {
          host: 'acp',
          acp_session_id: 'gemini-acp-session',
          accepted: true,
          stop_reason: 'end_turn',
        };
      },
      (options) => { acpOptions = options; },
    );

    const runtime = await startManagedAcpHost(managedConfig({
      args: ['--model', 'gemini-current', '--acp'],
    }), {
      connect_router_host: connectRouterHost,
      connect_acp_host: connectAcpHost,
      create_session_instance_id: () => 'generated-managed-session',
    });

    expect(events).toEqual([
      'spawn:gemini:--acp --model gemini-current',
      'initialize',
      'session:new',
      'router-register',
    ]);
    expect(acpOptions).toMatchObject({
      principal_id: 'gemini-managed',
      session_instance_id: 'generated-managed-session',
      generation: 1,
      session: { kind: 'new' },
    });
    expect(routerOptions?.identity).toEqual({
      project: 'managed-project',
      principal_id: 'gemini-managed',
      session_instance_id: 'generated-managed-session',
      adapter_kind: 'acp',
      model: 'gemini-current',
      work_summary: 'review ACP boundary',
    });
    expect(runtime).toMatchObject({
      principal_id: 'gemini-managed',
      session_instance_id: 'generated-managed-session',
      acp_session_id: 'gemini-acp-session',
    });

    const envelope = {
      message_id: 'managed-message',
      sender: 'sender',
      recipient: 'gemini-managed',
      payload: { sequence: 2, nonce: 'bounded-nonce' },
      provenance: { source: 'router' },
    };
    await expect(routerOptions?.deliver({ envelope, generation: 4 })).resolves.toEqual({
      host: 'acp',
      acp_session_id: 'gemini-acp-session',
      accepted: true,
      stop_reason: 'end_turn',
    });
    expect(deliveredEnvelope).toEqual(envelope);

    await runtime.close();
    await runtime.close();
    expect(events.slice(-4)).toEqual(['prompt', 'cancel', 'disconnect', 'terminate']);
    expect(events.filter((event) => event === 'disconnect')).toHaveLength(1);
    expect(events.filter((event) => event === 'terminate')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('loads only through ACP and rejects ordinary Gemini UI lifecycle arguments before spawning', async () => {
    let acpOptions: AcpClientOptions | undefined;
    const events: string[] = [];
    const runtime = await startManagedAcpHost(managedConfig({
      session_instance_id: 'explicit-managed-process',
      acp_session_id: 'existing-acp-session',
    }), {
      connect_router_host: async () => {
        events.push('router-register');
        return { generation: 2, close() {} };
      },
      connect_acp_host: managedConnector(
        events,
        async () => ({
          host: 'acp',
          acp_session_id: 'existing-acp-session',
          accepted: true,
          stop_reason: 'end_turn',
        }),
        (options) => { acpOptions = options; },
      ),
    });
    expect(acpOptions?.session).toEqual({
      kind: 'load',
      acp_session_id: 'existing-acp-session',
    });
    expect(events.slice(0, 4)).toEqual([
      'spawn:gemini:--acp',
      'initialize',
      'session:load',
      'router-register',
    ]);
    await runtime.close();

  });

  it('rejects ordinary Gemini UI lifecycle arguments before spawning', () => {
    for (const args of [
      ['--resume', 'latest'],
      ['--session-id=session-from-ui'],
      ['--session-file', '/tmp/session.json'],
      ['--prompt', 'not-acp-input'],
      ['-iordinary-ui'],
      ['--experimental-acp'],
      ['--acp=false'],
      ['--no-acp'],
    ]) {
      expect(() => resolveManagedAcpLaunch({
        args,
        principal_id: 'gemini-managed',
        workspace: process.cwd(),
      }, () => 'generated-session')).toThrow(/not allowed.*managed ACP session/);
    }
  });

  it.skipIf(process.platform === 'win32')('does not register when authentication or capability setup fails', async () => {
    for (const startupError of [
      new AcpRemoteError('session/new', -32_000),
      new AcpUnsupportedCapabilityError('ACP loadSession is unavailable.'),
    ]) {
      let routerRegistrations = 0;
      await expect(startManagedAcpHost(managedConfig(), {
        connect_router_host: async () => {
          routerRegistrations += 1;
          return { generation: 1, close() {} };
        },
        connect_acp_host: async () => { throw startupError; },
        create_session_instance_id: () => 'failed-managed-session',
      })).rejects.toBe(startupError);
      expect(routerRegistrations).toBe(0);
    }
  });

  it.skipIf(process.platform === 'win32')('propagates process loss and rejects non-accepting receipts instead of resolving host acceptance', async () => {
    for (const deliver of [
      async () => { throw new AcpProcessExitError('Gemini ACP process exited.'); },
      async () => { throw new AcpRemoteError('session/prompt', -32_000); },
      async () => ({
        host: 'acp',
        acp_session_id: 'gemini-acp-session',
        accepted: false,
        stop_reason: 'end_turn',
      } as unknown as AcpDeliveryResult),
      async () => ({
        host: 'acp',
        acp_session_id: 'gemini-acp-session',
        accepted: true,
        stop_reason: 'unknown',
      } as unknown as AcpDeliveryResult),
    ]) {
      let routerOptions: Parameters<ConnectRouterHost>[0] | undefined;
      const runtime = await startManagedAcpHost(managedConfig(), {
        connect_router_host: async (options) => {
          routerOptions = options;
          return { generation: 1, close() {} };
        },
        connect_acp_host: managedConnector([], deliver),
        create_session_instance_id: () => 'delivery-failure-session',
      });
      await expect(routerOptions?.deliver({
        envelope: { message_id: 'must-not-accept' },
        generation: 1,
      })).rejects.toThrow();
      await runtime.close();
    }
  });
});

it.runIf(process.platform === 'win32')('fails closed before spawning ACP or registering with the router', async () => {
  const connectRouterHost = vi.fn();
  const connectAcpHost = vi.fn();
  const output = path.join(privateDirectory(), 'unsupported.jsonl');

  expect(() => createAcpSessionUpdateSink(output))
    .toThrow(/secure local host runtime is not supported on Windows/i);
  expect(fs.existsSync(output)).toBe(false);

  await expect(startManagedAcpHost({}, {
    connect_router_host: connectRouterHost as never,
    connect_acp_host: connectAcpHost as never,
  })).rejects.toThrow(/secure local host runtime is not supported on Windows/i);

  expect(connectAcpHost).not.toHaveBeenCalled();
  expect(connectRouterHost).not.toHaveBeenCalled();
});
