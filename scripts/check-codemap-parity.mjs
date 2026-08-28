#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const option = process.argv.indexOf('--root');
const root = option >= 0 ? path.resolve(process.argv[option + 1] ?? '') : path.resolve(here, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));
const errors = [];
const checkExact = (label, actual, expected) => {
  const counts = new Map();
  for (const value of actual) counts.set(value, (counts.get(value) ?? 0) + 1);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !counts.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  const duplicate = [...counts].filter(([, count]) => count !== 1).map(([value]) => value);
  if (actual.length !== expected.length || missing.length || extra.length || duplicate.length) {
    errors.push(`${label} must match exactly; missing=[${missing}] extra=[${extra}] duplicates=[${duplicate}]`);
  }
};

const pkg = JSON.parse(read('package.json'));
const codemap = read('CODEMAP.md');
const architecture = read('docs/ARCHITECTURE.md');
const hooks = JSON.parse(read('hooks/hooks.json'));

const version = codemap.match(/\*\*Version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
if (!version) errors.push('CODEMAP.md has no `**Version**: X.Y.Z` stamp');
else if (version !== pkg.version) errors.push(`CODEMAP.md says ${version}, package.json says ${pkg.version}`);

const entrySection = codemap.match(/## Start here \(entry points\)([\s\S]*?)\n---/m)?.[1] ?? '';
if (!entrySection) errors.push('CODEMAP.md has no bounded `Start here (entry points)` section');
const architectureEntries = architecture.match(/## Package Entry Points([\s\S]*?)\n---/m)?.[1] ?? '';
if (!architectureEntries) errors.push('docs/ARCHITECTURE.md has no bounded `Package Entry Points` section');

const bins = Object.entries(pkg.bin ?? {});
if (bins.length === 0) errors.push('package.json yielded no bin entry points');
for (const [name, target] of bins) {
  const source = String(target).replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
  if (!exists(source)) errors.push(`package.json bin ${name} maps to ${target}, but source ${source} does not exist`);
  if (!entrySection.includes(`\`${name}`) && !(name === 'memesh' && entrySection.includes('`memesh <cmd>`'))) {
    errors.push(`CODEMAP.md entry-point table omits package bin ${name}`);
  }
  if (!entrySection.includes(`\`${source}\``)) {
    errors.push(`CODEMAP.md entry-point table omits ${source} for package bin ${name}`);
  }
  if (!architectureEntries.includes(`\`${name}\``) || !architectureEntries.includes(`\`${source}\``)) {
    errors.push(`docs/ARCHITECTURE.md package entry points omit ${name} → ${source}`);
  }
}
const architectureBins = [...architectureEntries.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/gm)]
  .map((match) => `${match[1]}→${match[2]}`);
checkExact(
  'docs/ARCHITECTURE.md package entry points',
  architectureBins,
  bins.map(([name, target]) => `${name}→${String(target).replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')}`),
);

const hookCommands = [];
for (const matchers of Object.values(hooks.hooks ?? {})) {
  for (const matcher of matchers) {
    for (const hook of matcher.hooks ?? []) {
      const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
      hookCommands.push(
        command.startsWith('dist/')
          ? command.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
          : command,
      );
    }
  }
}
if (hookCommands.length === 0) errors.push('hooks/hooks.json yielded no hook commands');
const hookTable = codemap.match(/### Hook commands \(`hooks\/hooks\.json`\)([\s\S]*?)\n---/m)?.[1] ?? '';
if (!hookTable) errors.push('CODEMAP.md has no bounded hook-command table');
const architectureHooks = architecture.match(/### Hook Commands \(8 hooks\)([\s\S]*?)(?=\n### )/m)?.[1] ?? '';
if (!architectureHooks) errors.push('docs/ARCHITECTURE.md has no bounded 8-hook command table');
for (const command of hookCommands) {
  if (!exists(command)) errors.push(`hooks/hooks.json maps to a missing source command: ${command}`);
  const documented = command.startsWith('scripts/hooks/') ? path.basename(command) : command;
  if (!hookTable.includes(`\`${documented}\``)) errors.push(`CODEMAP.md hook table omits ${documented}`);
  const architectureName = command.startsWith('src/host-runtime/')
    ? path.basename(command).replace(/\.ts$/, '.js')
    : path.basename(command);
  if (!architectureHooks.includes(`| ${architectureName} |`)) {
    errors.push(`docs/ARCHITECTURE.md hook table omits ${architectureName}`);
  }
}
const codemapHookNames = [...hookTable.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]);
const expectedCodemapHooks = hookCommands.map((command) => (
  command.startsWith('scripts/hooks/') ? path.basename(command) : command
));
checkExact('CODEMAP.md hook commands', codemapHookNames, expectedCodemapHooks);
const architectureHookNames = [...architectureHooks.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
  .map((match) => match[1].trim())
  .filter((name) => name !== 'Hook' && !/^-+$/.test(name));
const expectedArchitectureHooks = hookCommands.map((command) => (
  command.startsWith('src/host-runtime/')
    ? path.basename(command).replace(/\.ts$/, '.js')
    : path.basename(command)
));
checkExact('docs/ARCHITECTURE.md hook commands', architectureHookNames, expectedArchitectureHooks);

const messagingAnchors = [
  'src/core/agent-messaging.ts',
  'src/core/agent-router.ts',
  'src/transports/agent-messaging.ts',
  'src/host-adapters/',
  'src/host-runtime/',
  'docs/platforms/agent-messaging.md',
];
const codemapMessaging = codemap.match(/### Durable local agent messaging \+ active-host delivery([\s\S]*?)(?=\n### )/m)?.[1] ?? '';
const architectureMessaging = architecture.match(/Implementation anchors:([\s\S]*?)\n\n/m)?.[1] ?? '';
for (const anchor of messagingAnchors) {
  if (!exists(anchor.replace(/\/$/, ''))) errors.push(`required messaging architecture path is missing: ${anchor}`);
  if (!codemap.includes(`\`${anchor}\``)) errors.push(`CODEMAP.md omits messaging architecture anchor ${anchor}`);
  if (!architecture.includes(`\`${anchor}\``)) errors.push(`docs/ARCHITECTURE.md omits messaging architecture anchor ${anchor}`);
}
checkExact(
  'CODEMAP.md messaging anchors',
  [...codemapMessaging.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  messagingAnchors,
);
checkExact(
  'docs/ARCHITECTURE.md messaging anchors',
  [...architectureMessaging.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  messagingAnchors,
);

const referencedFiles = [...codemap.matchAll(/`([A-Za-z0-9_./-]+\.(?:js|ts|mjs|tsx|md|json|toml))`/g)]
  .map((match) => match[1])
  .filter((file) => file.includes('/'));
if (referencedFiles.length < 12) errors.push(`CODEMAP.md path extraction matched only ${referencedFiles.length} files`);
for (const file of new Set(referencedFiles)) {
  if (!exists(file)) errors.push(`CODEMAP.md references a missing path: ${file}`);
}

if (errors.length) {
  process.stderr.write(`codemap-parity: FAIL (${errors.length} issue(s))\n`);
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `codemap-parity: PASS (${bins.length} bins, ${hookCommands.length} hook commands, ${messagingAnchors.length} messaging anchors)\n`,
);
