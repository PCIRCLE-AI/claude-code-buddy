#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const option = process.argv.indexOf('--root');
const root = option >= 0 ? path.resolve(process.argv[option + 1] ?? '') : path.resolve(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const errors = [];

const source = read('src/transports/mcp/handlers.ts').replace(/\r\n/g, '\n');
const contract = source.match(/export const TOOL_DEFINITIONS = \[([\s\S]*?)\n\] as const;/)?.[0];
if (!contract) {
  process.stderr.write('mcp-doc-parity: FAIL (cannot extract TOOL_DEFINITIONS)\n');
  process.exit(1);
}

const tools = [...contract.matchAll(/^\s{4}name:\s*'([^']+)',\n\s{4}(?:\/\/[^\n]*\n\s{4})*description:\s*(?:\n\s{6})?(['"`])([\s\S]*?)\2,\n\s{4}inputSchema:/gm)]
  .map(match => ({ name: match[1], description: match[3].trim() }));
const names = tools.map(tool => tool.name);
const nameSet = new Set(names);
if (names.length !== 11 || nameSet.size !== names.length) {
  errors.push(`canonical MCP source must contain 11 uniquely parseable top-level tools; found ${names.length}`);
}
for (const tool of tools) {
  if (!tool.description) errors.push(`canonical MCP tool ${tool.name} has an empty description`);
}

const semanticContract = contract
  .replace(/^\s*\/\/[^\n]*$/gm, '')
  .replace(/\s+/g, ' ')
  .trim();
const contractDigest = createHash('sha256').update(semanticContract).digest('hex');
const lock = JSON.parse(read('scripts/mcp-doc-contract.json'));
const surfaceDigest = (surface) => createHash('sha256')
  .update(`${contractDigest}\0${surface.trim()}`)
  .digest('hex');
const checkedSurfaces = new Set();
if (lock.schema_version !== 'mcp-doc-contract/v2') errors.push('scripts/mcp-doc-contract.json: unsupported schema_version');
if (lock.source_sha256 !== contractDigest) {
  errors.push('scripts/mcp-doc-contract.json: canonical MCP source digest is stale; review every documented tool description');
}
const checkLockedSurface = (file, surface) => {
  checkedSurfaces.add(file);
  if (lock.surfaces?.[file] !== surfaceDigest(surface)) {
    errors.push(`${file}: certified MCP documentation surface is stale for the current source contract; review its tool names and descriptions, then recertify scripts/mcp-doc-contract.json`);
  }
};
const tableDocs = [
  ['README.md', /## All 11[^\n]*\n([\s\S]*?)\n---/m],
  ['README.zh-TW.md', /## .*11[^\n]*\n([\s\S]*?)\n---/m],
  ['README.de.md', /## .*11[^\n]*\n([\s\S]*?)\n---/m],
  ['AGENTS.md', /## All 11 MCP tools\n([\s\S]*?)(?=\n## )/m],
  ['skills/memesh/SKILL.md', /## All 11 MCP tools\n([\s\S]*?)(?=\n## )/m],
];

for (const [file, sectionPattern] of tableDocs) {
  const text = read(file);
  const section = text.match(sectionPattern)?.[1];
  if (!section) {
    errors.push(`${file}: missing the bounded 11-tool table`);
    continue;
  }
  checkLockedSurface(file, section);
  const rows = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|\n]+?)\s*\|\s*$/gm)]
    .map(match => ({ name: match[1], description: match[2].trim() }));
  const counts = new Map();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  const missing = names.filter(name => !counts.has(name));
  const extra = rows.filter(row => !nameSet.has(row.name)).map(row => row.name);
  const duplicate = [...counts].filter(([, count]) => count !== 1).map(([name]) => name);
  const empty = rows.filter(row => !row.description).map(row => row.name);
  if (rows.length !== names.length || missing.length || extra.length || duplicate.length || empty.length) {
    errors.push(`${file}: expected exactly ${names.length} described canonical tools; found=${rows.length} missing=[${missing}] extra=[${extra}] duplicates=[${duplicate}] empty=[${empty}]`);
  }
}

const api = read('docs/api/API_REFERENCE.md');
const apiSurface = api.match(/## Tools\n([\s\S]*?)(?=\n## )/m)?.[1] ?? '';
if (!apiSurface) errors.push('docs/api/API_REFERENCE.md: missing bounded Tools section');
else checkLockedSurface('docs/api/API_REFERENCE.md', apiSurface);
for (const name of names) {
  const section = api.match(new RegExp(`^### ${name}\\n\\n([^\\n]+)`, 'm'));
  if (!section?.[1]?.trim()) errors.push(`docs/api/API_REFERENCE.md: missing a non-empty ### ${name} description`);
}

const architecture = read('docs/ARCHITECTURE.md');
const overview = architecture.match(/## Overview\n([\s\S]*?)(?=\n## |\n```)/m)?.[1] ?? '';
if (!overview) errors.push('docs/ARCHITECTURE.md: missing bounded Overview section');
else checkLockedSurface('docs/ARCHITECTURE.md', overview);
for (const name of names) {
  if (!overview.includes(`\`${name}\``)) errors.push(`docs/ARCHITECTURE.md: overview omits MCP tool ${name}`);
}
for (const file of Object.keys(lock.surfaces ?? {})) {
  if (!checkedSurfaces.has(file)) errors.push(`scripts/mcp-doc-contract.json: unrecognized surface ${file}`);
}

if (errors.length) {
  process.stderr.write(`mcp-doc-parity: FAIL (${errors.length} issue(s))\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}

process.stdout.write(`mcp-doc-parity: PASS (${names.length} tools across 7 agent-facing documents; contract sha256:${contractDigest})\n`);
