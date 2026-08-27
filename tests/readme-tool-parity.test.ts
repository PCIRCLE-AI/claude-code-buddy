import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-readme-tool-parity.mjs');
const dirs: string[] = [];
const names = [
  'remember', 'recall', 'forget', 'export', 'import', 'learn',
  'task_state', 'briefing', 'user_patterns', 'improvement', 'message',
];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readme-parity-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'src/transports/mcp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/transports/mcp/handlers.ts'), [
    'export const TOOL_DEFINITIONS = [',
    ...names.map(name => `  {\n    name: '${name}',\n  },`),
    '];',
  ].join('\n'));
  const table = [
    '## All 11 Tools', '', '| Tool | Description |', '|---|---|',
    ...names.map(name => `| \`${name}\` | description |`), '', '---',
  ].join('\n');
  for (const file of ['README.md', 'README.zh-TW.md', 'README.de.md']) {
    fs.writeFileSync(path.join(root, file), table);
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

describe('three-language README tool parity gate', () => {
  it('accepts exactly the canonical 11-tool inventory once per README', () => {
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS (11 tools across 3 READMEs)');
  });

  it.each([
    ['missing', (text: string) => text.replace(/^\| `message` .*\n/m, '')],
    ['duplicate', (text: string) => text.replace('| `message` | description |', '| `message` | description |\n| `message` | duplicate |')],
    ['extra', (text: string) => text.replace('\n---', '\n| `invented` | extra |\n\n---')],
  ])('fails when one translation has a %s tool row', (_label, mutate) => {
    const root = fixture();
    const file = path.join(root, 'README.de.md');
    fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('README.de.md');
  });
});
