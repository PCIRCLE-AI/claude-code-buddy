#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories } from '../../core/operations.js';
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
  .option('--namespace <namespace>', 'Namespace: personal, team, or global (default: personal)')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    openDatabase();
    try {
      const result = remember({
        name: opts.name,
        type: opts.type,
        observations: opts.obs,
        tags: opts.tags,
        namespace: opts.namespace,
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
  .option('--namespace <namespace>', 'Filter by namespace: personal, team, or global')
  .option('--cross-project', 'Search across all project tags (ignores --tag filter)')
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
        namespace: opts.namespace,
        cross_project: opts.crossProject,
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

// --- consolidate ---
program
  .command('consolidate')
  .description('Compress verbose entity observations using an LLM (requires Smart Mode)')
  .option('--name <name>', 'Specific entity to consolidate')
  .option('--tag <tag>', 'Consolidate all entities with this tag')
  .option('--min-obs <n>', 'Minimum observations to trigger (default: 5)', '5')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    openDatabase();
    try {
      const result = await consolidate({
        name: opts.name,
        tag: opts.tag,
        min_observations: parseInt(opts.minObs),
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else if (result.error) {
        console.error(`Error: ${result.error}`);
        process.exitCode = 1;
      } else if (result.consolidated === 0) {
        console.log('No entities consolidated (none met the minimum observations threshold).');
      } else {
        console.log(`Consolidated ${result.consolidated} entity/entities.`);
        console.log(`Observations: ${result.observations_before} -> ${result.observations_after}`);
        if (result.entities_processed.length > 0) {
          console.log(`Processed: ${result.entities_processed.join(', ')}`);
        }
      }
    } finally {
      closeDatabase();
    }
  });

// --- export ---
program
  .command('export')
  .description('Export memories as JSON for sharing or backup')
  .option('--tag <tag>', 'Export only entities with this tag')
  .option('--namespace <ns>', 'Export only from this namespace (personal, team, global)')
  .option('--limit <n>', 'Max entities to export', '1000')
  .action((opts) => {
    openDatabase();
    try {
      const result = exportMemories({
        tag: opts.tag,
        namespace: opts.namespace,
        limit: parseInt(opts.limit),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      closeDatabase();
    }
  });

// --- import ---
program
  .command('import')
  .description('Import memories from a JSON export file')
  .argument('<file>', 'Path to JSON export file')
  .option('--namespace <ns>', 'Override namespace for all imported entities')
  .option('--merge <strategy>', 'Merge strategy: skip | overwrite | append', 'skip')
  .action((file, opts) => {
    openDatabase();
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      const result = importMemories({
        data,
        namespace: opts.namespace,
        merge_strategy: opts.merge as 'skip' | 'overwrite' | 'append',
      });
      console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}, Appended: ${result.appended}`);
      if (result.errors.length > 0) {
        console.error(`Errors:\n  ${result.errors.join('\n  ')}`);
        process.exitCode = 1;
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
      if (config.llm.apiKey) {
        const masked = maskApiKey(config.llm.apiKey); // never logs raw key
        console.log(`  API key: ${masked}`);
      }
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
      const validProviders = ['anthropic', 'openai', 'ollama'] as const;
      if (!validProviders.includes(value as any)) {
        console.error(`Invalid provider: ${value}. Must be one of: ${validProviders.join(', ')}`);
        process.exit(1);
      }
      config.llm = { ...config.llm, provider: value as 'anthropic' | 'openai' | 'ollama' };
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

// --- export-schema ---
program
  .command('export-schema')
  .description('Export MeMesh tools in OpenAI function calling format')
  .option('--format <format>', 'Output format (openai)', 'openai')
  .action(async (opts) => {
    const { exportOpenAITools } = await import('../../core/schema-export.js');
    if (opts.format === 'openai') {
      console.log(JSON.stringify(exportOpenAITools(), null, 2));
    } else {
      console.error(`Unknown format: ${opts.format}. Available: openai`);
      process.exit(1);
    }
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

// Default action: open the live dashboard when run with no subcommand
program.action(async () => {
  const { startServer } = await import('../http/server.js');
  const server = startServer('127.0.0.1', 0); // 0 = random available port

  // Wait for the server to be listening before reading the port
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const addr = server.address() as { address: string; port: number } | null;
  if (!addr) {
    console.error('Failed to start dashboard server');
    process.exit(1);
  }

  const url = `http://127.0.0.1:${addr.port}/dashboard`;
  console.log(`MeMesh dashboard: ${url}`);
  console.log('Press Ctrl+C to stop.');

  const { execFile } = await import('child_process');
  if (process.platform === 'darwin') {
    execFile('open', [url]);
  } else if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url]);
  } else {
    execFile('xdg-open', [url]);
  }

  // closeDatabase was imported at the top of this file
  process.on('SIGINT', () => {
    server.close();
    try { closeDatabase(); } catch { /* ignore if not open */ }
    process.exit(0);
  });
});

program.parse();
