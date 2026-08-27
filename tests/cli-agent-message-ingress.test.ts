import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliLoader = `
  import { createServer } from 'vite';
  const server = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { runCli } = await server.ssrLoadModule('/src/transports/cli/cli.ts');
    await runCli([process.argv[0], 'memesh', ...process.argv.slice(1)]);
  } finally {
    await server.close();
  }
`;

function cliArgs(...args: string[]): string[] {
  return ['--input-type=module', '--eval', cliLoader, ...args];
}

describe('CLI durable-message ingress', () => {
  it('accepts JSON from stdin through the current source CLI', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    const payload = JSON.stringify({ kind: 'stdin-happy-path', value: 7 });
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'stdin-happy-json', '--payload-stdin',
        '--content-type', 'application/json',
      ), {
        encoding: 'utf8',
        input: payload,
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({
        project: 'test', sender: 'sender', recipient: 'recipient', target_kind: 'principal',
        content_type: 'application/json',
      });
      expect(typeof response.message_id).toBe('string');
      expect(result.stdout).not.toContain(payload);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('sends to one exact session through --target-kind', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'session-instance-9', '--target-kind', 'session',
        '--idempotency-key', 'stdin-exact-session', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'exact session only',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        project: 'test',
        recipient: 'session-instance-9',
        target_kind: 'session',
      });
      const messageId = (JSON.parse(result.stdout) as { message_id: string }).message_id;

      const fetched = spawnSync(process.execPath, cliArgs(
        'message', 'fetch', '--project', 'test', '--recipient', 'session-instance-9',
        '--target-kind', 'session', '--message-id', messageId,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(fetched.status, fetched.stderr).toBe(0);
      expect(JSON.parse(fetched.stdout)).toMatchObject({
        message_id: messageId,
        recipient: 'session-instance-9',
        target_kind: 'session',
        payload: 'exact session only',
      });

      const wrongKind = spawnSync(process.execPath, cliArgs(
        'message', 'fetch', '--project', 'test', '--recipient', 'session-instance-9',
        '--target-kind', 'principal', '--message-id', messageId,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(wrongKind.status).not.toBe(0);
      expect(wrongKind.stderr).toContain('not available');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported --target-kind before reading or persisting payload', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'session-instance-9', '--target-kind', 'replacement',
        '--idempotency-key', 'invalid-target-kind', '--payload-stdin',
      ), {
        encoding: 'utf8',
        input: 'must not persist',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--target-kind "replacement" is not valid. Use one of: principal, session.');
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects payload argv and requires the stdin-only flag', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    try {
      const result = spawnSync(process.execPath, cliArgs(
        'message', 'send', '--project', 'test', '--sender', 'sender',
        '--recipient', 'recipient', '--idempotency-key', 'one', '--payload-stdin',
        '--payload', 'sentinel-must-not-be-logged',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown option '--payload'/);
      expect(`${result.stdout}${result.stderr}`).not.toContain('sentinel-must-not-be-logged');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports storage and keeps prune dry-run non-mutating by default', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-message-'));
    const cutoff = '2026-08-27T00:00:00.000Z';
    try {
      const report = spawnSync(process.execPath, cliArgs(
        'message', 'storage', 'report', '--cutoff', cutoff,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(report.status, report.stderr).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        policy: { cutoff, quota_bytes: null, automatic_pruning: false },
        message_count: 0,
        protected_unresolved_message_count: 0,
      });

      const dryRun = spawnSync(process.execPath, cliArgs(
        'message', 'storage', 'prune', '--cutoff', cutoff, '--batch-size', '1',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toEqual({
        dry_run: true,
        candidate_count: 0,
        tombstoned_count: 0,
        reclaimed_payload_bytes: 0,
        candidates: [],
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates reusable owner-private managed host config without a fabricated session identity', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as {
        config_path: string;
        session_identity: string;
        ordinary_sessions: string;
        registration_command: string | null;
        launch_command: string;
      };
      expect(result).toMatchObject({
        session_identity: 'generated-per-process',
        ordinary_sessions: 'presence-only/inbound-unavailable',
        registration_command: null,
        launch_command: expect.stringContaining('memesh-host-codex'),
      });
      const stat = fs.statSync(result.config_path);
      expect(stat.mode & 0o077).toBe(0);
      const config = JSON.parse(fs.readFileSync(result.config_path, 'utf8')) as Record<string, unknown>;
      expect(config).toMatchObject({ project: 'test', principal_id: 'reviewer', workspace: home });
      expect(config).not.toHaveProperty('session_instance_id');
      expect(config).not.toHaveProperty('thread_id');

      const repeat = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex', '--project', 'test', '--principal', 'replacement',
        '--workspace', home,
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(repeat.status).not.toBe(0);
      expect(repeat.stderr).toContain('was not overwritten');
      expect(JSON.parse(fs.readFileSync(result.config_path, 'utf8'))).toMatchObject({ principal_id: 'reviewer' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('requires explicit owner-private opt-in before attaching an ordinary Codex workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'codex-session', '--project', 'test', '--principal', 'reviewer',
        '--workspace', home, '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as Record<string, unknown>;
      expect(result).toMatchObject({
        mode: 'ordinary-session-native-queue',
        session_identity: 'codex-thread-id-at-session-start',
        ordinary_sessions: 'explicit-workspace-opt-in',
        launch_command: null,
        next_command: 'Restart Codex in the configured workspace',
      });
      const configPath = String(result.config_path);
      expect(configPath).toMatch(/hosts\/codex-session\.json$/);
      expect(fs.statSync(configPath).mode & 0o077).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({
        project: 'test', principal_id: 'reviewer', workspace: fs.realpathSync(home),
      });
      const tokenPath = path.join(home, '.memesh', 'agent-router.token');
      expect(fs.readFileSync(tokenPath, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(tokenPath).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints both Claude one-time registration and the required development-channel launch', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-agent-'));
    try {
      const setup = spawnSync(process.execPath, cliArgs(
        'agent', 'setup', 'claude', '--project', 'project-a', '--principal', 'claude-a', '--json',
      ), {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
      });
      expect(setup.status, setup.stderr).toBe(0);
      const result = JSON.parse(setup.stdout) as {
        registration_command: string;
        launch_command: string;
        next_command: string;
      };
      expect(result.registration_command).toContain('claude mcp add --transport stdio --scope user memesh-channel');
      expect(result.next_command).toBe(result.registration_command);
      expect(result.launch_command).toBe('claude --dangerously-load-development-channels server:memesh-channel');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});
