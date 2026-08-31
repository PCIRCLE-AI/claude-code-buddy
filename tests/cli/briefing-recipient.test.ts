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

function runCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', cliLoader, ...args], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, HOME: home, MEMESH_AUTO_CAPTURE: 'false' },
  });
}

function send(home: string, recipient: string, key: string) {
  const result = runCli(
    home,
    'message', 'send', '--project', 'briefing-cli-project', '--sender', 'sender',
    '--recipient', recipient, '--idempotency-key', key, '--payload-stdin',
  );
  expect(result.status, result.stderr).toBe(0);
}

describe('CLI briefing recipient scope', () => {
  it('hides generic inbox activity and reports only the exact recipient', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-briefing-'));
    try {
      send(home, 'recipient-one', 'cli-briefing-one');
      send(home, 'recipient-two', 'cli-briefing-two');

      const generic = runCli(home, 'briefing', '--project', 'briefing-cli-project', '--json');
      expect(generic.status, generic.stderr).toBe(0);
      expect(JSON.parse(generic.stdout).text).not.toContain('message waiting');

      const scoped = runCli(
        home, 'briefing', '--project', 'briefing-cli-project', '--recipient', 'recipient-one', '--json',
      );
      expect(scoped.status, scoped.stderr).toBe(0);
      const text = JSON.parse(scoped.stdout).text as string;
      expect(text).toContain('1 message waiting for "recipient-one"');
      expect(text).toContain('in project "briefing-cli-project"');
      expect(text).not.toContain('recipient-two');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
