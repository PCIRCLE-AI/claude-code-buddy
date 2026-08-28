import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-codemap-parity.mjs');
const dirs: string[] = [];
const bins = {
  memesh: 'dist/transports/cli/cli.js',
  'memesh-mcp': 'dist/mcp/server.js',
  'memesh-http': 'dist/transports/http/server.js',
  'memesh-router': 'dist/host-runtime/router.js',
  'memesh-host-claude': 'dist/host-runtime/claude.js',
  'memesh-host-codex': 'dist/host-runtime/codex.js',
  'memesh-host-codex-session': 'dist/host-runtime/codex-session.js',
  'memesh-host-acp': 'dist/host-runtime/acp.js',
};
const hookFiles = [
  'scripts/hooks/pre-edit-recall.js',
  'scripts/hooks/guard-check.js',
  'scripts/hooks/session-start.js',
  'dist/host-runtime/codex-session.js',
];
const messaging = [
  'src/core/agent-messaging.ts',
  'src/core/agent-router.ts',
  'src/transports/agent-messaging.ts',
  'src/host-adapters/',
  'src/host-runtime/',
  'docs/platforms/agent-messaging.md',
];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, value = '') {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-codemap-parity-'));
  dirs.push(root);
  write(root, 'package.json', JSON.stringify({ version: '4.8.1', bin: bins }));
  for (const target of Object.values(bins)) {
    write(root, target.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
  }
  for (const file of hookFiles) write(root, file);
  for (const file of messaging) {
    if (file.endsWith('/')) fs.mkdirSync(path.join(root, file), { recursive: true });
    else write(root, file);
  }
  write(root, 'hooks/hooks.json', JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: hookFiles.slice(0, 2).map(command => ({ command: `\${CLAUDE_PLUGIN_ROOT}/${command}` })) }],
      SessionStart: [{ hooks: hookFiles.slice(2).map(command => ({ command: `\${CLAUDE_PLUGIN_ROOT}/${command}` })) }],
    },
  }));
  const entryRows = Object.entries(bins).map(([name, target]) => {
    const source = target.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    return `| \`${name === 'memesh' ? 'memesh <cmd>' : name}\` | \`${source}\` |`;
  });
  const hookRows = hookFiles.map(file => {
    const source = file.startsWith('dist/')
      ? file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
      : path.basename(file);
    return `| \`${source}\` | event | purpose |`;
  });
  write(root, 'CODEMAP.md', [
    '# CODEMAP', '', '**Version**: 4.8.1', '',
    '## Start here (entry points)', '', '| You run… | Entry point |', '|---|---|', ...entryRows, '', '---', '',
    '### Durable local agent messaging', ...messaging.map(file => `- \`${file}\``), '',
    '### Hook commands (`hooks/hooks.json`)', '', '| Command | Fires on | Does |', '|---|---|---|', ...hookRows, '', '---',
  ].join('\n'));
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

describe('CODEMAP pre-release parity gate', () => {
  it('accepts the package bins, hook manifest, messaging anchors, and version together', () => {
    expect(Object.keys(bins)).toHaveLength(8);
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS (8 bins, 4 hook commands, 6 messaging anchors)');
  });

  it.each([
    ['version', (text: string) => text.replace('**Version**: 4.8.1', '**Version**: 4.2.8'), 'package.json says 4.8.1'],
    ['bin', (text: string) => text.replace(/^\| `memesh-router`.*\n/m, ''), 'omits package bin memesh-router'],
    ['hook', (text: string) => text.replace(/^\| `guard-check\.js`.*\n/m, ''), 'hook table omits guard-check.js'],
    ['messaging', (text: string) => text.replace(/^- `src\/core\/agent-router\.ts`\n/m, ''), 'omits messaging architecture anchor'],
  ])('rejects %s drift', (_label, mutate, expected) => {
    const root = fixture();
    const file = path.join(root, 'CODEMAP.md');
    fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
  });
});
