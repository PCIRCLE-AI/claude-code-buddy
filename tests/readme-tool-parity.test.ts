import { createHash } from 'node:crypto';
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

function write(root: string, file: string, value: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mcp-doc-parity-'));
  dirs.push(root);
  const contract = [
    'export const TOOL_DEFINITIONS = [',
    ...names.map(name => `  {\n    name: '${name}',\n    description: '${name} canonical description',\n    inputSchema: { type: 'object' as const },\n  },`),
    '] as const;',
  ].join('\n');
  write(root, 'src/transports/mcp/handlers.ts', contract);
  const digest = (surface: string) => createHash('sha256').update(surface.trim()).digest('hex');
  const table = ['| Tool | Description |', '|---|---|', ...names.map(name => `| \`${name}\` | ${name} documentation |`)].join('\n');
  for (const file of ['README.md', 'README.zh-TW.md', 'README.de.md']) {
    write(root, file, `## All 11 Tools\n\n${table}\n\n---\n`);
  }
  write(root, 'AGENTS.md', `## All 11 MCP tools\n\n${table}\n\n## Next\n`);
  write(root, 'skills/memesh/SKILL.md', `## All 11 MCP tools\n\n${table}\n\n## Next\n`);
  const apiTools = names.map(name => `### ${name}\n\n${name} API description.\n`).join('\n');
  write(root, 'docs/api/API_REFERENCE.md', `## Tools\n\n${apiTools}\n## HTTP\n`);
  const overview = names.map(name => `\`${name}\``).join(', ');
  write(root, 'docs/ARCHITECTURE.md', `## Overview\n\n${overview}\n\n\`\`\`\narchitecture\n\`\`\`\n`);
  write(root, 'scripts/mcp-doc-contract.json', `${JSON.stringify({
    schema_version: 'mcp-doc-contract/v1',
    source_sha256: createHash('sha256').update(contract).digest('hex'),
    surfaces: {
      'README.md': digest(table),
      'README.zh-TW.md': digest(table),
      'README.de.md': digest(table),
      'AGENTS.md': digest(table),
      'skills/memesh/SKILL.md': digest(table),
      'docs/api/API_REFERENCE.md': digest(apiTools),
      'docs/ARCHITECTURE.md': digest(overview),
    },
  }, null, 2)}\n`);
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

describe('MCP agent-facing documentation parity gate', () => {
  it('accepts one described row or API section for every canonical tool', () => {
    expect(names).toHaveLength(11);
    const result = run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS (11 tools across 7 agent-facing documents');
  });

  it.each([
    ['README translation row', 'README.de.md', (text: string) => text.replace(/^\| `message` .*\n/m, ''), 'README.de.md'],
    ['skill row', 'skills/memesh/SKILL.md', (text: string) => text.replace(/^\| `improvement` .*\n/m, ''), 'skills/memesh/SKILL.md'],
    ['API section', 'docs/api/API_REFERENCE.md', (text: string) => text.replace(/### message\n\nmessage API description\.\n/m, ''), '### message'],
    ['architecture inventory', 'docs/ARCHITECTURE.md', (text: string) => text.replace('`briefing`, ', ''), 'overview omits MCP tool briefing'],
  ])('rejects a missing %s', (_label, file, mutate, expected) => {
    const root = fixture();
    const target = path.join(root, file);
    fs.writeFileSync(target, mutate(fs.readFileSync(target, 'utf8')));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expected);
  });

  it('forces explicit documentation review when a canonical description or schema changes', () => {
    const root = fixture();
    const target = path.join(root, 'src/transports/mcp/handlers.ts');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('remember canonical description', 'changed canonical description'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical MCP source digest is stale');
  });

  it('rejects a false non-empty tool description even when the old marker remains', () => {
    const root = fixture();
    const target = path.join(root, 'README.md');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('remember documentation', 'Deletes every memory immediately'));
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('README.md: certified MCP documentation surface is stale');
  });
});
