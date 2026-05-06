#!/usr/bin/env node

import { Command } from 'commander';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn, reindex } from '../../core/operations.js';
import { verifyAgentWork } from '../../core/verifier.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { readConfig, updateConfig, maskApiKey, detectCapabilities } from '../../core/config.js';
import { flushPendingEmbeddings } from '../../core/embedder.js';
import type { LessonSeverity, MergeStrategy } from '../../core/types.js';

// DX: every CLI command that touches the DB used to repeat
//   openDatabase(); try { ...body... } finally { closeDatabase(); }
// withDatabase factors that into one place so future commands cannot
// forget the close. Async-friendly via Promise return type.
async function withDatabase<T>(fn: () => T | Promise<T>): Promise<T> {
  openDatabase();
  try {
    return await fn();
  } finally {
    closeDatabase();
  }
}

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../package.json'
);
const packageRoot = path.dirname(packageJsonPath);
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const program = new Command();
program
  .name('memesh')
  .description('MeMesh — Local memory for Claude Code and MCP coding agents')
  .version(pkg.version)
  // DX: silence Commander's default "too many arguments. Expected 0..."
  // error so the root action below can inspect program.args and emit a
  // clear "unknown command 'foo'" message instead. allowExcessArguments
  // is the documented Commander 12+ escape hatch for this case.
  .allowExcessArguments(true)
  .showSuggestionAfterError(true);

// --- remember ---
// Two forms:
//   1. Explicit:  memesh remember --name "auth-decision" --type "decision" --obs "OAuth 2.0"
//   2. Quick:     memesh remember "OAuth 2.0 with PKCE"
// Quick form auto-generates name (date + slug) and defaults type to "note".
// The explicit form is the canonical contract; the quick form exists to
// reduce first-use friction since fresh users naturally try the one-arg
// shape before reading the README.
program
  .command('remember')
  .argument('[text]', 'Quick-capture text — auto-generates name and uses type=note')
  .description('Store knowledge as an entity (use flags for explicit form, or positional text for quick capture)')
  .option('--name <name>', 'Entity name')
  .option('--type <type>', 'Entity type')
  .option('--obs <observations...>', 'Observations (space-separated)')
  .option('--tags <tags...>', 'Tags (space-separated)')
  .option('--namespace <namespace>', 'Namespace: personal, team, or global (default: personal)')
  .option('--json', 'Output as JSON')
  .action(async (text, opts) => {
    // Resolve quick-capture form into name/type/obs.
    //
    // Each invocation produces a UNIQUE name. The earlier scheme used
    // `quick-<date>-<slug>` which is deterministic by day + first 40
    // chars of text — two calls of `memesh remember "fixed bug"` on
    // the same day would collide and `remember()` would silently merge
    // them into one entity (it appends observations on duplicate
    // name). For a journal/quick-capture flow, that's data loss.
    // Append a short random suffix so each call is a new entity.
    if (text && !opts.name && !opts.type) {
      const slug = String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const date = new Date().toISOString().slice(0, 10);
      const suffix = randomBytes(3).toString('hex'); // 6 hex chars = 16M outcomes
      opts.name = `quick-${date}-${slug || 'note'}-${suffix}`;
      opts.type = 'note';
      if (!opts.obs || opts.obs.length === 0) opts.obs = [String(text)];
    }
    if (!opts.name || !opts.type) {
      console.error(
        'Error: provide --name and --type, OR pass quick-capture text as a positional arg.\n' +
        '  memesh remember --name "auth" --type "decision" --obs "Use OAuth 2.0"\n' +
        '  memesh remember "Use OAuth 2.0 with PKCE"'
      );
      process.exit(1);
    }

    await withDatabase(async () => {
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
      await flushPendingEmbeddings();
    });
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
    await withDatabase(async () => {
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
    });
  });

// --- forget ---
program
  .command('forget')
  .description('Archive an entity or remove an observation')
  .requiredOption('--name <name>', 'Entity name')
  .option('--observation <text>', 'Remove specific observation only')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(() => {
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
    });
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
    await withDatabase(async () => {
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
        // DX: distinguish "name not found" from "exists but under
        // threshold" so users know which knob to turn (typo vs --min-obs).
        if (opts.name) {
          console.log(`No entity named "${opts.name}" found, or it has fewer than ${opts.minObs} observations (the consolidation threshold).`);
          console.log(`Try: memesh recall "${opts.name}" to confirm it exists, or memesh consolidate --name "${opts.name}" --min-obs 1`);
        } else if (opts.tag) {
          console.log(`No entities tagged "${opts.tag}" met the minimum observation threshold (${opts.minObs}).`);
          console.log(`Try: memesh recall --tag "${opts.tag}" to see candidates, or lower --min-obs.`);
        } else {
          console.log(`No entities met the minimum observation threshold (${opts.minObs}).`);
          console.log(`Try: memesh consolidate --min-obs 1 to consolidate everything.`);
        }
      } else {
        console.log(`Consolidated ${result.consolidated} entity/entities.`);
        console.log(`Observations: ${result.observations_before} -> ${result.observations_after}`);
        if (result.entities_processed.length > 0) {
          console.log(`Processed: ${result.entities_processed.join(', ')}`);
        }
      }
    });
  });

// --- export ---
program
  .command('export')
  .description('Export memories as JSON for sharing or backup')
  .option('--tag <tag>', 'Export only entities with this tag')
  .option('--namespace <ns>', 'Export only from this namespace (personal, team, global)')
  .option('--limit <n>', 'Max entities to export', '1000')
  .action(async (opts) => {
    await withDatabase(() => {
      const result = exportMemories({
        tag: opts.tag,
        namespace: opts.namespace,
        limit: parseInt(opts.limit),
      });
      console.log(JSON.stringify(result, null, 2));
    });
  });

// --- import ---
program
  .command('import')
  .description('Import memories from a JSON export file')
  .argument('<file>', 'Path to JSON export file')
  .option('--namespace <ns>', 'Override namespace for all imported entities')
  .option('--merge <strategy>', 'Merge strategy: skip | overwrite | append', 'skip')
  .action(async (file, opts) => {
    await withDatabase(() => {
      // DX: catch the failures new users hit first (missing file,
      // malformed JSON) and produce problem+cause+fix output instead
      // of a raw stack trace. The previous behaviour leaked
      // `<anonymous_script>:1` and `at JSON.parse (<anonymous>)`.
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          console.error(`Error: file not found: ${file}`);
          console.error(`       memesh import expects a file produced by 'memesh export'.`);
          console.error(`       Try: memesh export > my-export.json && memesh import my-export.json`);
          process.exit(1);
        }
        if (err?.code === 'EACCES') {
          console.error(`Error: cannot read ${file} (permission denied).`);
          console.error(`       Check file permissions: ls -la ${file}`);
          process.exit(1);
        }
        throw err;
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch (err: any) {
        const lineMatch = /position (\d+)/.exec(err?.message ?? '');
        const where = lineMatch ? ` near position ${lineMatch[1]}` : '';
        console.error(`Error: ${file} is not valid JSON${where}.`);
        console.error(`       memesh import expects a file produced by 'memesh export'.`);
        console.error(`       Try: memesh export > my-export.json && memesh import my-export.json`);
        process.exit(1);
      }

      const result = importMemories({
        data: data as any,
        namespace: opts.namespace,
        merge_strategy: opts.merge as MergeStrategy,
      });
      console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}, Appended: ${result.appended}`);
      if (result.errors.length > 0) {
        console.error(`Errors:\n  ${result.errors.join('\n  ')}`);
        process.exitCode = 1;
      }
    });
  });

// --- learn ---
program
  .command('learn')
  .description('Record a lesson from a mistake or discovery')
  .requiredOption('--error <text>', 'What went wrong')
  .requiredOption('--fix <text>', 'What fixed it')
  .option('--root-cause <text>', 'Why it happened')
  .option('--prevention <text>', 'How to prevent it next time')
  .option('--severity <level>', 'Severity: critical|major|minor', 'minor')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    await withDatabase(() => {
      const result = learn({
        error: opts.error,
        fix: opts.fix,
        root_cause: opts.rootCause,
        prevention: opts.prevention,
        severity: opts.severity as LessonSeverity | undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Lesson recorded: ${result.name}`);
      }
    });
  });

// --- verify ---
program
  .command('verify <workdir>')
  .description('Record a verification report for agent work in <workdir>')
  .requiredOption('--agent-id <id>', 'Identifier for the agent being verified')
  .option('--base <ref>', 'Git ref to diff against (default: merge-base with origin/main)')
  .option('--expected-files <n>', 'Number of files the agent claimed to change', (v) => parseInt(v, 10))
  .option('--report <path>', 'Path to a JSON file with pre-computed report (typecheck/tests/lint/build)')
  .option('--json', 'Output as JSON')
  .action(async (workdir, opts) => {
    await withDatabase(() => {
      let externalReport;
      if (opts.report) {
        const raw = fs.readFileSync(opts.report, 'utf8');
        externalReport = JSON.parse(raw);
      }
      const result = verifyAgentWork({
        agent_id: opts.agentId,
        workdir: path.resolve(workdir),
        base: opts.base,
        claim: opts.expectedFiles != null ? { expected_files: opts.expectedFiles } : undefined,
        report: externalReport,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const status = result.pass ? 'PASS' : 'FAIL';
        console.log(`${status}  agent=${opts.agentId}  entity=${result.entity_name}`);
        console.log(`  reality: ${result.reality_check.summary}`);
      }
      process.exit(result.pass ? 0 : 1);
    });
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
  .option('--allow-remote', 'Allow binding to non-loopback hosts (no auth layer is added)')
  .action(async (opts) => {
    const { startServer } = await import('../http/server.js');
    startServer(opts.host, parseInt(opts.port, 10), { allowRemote: opts.allowRemote });
  });

// --- update ---
program
  .command('update')
  .description('Update MeMesh to latest version (npm global installs)')
  .action(async () => {
    const { getCurrentInstallChannel, getInstallChannelSupport } = await import('../../core/install-channel.js');
    const install = getCurrentInstallChannel({ packageRoot });
    const installSupport = getInstallChannelSupport(install);

    if (!installSupport.canSelfUpdate) {
      console.error(`❌ memesh update does not support this install method (${installSupport.label}).`);
      console.error(`   ${installSupport.guidance}`);
      process.exit(1);
    }

    const { checkForUpdate } = await import('../../core/version-check.js');
    const check = await checkForUpdate(pkg.version);

    if (!check.checkSucceeded || !check.latestVersion) {
      console.error('❌ Unable to check npm for the latest MeMesh version right now.');
      console.error('   Try again later, or update manually: npm install -g @pcircle/memesh@latest');
      process.exit(1);
    }

    if (!check.updateAvailable) {
      console.log(`✅ Already on latest version (${pkg.version})`);
      return;
    }

    console.log(`🔄 Updating ${pkg.version} → ${check.latestVersion}...`);

    try {
      const { runGlobalUpdate } = await import('../../core/updater.js');
      const result = runGlobalUpdate(check.latestVersion);
      console.log(`✅ Updated to ${result.installedVersion}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`❌ Update failed: ${message}`);
      console.error('   This command supports npm global installs.');
      console.error('   Try manually: npm install -g @pcircle/memesh@latest');
      process.exit(1);
    }
  });

// --- doctor ---
program
  .command('doctor')
  .description('Verify local install health and show actionable fixes')
  .option('--json', 'Output machine-readable diagnostics as JSON')
  .option('--probe-http', 'Also probe the local HTTP server health endpoint')
  .option('--url <url>', 'Base URL for --probe-http', 'http://127.0.0.1:3737')
  .action(async (opts) => {
    const { formatDoctorReport, runDoctor } = await import('../../core/doctor.js');
    const result = await runDoctor({
      packageRoot,
      packageVersion: pkg.version,
      probeHttp: opts.probeHttp,
      httpBaseUrl: opts.url,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const line of formatDoctorReport(result, pkg.version)) {
        console.log(line);
      }
    }

    if (result.status === 'FAIL') {
      process.exitCode = 1;
    }
  });

// --- reindex ---
program
  .command('reindex')
  .description('Regenerate vector embeddings for all entities')
  .option('--namespace <namespace>', 'Reindex only entities in this namespace')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      await withDatabase(async () => {
        const result = await reindex({ namespace: opts.namespace });

        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`✅ Reindex complete:`);
          console.log(`   Processed: ${result.processed}`);
          console.log(`   Embedded:  ${result.embedded}`);
          console.log(`   Skipped:   ${result.skipped}`);
        }
      });
    } catch (err) {
      if (err instanceof Error) {
        console.error(`❌ Reindex failed: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  });

// --- patterns (skill-usage view) ---
program
  .command('patterns')
  .description('Show local skill-usage telemetry (agentic-orchestration banner injections, verify_agent_work invocations). Local-only — never uploaded.')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const { summariseSkillUsage } = await import('../../core/skill-usage-log.js');
    const summary = summariseSkillUsage();
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`Skill usage log: ${summary.log_path}`);
    console.log(`  total events: ${summary.total_events}`);
    console.log(`  log size:     ${summary.log_bytes} bytes`);
    if (summary.first_event) console.log(`  first event:  ${summary.first_event}`);
    if (summary.last_event) console.log(`  last event:   ${summary.last_event}`);
    if (summary.total_events === 0) {
      console.log('  (no events recorded yet — open a Claude Code session with memesh installed, or run a verification, to start collecting)');
      return;
    }
    console.log('  events by name:');
    for (const [name, count] of Object.entries(summary.events_by_name).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(6)}  ${name}`);
    }
  });

// --- status ---
program
  .command('status')
  .description('Show MeMesh status and capabilities')
  .option('--cached', 'Use cached update info only (skip fresh npm lookup)')
  .action(async (opts) => {
    const caps = detectCapabilities();
    const { getCurrentInstallChannel, getInstallChannelSupport } = await import('../../core/install-channel.js');
    const install = getCurrentInstallChannel({ packageRoot });
    const installSupport = getInstallChannelSupport(install);
    const { getUpdateCheck, formatUpdateCheckStatus } = await import('../../core/version-check.js');
    const update = await getUpdateCheck(pkg.version, { preferFresh: !opts.cached });

    console.log(`MeMesh v${pkg.version}`);
    console.log(`Search level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
    console.log(`Embeddings: ${caps.embeddings}`);
    console.log(`LLM: ${caps.llm ? `${caps.llm.provider} (${caps.llm.model})` : 'not configured'}`);
    console.log(`Install method: ${installSupport.label}`);

    for (const line of formatUpdateCheckStatus(update)) {
      console.log(`\n${line}`);
    }

    // Codex round 39: when a fresh lookup confirms `latestVersion ===
    // currentVersion` on a deprecated install, the status line above
    // already says "deprecated, no upgrade target yet". Appending
    // "Update path: memesh update" would contradict it — the command
    // is a no-op against the same already-installed version. Suppress
    // the trailer ONLY in that exact (fresh + confirmed-no-target)
    // case; everywhere else, keep the actionable hint.
    const confirmedNoUpgradeTarget = Boolean(
      update?.currentVersionDeprecated
      && update.latestVersion
      && update.latestVersion === update.currentVersion
      && update.freshness === 'fresh',
    );
    if (!confirmedNoUpgradeTarget) {
      if (installSupport.recommendedCommand) {
        console.log(`Update path: ${installSupport.recommendedCommand}`);
      } else {
        console.log(`Update path: ${installSupport.guidance}`);
      }
    }
  });

// Default action: open the live dashboard when run with no subcommand.
// DX: detect the unknown-subcommand case (`memesh nonexistent-cmd`) by
// inspecting program.args inside the root action and producing a clear
// error. We can't use Commander's `.argument()` here without leaking
// a confusing internal arg into `--help`, and `.command('*')` is
// deprecated in Commander 12+. Reading program.args is the documented
// escape hatch when no subcommand matched.
program.action(async () => {
  const stray = program.args.filter((a) => !a.startsWith('-'));
  if (stray.length > 0) {
    console.error(`Error: unknown command '${stray[0]}'.`);
    console.error(`       Run 'memesh --help' to see available commands.`);
    process.exit(1);
  }
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
