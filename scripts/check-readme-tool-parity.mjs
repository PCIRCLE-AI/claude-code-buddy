#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const option = process.argv.indexOf('--root');
const root = option >= 0 ? path.resolve(process.argv[option + 1] ?? '') : path.resolve(here, '..');
const sourcePath = path.join(root, 'src/transports/mcp/handlers.ts');
const readmes = ['README.md', 'README.zh-TW.md', 'README.de.md'];

const source = fs.readFileSync(sourcePath, 'utf8');
const canonical = [...source.matchAll(/^\s{4}name:\s*'([^']+)',/gm)].map(match => match[1]);
const canonicalSet = new Set(canonical);
const errors = [];

if (canonical.length !== 11 || canonicalSet.size !== canonical.length) {
  errors.push(`canonical MCP source must contain 11 unique top-level tools; found ${canonical.length}`);
}

for (const file of readmes) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const heading = text.search(/^## .*11.*$/m);
  if (heading < 0) {
    errors.push(`${file}: missing the public 11-tool section`);
    continue;
  }
  const sectionStart = text.indexOf('\n', heading) + 1;
  const nextSection = text.indexOf('\n---', sectionStart);
  const section = text.slice(sectionStart, nextSection < 0 ? text.length : nextSection);
  const documented = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]);
  const counts = new Map();
  for (const name of documented) counts.set(name, (counts.get(name) ?? 0) + 1);
  const missing = canonical.filter(name => !counts.has(name));
  const extra = documented.filter(name => !canonicalSet.has(name));
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([name]) => name);
  if (documented.length !== canonical.length || missing.length || extra.length || duplicates.length) {
    errors.push(
      `${file}: expected exactly ${canonical.length} canonical tools; `
      + `found=${documented.length} missing=[${missing.join(',')}] `
      + `extra=[${extra.join(',')}] duplicates=[${duplicates.join(',')}]`,
    );
  }
}

if (errors.length) {
  process.stderr.write(`readme-tool-parity: FAIL (${errors.length} issue(s))\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}

process.stdout.write(`readme-tool-parity: PASS (${canonical.length} tools across ${readmes.length} READMEs)\n`);
