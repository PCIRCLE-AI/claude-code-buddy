import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodexSessionCompanion } from '../../src/host-runtime/codex-session.js';

const tempDirs: string[] = [];
const threadId = '01a041b4-5c67-75b3-9505-4e33d7942b8e';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-session-'));
  tempDirs.push(dir);
  const tokenFile = path.join(dir, 'router.token');
  fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
  return {
    config: {
      router_socket: path.join(dir, 'router.sock'),
      token_file: tokenFile,
      project: 'project-a',
      principal_id: 'principal-a',
      workspace: dir,
    },
    hook: { hook_event_name: 'SessionStart', session_id: threadId, cwd: dir, source: 'startup' },
  };
}

describe('ordinary Codex session companion', () => {
  it.skipIf(process.platform === 'win32')('registers the hook session without CODEX_THREAD_ID and keeps payload delivery out of the companion', async () => {
    const { config, hook } = fixture();
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async (input) => {
      await expect(input.deliver({} as never)).rejects.toThrow('metadata-only');
      return { connection_id: 'connection-a', generation: 1, close };
    });

    await expect(startCodexSessionCompanion(
      config, hook, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).resolves.toMatchObject({ connection_id: 'connection-a', generation: 1 });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      socket_path: config.router_socket,
      auth_token: 'test-token',
      identity: {
        project: 'project-a', principal_id: 'principal-a',
        session_instance_id: threadId, adapter_kind: 'codex-cli-queue',
      },
    }));
  });

  it.each([
    ['no hook identity', { session_id: undefined }, { PLUGIN_ROOT: '/plugin' }],
    ['invalid hook identity', { session_id: 'not-a-uuid' }, { PLUGIN_ROOT: '/plugin' }],
    ['compact lifecycle', { source: 'compact' }, { PLUGIN_ROOT: '/plugin' }],
    ['missing Codex plugin marker', {}, {}],
    ['empty Codex plugin marker', {}, { PLUGIN_ROOT: '' }],
  ])('fails closed without a registration for %s', async (_label, hookOverride, environment) => {
    const { config, hook } = fixture();
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      config, { ...hook, ...hookOverride }, environment, { connect: connect as never },
    )).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('requires an exact configured workspace realpath', async () => {
    const { config, hook } = fixture();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codex-other-'));
    tempDirs.push(other);
    const connect = vi.fn();
    await expect(startCodexSessionCompanion(
      config, { ...hook, cwd: other }, { PLUGIN_ROOT: '/plugin' }, { connect: connect as never },
    )).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('fails closed before connecting to the router', async () => {
    const { config, hook } = fixture();
    const connect = vi.fn();

    await expect(startCodexSessionCompanion(
      config, hook, { PLUGIN_ROOT: '/plugin' }, { connect },
    )).rejects.toThrow(/secure local host runtime is not supported on Windows/i);

    expect(connect).not.toHaveBeenCalled();
    expect(fs.existsSync(config.router_socket as string)).toBe(false);
  });
});
