#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { readConfig, updateConfig, maskApiKey, detectCapabilities } from '../../core/config.js';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../package.json'
);
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const program = new Command();
program
  .name('memesh')
  .description('MeMesh — The lightest universal AI memory layer')
  .version(pkg.version);

// --- remember ---
program
  .command('remember')
  .description('Store knowledge as an entity')
  .requiredOption('--name <name>', 'Entity name')
  .requiredOption('--type <type>', 'Entity type')
  .option('--obs <observations...>', 'Observations (space-separated)')
  .option('--tags <tags...>', 'Tags (space-separated)')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    openDatabase();
    try {
      const result = remember({
        name: opts.name,
        type: opts.type,
        observations: opts.obs,
        tags: opts.tags,
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`✅ Stored "${result.name}" (${result.observations} observations, ${result.tags} tags)`);
      }
    } finally {
      closeDatabase();
    }
  });

// --- recall ---
program
  .command('recall')
  .description('Search stored knowledge')
  .argument('[query]', 'Search query')
  .option('--tag <tag>', 'Filter by tag')
  .option('--limit <n>', 'Max results', '20')
  .option('--include-archived', 'Include archived entities')
  .option('--json', 'Output as JSON')
  .action(async (query, opts) => {
    openDatabase();
    try {
      // recallEnhanced: uses LLM query expansion when configured, falls back otherwise
      const entities = await recallEnhanced({
        query: query || undefined,
        tag: opts.tag,
        limit: parseInt(opts.limit),
        include_archived: opts.includeArchived,
      });
      const kg = new KnowledgeGraph(getDatabase());
      const conflicts = kg.findConflicts(entities.map(e => e.name));

      if (opts.json) {
        if (conflicts.length > 0) {
          console.log(JSON.stringify({ entities, conflicts }));
        } else {
          console.log(JSON.stringify(entities));
        }
      } else if (entities.length === 0) {
        console.log('No results found.');
      } else {
        for (const e of entities) {
          const badge = e.archived ? ' [archived]' : '';
          console.log(`  ${e.name}${badge} (${e.type})`);
          for (const obs of e.observations.slice(0, 3)) {
            console.log(`    - ${obs}`);
          }
          if (e.observations.length > 3) {
            console.log(`    ... +${e.observations.length - 3} more`);
          }
        }
        console.log(`\n${entities.length} result(s)`);
        if (conflicts.length > 0) {
          console.log('\nWarning: Conflicts detected:');
          for (const c of conflicts) {
            console.log(`  ${c}`);
          }
        }
      }
    } finally {
      closeDatabase();
    }
  });

// --- forget ---
program
  .command('forget')
  .description('Archive an entity or remove an observation')
  .requiredOption('--name <name>', 'Entity name')
  .option('--observation <text>', 'Remove specific observation only')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    openDatabase();
    try {
      const result = forget({
        name: opts.name,
        observation: opts.observation,
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else if (result.archived) {
        console.log(`📦 Archived "${opts.name}"`);
      } else if (result.observation_removed) {
        console.log(`✂️  Removed observation (${result.remaining_observations} remaining)`);
      } else {
        console.log(`Entity "${opts.name}" not found`);
      }
    } finally {
      closeDatabase();
    }
  });

// --- config ---
const configCmd = program.command('config').description('Manage configuration');

configCmd
  .command('list')
  .description('Show current configuration')
  .action(() => {
    const config = readConfig();
    const caps = detectCapabilities(config);
    console.log('Configuration (~/.memesh/config.json):');
    if (config.llm) {
      console.log(`  LLM provider: ${config.llm.provider}`);
      console.log(`  LLM model: ${config.llm.model || 'default'}`);
      if (config.llm.apiKey) console.log(`  API key: ${maskApiKey(config.llm.apiKey)}`);
    } else {
      console.log('  LLM provider: not configured');
    }
    console.log(`\nSearch level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
  });

configCmd
  .command('set')
  .description('Set a config value')
  .argument('<key>', 'Config key (e.g., llm.provider)')
  .argument('<value>', 'Config value')
  .action((key, value) => {
    const config = readConfig();
    if (key === 'llm.provider') {
      config.llm = { ...config.llm, provider: value as any };
    } else if (key === 'llm.api-key') {
      config.llm = { ...config.llm, provider: config.llm?.provider || 'anthropic', apiKey: value };
    } else if (key === 'llm.model') {
      config.llm = { ...config.llm, provider: config.llm?.provider || 'anthropic', model: value };
    } else {
      console.error(`Unknown key: ${key}`);
      process.exit(1);
    }
    updateConfig(config);
    console.log(`✅ Set ${key} = ${key.includes('key') ? maskApiKey(value) : value}`);
  });

configCmd
  .command('unset')
  .description('Remove a config value')
  .argument('<key>', 'Config key')
  .action((key) => {
    const config = readConfig();
    if (key === 'llm.api-key' && config.llm) {
      delete config.llm.apiKey;
    } else if (key === 'llm.provider') {
      delete config.llm;
    } else {
      console.error(`Unknown key: ${key}`);
      process.exit(1);
    }
    updateConfig(config);
    console.log(`✅ Removed ${key}`);
  });

// --- serve (start HTTP server) ---
program
  .command('serve')
  .description('Start HTTP API server')
  .option('--port <port>', 'Port number', '3737')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .action(async (opts) => {
    const { startServer } = await import('../http/server.js');
    startServer(opts.host, parseInt(opts.port));
  });

// --- update ---
program
  .command('update')
  .description('Update MeMesh to latest version')
  .action(async () => {
    const { checkForUpdate } = await import('../../core/version-check.js');
    const check = await checkForUpdate(pkg.version);

    if (!check.updateAvailable) {
      console.log(`✅ Already on latest version (${pkg.version})`);
      return;
    }

    console.log(`🔄 Updating ${pkg.version} → ${check.latestVersion}...`);

    const { execFileSync } = await import('child_process');
    try {
      execFileSync('npm', ['install', '-g', `@pcircle/memesh@${check.latestVersion}`], { stdio: 'inherit' });
      console.log(`✅ Updated to ${check.latestVersion}`);
    } catch {
      console.error('❌ Update failed. Try manually: npm install -g @pcircle/memesh@latest');
      process.exit(1);
    }
  });

// --- status ---
program
  .command('status')
  .description('Show MeMesh status and capabilities')
  .action(async () => {
    const caps = detectCapabilities();
    const { getLastUpdateCheck } = await import('../../core/version-check.js');
    const update = getLastUpdateCheck();

    console.log(`MeMesh v${pkg.version}`);
    console.log(`Search level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
    console.log(`Embeddings: ${caps.embeddings}`);
    console.log(`LLM: ${caps.llm ? `${caps.llm.provider} (${caps.llm.model})` : 'not configured'}`);

    if (update?.updateAvailable) {
      console.log(`\n🔄 Update available: ${update.latestVersion} (run: memesh update)`);
    }
  });

program.parse();
