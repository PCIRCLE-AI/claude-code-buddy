#!/usr/bin/env node
import { Command } from 'commander';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn, reindex, setPinned } from '../../core/operations.js';
import { verifyAgentWork } from '../../core/verifier.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { readConfig, writeConfig, maskApiKey, detectCapabilities } from '../../core/config.js';
import { flushPendingEmbeddings } from '../../core/embedder.js';
async function withDatabase(fn) {
    openDatabase();
    try {
        return await fn();
    }
    finally {
        closeDatabase();
    }
}
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json');
const packageRoot = path.dirname(packageJsonPath);
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const program = new Command();
program
    .name('memesh')
    .description('MeMesh — Local memory for Claude Code and MCP coding agents')
    .version(pkg.version)
    .allowExcessArguments(true)
    .showSuggestionAfterError(true);
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
    if (text && !opts.name && !opts.type) {
        const slug = String(text)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
        const date = new Date().toISOString().slice(0, 10);
        const suffix = randomBytes(3).toString('hex');
        opts.name = `quick-${date}-${slug || 'note'}-${suffix}`;
        opts.type = 'note';
        if (!opts.obs || opts.obs.length === 0)
            opts.obs = [String(text)];
    }
    if (!opts.name || !opts.type) {
        console.error('Error: provide --name and --type, OR pass quick-capture text as a positional arg.\n' +
            '  memesh remember --name "auth" --type "decision" --obs "Use OAuth 2.0"\n' +
            '  memesh remember "Use OAuth 2.0 with PKCE"');
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
        }
        else {
            console.log(`✅ Stored "${result.name}" (${result.observations} observations, ${result.tags} tags)`);
        }
        await flushPendingEmbeddings();
    });
});
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
            }
            else {
                console.log(JSON.stringify(entities));
            }
        }
        else if (entities.length === 0) {
            console.log('No results found.');
        }
        else {
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
program
    .command('forget')
    .description('Archive an entity or remove an observation (soft-delete, recoverable)')
    .requiredOption('--name <name>', 'Entity name')
    .option('--observation <text>', 'Remove specific observation only')
    .option('--json', 'Output as JSON')
    .option('--confirm', '[deprecated, no-op] forget is a soft archive — no confirmation needed')
    .action(async (opts) => {
    await withDatabase(() => {
        const result = forget({
            name: opts.name,
            observation: opts.observation,
        });
        if (opts.json) {
            console.log(JSON.stringify(result));
        }
        else if (result.archived) {
            console.log(`📦 Archived "${opts.name}"`);
        }
        else if (result.observation_removed) {
            console.log(`✂️  Removed observation (${result.remaining_observations} remaining)`);
        }
        else {
            console.log(`Entity "${opts.name}" not found`);
        }
    });
});
program
    .command('pin')
    .description('Protect an entity from the dreamer’s auto-compaction')
    .requiredOption('--name <name>', 'Entity name')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
    await withDatabase(() => {
        const result = setPinned(opts.name, true);
        if (opts.json)
            console.log(JSON.stringify(result));
        else if (result.found)
            console.log(`📌 Pinned "${opts.name}" — the dreamer will not compact it`);
        else
            console.log(`Entity "${opts.name}" not found`);
    });
});
program
    .command('unpin')
    .description('Allow the dreamer to auto-compact an entity again')
    .requiredOption('--name <name>', 'Entity name')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
    await withDatabase(() => {
        const result = setPinned(opts.name, false);
        if (opts.json)
            console.log(JSON.stringify(result));
        else if (result.found)
            console.log(`📍 Unpinned "${opts.name}"`);
        else
            console.log(`Entity "${opts.name}" not found`);
    });
});
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
        }
        else if (result.error) {
            console.error(`Error: ${result.error}`);
            process.exitCode = 1;
        }
        else if (result.consolidated === 0) {
            if (opts.name) {
                console.log(`No entity named "${opts.name}" found, or it has fewer than ${opts.minObs} observations (the consolidation threshold).`);
                console.log(`Try: memesh recall "${opts.name}" to confirm it exists, or memesh consolidate --name "${opts.name}" --min-obs 1`);
            }
            else if (opts.tag) {
                console.log(`No entities tagged "${opts.tag}" met the minimum observation threshold (${opts.minObs}).`);
                console.log(`Try: memesh recall --tag "${opts.tag}" to see candidates, or lower --min-obs.`);
            }
            else {
                console.log(`No entities met the minimum observation threshold (${opts.minObs}).`);
                console.log(`Try: memesh consolidate --min-obs 1 to consolidate everything.`);
            }
        }
        else {
            console.log(`Consolidated ${result.consolidated} entity/entities.`);
            console.log(`Observations: ${result.observations_before} -> ${result.observations_after}`);
            if (result.entities_processed.length > 0) {
                console.log(`Processed: ${result.entities_processed.join(', ')}`);
            }
        }
    });
});
program
    .command('export')
    .description('Export memories as JSON. Defaults to stdout (pipe-friendly); use `-o <file>` to write directly.')
    .option('--tag <tag>', 'Export only entities with this tag')
    .option('--namespace <ns>', 'Export only from this namespace (personal, team, global)')
    .option('--limit <n>', 'Max entities to export', '1000')
    .option('-o, --out <file>', 'Write JSON to <file> instead of stdout. Parent directory must exist.')
    .action(async (opts) => {
    await withDatabase(() => {
        const result = exportMemories({
            tag: opts.tag,
            namespace: opts.namespace,
            limit: parseInt(opts.limit),
        });
        const json = JSON.stringify(result, null, 2);
        if (opts.out) {
            fs.writeFileSync(opts.out, json + '\n');
            process.stderr.write(`✅ Exported ${result.entity_count} entities to ${opts.out}\n`);
        }
        else {
            console.log(json);
        }
    });
});
program
    .command('import')
    .description('Import memories from a JSON export file')
    .argument('<file>', 'Path to JSON export file')
    .option('--namespace <ns>', 'Override namespace for all imported entities')
    .option('--merge <strategy>', 'Merge strategy: skip | overwrite | append', 'skip')
    .action(async (file, opts) => {
    await withDatabase(() => {
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        }
        catch (err) {
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
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch (err) {
            const lineMatch = /position (\d+)/.exec(err instanceof Error ? err.message : '');
            const where = lineMatch ? ` near position ${lineMatch[1]}` : '';
            console.error(`Error: ${file} is not valid JSON${where}.`);
            console.error(`       memesh import expects a file produced by 'memesh export'.`);
            console.error(`       Try: memesh export > my-export.json && memesh import my-export.json`);
            process.exit(1);
        }
        const result = importMemories({
            data: data,
            namespace: opts.namespace,
            merge_strategy: opts.merge,
        });
        console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}, Appended: ${result.appended}`);
        if (result.errors.length > 0) {
            console.error(`Errors:\n  ${result.errors.join('\n  ')}`);
            process.exitCode = 1;
        }
    });
});
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
            severity: opts.severity,
        });
        if (opts.json) {
            console.log(JSON.stringify(result));
        }
        else {
            console.log(`Lesson recorded: ${result.name}`);
        }
    });
});
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
        }
        else {
            const status = result.pass ? 'PASS' : 'FAIL';
            console.log(`${status}  agent=${opts.agentId}  entity=${result.entity_name}`);
            console.log(`  reality: ${result.reality_check.summary}`);
        }
        process.exit(result.pass ? 0 : 1);
    });
});
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
            const masked = maskApiKey(config.llm.apiKey);
            console.log(`  API key: ${masked}`);
        }
    }
    else {
        console.log('  LLM provider: not configured');
    }
    console.log(`\nSearch level: ${caps.searchLevel} (${caps.searchLevel === 1 ? 'Smart Mode' : 'Core'})`);
});
const SET_KEY_ALIASES = {
    'llm.api-key': 'llm.apiKey',
};
const ALLOWED_KEYS = new Set([
    'llm.provider',
    'llm.apiKey',
    'llm.model',
    'embedder.provider',
    'embedder.model',
    'autoUpdate',
    'theme',
    'sessionLimit',
    'enableAgenticOrchestration',
    'autoCapture',
    'llmFallbacks',
]);
const KEY_VALIDATORS = {
    'llm.provider': (v) => ['anthropic', 'openai', 'ollama'].includes(v) ? null : `must be one of: anthropic, openai, ollama`,
    'embedder.provider': (v) => ['onnx', 'openai', 'ollama'].includes(v) ? null : `must be one of: onnx, openai, ollama`,
    'autoUpdate': (v) => ['off', 'patch', 'minor', 'major'].includes(v) ? null : `must be one of: off, patch, minor, major`,
    'theme': (v) => ['light', 'dark'].includes(v) ? null : `must be one of: light, dark`,
    'llmFallbacks': (v) => {
        let parsed;
        try {
            parsed = JSON.parse(v);
        }
        catch {
            return 'must be a JSON array, e.g. \'[{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}]\'';
        }
        if (!Array.isArray(parsed))
            return 'must be a JSON ARRAY of provider objects';
        for (const entry of parsed) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                return 'every entry must be an object like {"provider":"openai"}';
            }
            const provider = entry.provider;
            if (!['anthropic', 'openai', 'ollama'].includes(String(provider))) {
                return `every entry needs provider = anthropic | openai | ollama (got ${JSON.stringify(provider)})`;
            }
        }
        return null;
    },
};
function setNested(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
        const part = path[i];
        if (typeof cur[part] !== 'object' || cur[part] === null) {
            cur[part] = {};
        }
        cur = cur[part];
    }
    cur[path[path.length - 1]] = value;
}
function deleteNested(obj, path) {
    if (path.length === 0)
        return false;
    if (path.length === 1) {
        if (path[0] in obj) {
            delete obj[path[0]];
            return true;
        }
        return false;
    }
    const head = path[0];
    if (typeof obj[head] !== 'object' || obj[head] === null)
        return false;
    const child = obj[head];
    const removed = deleteNested(child, path.slice(1));
    if (removed && Object.keys(child).length === 0)
        delete obj[head];
    return removed;
}
configCmd
    .command('set')
    .description('Set a config value (e.g. llm.provider, embedder.provider)')
    .argument('<key>', 'Config key — see `memesh config list` for valid keys')
    .argument('<value>', 'Config value')
    .action((key, value) => {
    const canonical = SET_KEY_ALIASES[key] ?? key;
    if (!ALLOWED_KEYS.has(canonical)) {
        console.error(`Unknown key: ${key}`);
        console.error(`Allowed keys: ${Array.from(ALLOWED_KEYS).sort().join(', ')}`);
        process.exit(1);
    }
    const validate = KEY_VALIDATORS[canonical];
    if (validate) {
        const err = validate(value);
        if (err) {
            console.error(`Invalid value for ${canonical}: ${err}`);
            process.exit(1);
        }
    }
    let coerced = value;
    if (canonical === 'sessionLimit')
        coerced = parseInt(value, 10);
    if (canonical === 'llmFallbacks')
        coerced = JSON.parse(value);
    if (canonical === 'enableAgenticOrchestration' || canonical === 'autoCapture') {
        coerced = value === 'true' || value === '1';
    }
    const config = readConfig();
    setNested(config, canonical.split('.'), coerced);
    writeConfig(config);
    const displayValue = canonical.toLowerCase().includes('key') ? maskApiKey(String(value)) : String(value);
    console.log(`✅ Set ${canonical} = ${displayValue}`);
});
configCmd
    .command('unset')
    .description('Remove a config value (supports nested keys like llm.apiKey)')
    .argument('<key>', 'Config key — see `memesh config list` for valid keys')
    .action((key) => {
    const canonical = SET_KEY_ALIASES[key] ?? key;
    if (!ALLOWED_KEYS.has(canonical)) {
        console.error(`Unknown key: ${key}`);
        console.error(`Allowed keys: ${Array.from(ALLOWED_KEYS).sort().join(', ')}`);
        process.exit(1);
    }
    const config = readConfig();
    const removed = deleteNested(config, canonical.split('.'));
    if (!removed) {
        console.log(`(no change — ${canonical} was not set)`);
        return;
    }
    writeConfig(config);
    console.log(`✅ Removed ${canonical}`);
});
program
    .command('export-schema')
    .description('Export MeMesh tools in OpenAI function calling format')
    .option('--format <format>', 'Output format (openai)', 'openai')
    .action(async (opts) => {
    const { exportOpenAITools } = await import('../../core/schema-export.js');
    if (opts.format === 'openai') {
        console.log(JSON.stringify(exportOpenAITools(), null, 2));
    }
    else {
        console.error(`Unknown format: ${opts.format}. Available: openai`);
        process.exit(1);
    }
});
program
    .command('demo')
    .description('Seed (or reset) a 30-entity onboarding tour')
    .option('--reset', 'Remove every entity tagged metadata.demo = true')
    .option('--yes', 'Skip confirmation prompt for --reset')
    .action(async (opts) => {
    await withDatabase(async () => {
        const { seedDemo } = await import('../../core/demo.js');
        const db = getDatabase();
        if (opts.reset) {
            if (!opts.yes) {
                console.error('memesh demo --reset is destructive. Re-run with --yes to confirm.');
                process.exit(1);
            }
            const result = seedDemo(db, { reset: true });
            console.log(`✓ Removed ${result.removed} demo entit${result.removed === 1 ? 'y' : 'ies'}.`);
            return;
        }
        const result = seedDemo(db);
        if (result.inserted === 0) {
            console.log('Demo data already present — re-run with --reset --yes first if you want to refresh.');
            return;
        }
        console.log(`✓ Seeded ${result.inserted} demo entit${result.inserted === 1 ? 'y' : 'ies'} tagged project:memesh-demo.`);
        console.log('  Open the dashboard (memesh serve) and tour Browse / Lessons / Graph / Analytics.');
        console.log('  Wipe with: memesh demo --reset --yes');
    });
});
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
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error(`❌ Update failed: ${message}`);
        console.error('   This command supports npm global installs.');
        console.error('   Try manually: npm install -g @pcircle/memesh@latest');
        process.exit(1);
    }
});
program
    .command('telemetry')
    .description('Show LLM call telemetry (per-flow scorecard for the last N days)')
    .option('--window <days>', 'Look-back window in days (default 30)', (v) => parseInt(v, 10), 30)
    .option('--prune <days>', 'Delete rows older than N days BEFORE rendering (closes v4.2.0 retention gap)', (v) => parseInt(v, 10))
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
    await withDatabase(async () => {
        const { summariseTelemetry, pruneTelemetry } = await import('../../core/llm-telemetry.js');
        let pruneResult = null;
        if (typeof opts.prune === 'number' && Number.isFinite(opts.prune) && opts.prune >= 0) {
            pruneResult = pruneTelemetry({ olderThanDays: opts.prune });
        }
        const summaries = summariseTelemetry(opts.window);
        if (opts.json) {
            console.log(JSON.stringify({ pruned: pruneResult, summaries }, null, 2));
            return;
        }
        if (pruneResult) {
            console.log(`Pruned ${pruneResult.deletedRows} row${pruneResult.deletedRows === 1 ? '' : 's'} older than ${opts.prune} days.`);
            console.log('');
        }
        if (summaries.length === 0) {
            console.log(`No LLM telemetry recorded in the last ${opts.window} days.`);
            console.log(`(Smart-Mode flows write rows automatically — run \`memesh dream run\`, \`memesh consolidate\`, or trigger a session with errors to populate.)`);
            return;
        }
        console.log(`LLM telemetry — last ${opts.window} days`);
        console.log('');
        for (const s of summaries) {
            const successRate = s.total_attempts > 0 ? Math.round((s.successes / s.total_attempts) * 100) : 0;
            console.log(`▸ ${s.flow}`);
            console.log(`    calls:        ${s.total_calls} (${s.total_attempts} provider attempts)`);
            console.log(`    success rate: ${successRate}%  (${s.successes} ok, ${s.failures} failed)`);
            if (s.fallback_used > 0) {
                console.log(`    fallback used: ${s.fallback_used} time${s.fallback_used === 1 ? '' : 's'}  ⚠️  primary failed`);
            }
            if (s.median_latency_ms != null) {
                console.log(`    median latency: ${s.median_latency_ms}ms`);
            }
            const okFail = (rec) => Object.entries(rec).map(([k, v]) => `${k}=${v.ok}/${v.ok + v.fail}`).join(', ');
            const providers = okFail(s.by_provider);
            if (providers)
                console.log(`    by provider:  ${providers}`);
            const models = okFail(s.by_model);
            if (models)
                console.log(`    by model:     ${models}`);
            const projects = okFail(s.by_project);
            if (projects)
                console.log(`    by project:   ${projects}`);
            const errors = Object.entries(s.by_error_class);
            if (errors.length > 0) {
                const errStr = errors.sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(', ');
                console.log(`    error classes: ${errStr}`);
            }
            if (s.sample_errors.length > 0) {
                console.log(`    recent errors:`);
                for (const e of s.sample_errors) {
                    console.log(`      • [${e.error_class ?? 'unknown'}] ${e.message.slice(0, 100)}`);
                }
            }
            console.log('');
        }
    });
});
const kgCmd = program
    .command('kg')
    .description('Knowledge graph maintenance');
kgCmd
    .command('backfill-relations')
    .description('Propose / apply heuristic relations to connect orphan entities (no LLM)')
    .option('--project <name>', 'Restrict to one project')
    .option('--dry-run', 'Show proposals without writing (default off — use to preview)')
    .option('--max-per-source <n>', 'Max edges per orphan (default 3)', (v) => parseInt(v, 10), 3)
    .option('--min-shared-tags <n>', 'Min shared topical tags to gate co-occurrence rule (default 2)', (v) => parseInt(v, 10), 2)
    .option('--include-archived', 'Also process archived entities')
    .option('--session-cooccurrence', 'Rule 3: link high-signal orphans co-created in the same session')
    .option('--name-tokens', 'Rule 4: link orphans sharing ≥3 name content tokens (or Jaccard ≥ 0.50)')
    .option('--min-jaccard <n>', 'Jaccard threshold for name similarity (default 0.50)', parseFloat)
    .option('--all-rules', 'Enable all heuristic rules (Rules 1–4)')
    .option('--reset-idempotency', 'Clear the persistent "already-attempted" orphan cache before running (use after schema changes or to reconsider every orphan)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
    await withDatabase(async () => {
        const { backfillRelations, proposeBackfillCandidates } = await import('../../core/kg-backfill.js');
        const allRules = !!opts.allRules;
        const baseOpts = {
            project: opts.project,
            maxEdgesPerSource: opts.maxPerSource,
            minSharedTags: opts.minSharedTags,
            includeArchived: !!opts.includeArchived,
            dryRun: !!opts.dryRun,
            includeSessionCooccurrence: allRules || !!opts.sessionCooccurrence,
            includeNameTokenSimilarity: allRules || !!opts.nameTokens,
            minNameJaccard: opts.minJaccard,
            resetIdempotency: !!opts.resetIdempotency,
        };
        if (opts.dryRun) {
            const { candidates, skippedOrphanIds } = proposeBackfillCandidates(baseOpts);
            if (opts.json) {
                console.log(JSON.stringify({ candidates, skippedOrphanIds }, null, 2));
                return;
            }
            console.log(`Proposed ${candidates.length} relation${candidates.length === 1 ? '' : 's'} (dry-run, nothing written).`);
            const sample = candidates.slice(0, 20);
            for (const c of sample) {
                console.log(`  ${c.fromName}  --[${c.relationType}]-->  ${c.toName}   (${c.reason})`);
            }
            if (candidates.length > sample.length) {
                console.log(`  … ${candidates.length - sample.length} more (use --json to see them all)`);
            }
            const byRule = new Map();
            for (const c of candidates)
                byRule.set(c.relationType, (byRule.get(c.relationType) ?? 0) + 1);
            console.log('');
            for (const [rule, n] of byRule)
                console.log(`  ${rule}: ${n}`);
            if (skippedOrphanIds.length > 0) {
                console.log('');
                console.log(`  idempotency: ${skippedOrphanIds.length} orphan${skippedOrphanIds.length === 1 ? '' : 's'} skipped (already attempted in a prior run; use --reset-idempotency to reconsider).`);
            }
            return;
        }
        const result = backfillRelations(baseOpts);
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        console.log(`Proposed ${result.candidatesProposed} relations, wrote ${result.edgesWritten} new edges.`);
        console.log(`  tag co-occurrence: ${result.byRule.tagCooccurrence}`);
        console.log(`  project clustering: ${result.byRule.projectClustering}`);
        console.log(`  session co-occurrence: ${result.byRule.sessionCooccurrence}`);
        console.log(`  name token similarity: ${result.byRule.nameTokenSimilarity}`);
        if (result.candidatesProposed > result.edgesWritten) {
            console.log(`  (${result.candidatesProposed - result.edgesWritten} candidates were already-existing edges; INSERT OR IGNORE skipped them.)`);
        }
        if (result.orphansSkippedIdempotent > 0) {
            console.log(`  idempotency: skipped ${result.orphansSkippedIdempotent} orphan${result.orphansSkippedIdempotent === 1 ? '' : 's'} already attempted in a prior run (use --reset-idempotency to reconsider them).`);
        }
        if (result.orphansMarkedProcessed > 0) {
            console.log(`  idempotency: marked ${result.orphansMarkedProcessed} new orphan${result.orphansMarkedProcessed === 1 ? '' : 's'} as attempted.`);
        }
    });
});
program
    .command('doctor')
    .description('Verify local install health and show actionable fixes')
    .option('--json', 'Output machine-readable diagnostics as JSON')
    .option('--probe-http', 'Also probe the local HTTP server health endpoint')
    .option('--probe', 'Make one small live call to the configured LLM to confirm it actually answers')
    .option('--url <url>', 'Base URL for --probe-http', 'http://127.0.0.1:3737')
    .action(async (opts) => {
    const { formatDoctorReport, runDoctor } = await import('../../core/doctor.js');
    const result = await runDoctor({
        packageRoot,
        packageVersion: pkg.version,
        probeHttp: opts.probeHttp,
        probeCapabilities: opts.probe,
        httpBaseUrl: opts.url,
    });
    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        for (const line of formatDoctorReport(result, pkg.version)) {
            console.log(line);
        }
        if (result.status !== 'PASS') {
            console.log('');
            console.log('Need help? Run `memesh feedback` to file a GitHub issue with the diagnostics pre-attached.');
        }
    }
    if (result.status === 'FAIL') {
        process.exitCode = 1;
    }
});
const dreamCmd = program.command('dream').description('Consolidate noisy episodic memories into digests (LLM-driven, opt-in review)');
dreamCmd
    .command('run', { isDefault: true })
    .description('Run a dream pass — propose digests for clusters of compactable entities')
    .option('--project <name>', 'Restrict to one project')
    .option('--dry-run', 'Compute proposals without writing to dream_proposals')
    .option('--max-llm-calls <n>', 'Hard cap on LLM calls (default 100)', (v) => parseInt(v, 10))
    .option('--window-days <n>', 'Look-back window in days (default 56 = 8 weeks)', (v) => parseInt(v, 10))
    .option('--validate', 'Run a second LLM pass to cross-check each digest against its sources (doubles LLM calls per proposal; surfaces under flow=digest_validator in `memesh telemetry`)')
    .action(async (opts) => {
    await withDatabase(async () => {
        const { runDreamer } = await import('../../core/dreamer.js');
        const { readConfig } = await import('../../core/config.js');
        const { getDatabase } = await import('../../db.js');
        const cfg = readConfig();
        if (!cfg.llm) {
            console.error('No LLM configured. Run `memesh config set llm.provider <anthropic|openai|ollama>` first.');
            console.error('LLM is required for `memesh dream` because consolidation is a semantic decision, not a rule.');
            process.exit(1);
        }
        const result = await runDreamer(getDatabase(), cfg.llm, {
            project: opts.project,
            dryRun: !!opts.dryRun,
            maxLlmCalls: opts.maxLlmCalls,
            windowDays: opts.windowDays,
            fallbacks: cfg.llmFallbacks,
            validateBeforeStage: !!opts.validate,
        });
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}Dream pass complete in ${result.durationMs}ms`);
        console.log(`  clusters scanned: ${result.clustersScanned}`);
        console.log(`  LLM calls:        ${result.llmCalls}`);
        console.log(`  proposals created: ${result.proposalsCreated}`);
        if (result.skipped.length > 0) {
            console.log(`  skipped:           ${result.skipped.length}`);
            const reasonCounts = new Map();
            for (const s of result.skipped) {
                reasonCounts.set(s.reason, (reasonCounts.get(s.reason) ?? 0) + 1);
            }
            for (const [reason, n] of reasonCounts) {
                console.log(`    - ${reason}${n > 1 ? ` (×${n})` : ''}`);
            }
        }
        if (!opts.dryRun && result.proposalsCreated > 0) {
            console.log('');
            console.log(`Review with: memesh dream list`);
            console.log(`Accept all:  memesh dream accept --all`);
        }
    });
});
dreamCmd
    .command('patterns')
    .description('Run pattern detector — surface emerging patterns/conventions/repeated mistakes per project (Phase 3)')
    .option('--project <name>', 'Restrict to one project (default: all projects)')
    .option('--dry-run', 'Compute proposals without writing to dream_proposals')
    .option('--max-llm-calls <n>', 'Hard cap on LLM calls (default 10)', (v) => parseInt(v, 10))
    .option('--window-days <n>', 'Look-back window in days (default 30)', (v) => parseInt(v, 10))
    .option('--min-signal <n>', 'Minimum signal_score to include in scan (default 0.3)', (v) => parseFloat(v))
    .action(async (opts) => {
    await withDatabase(async () => {
        const { runPatternDetector } = await import('../../core/dreamer.js');
        const { readConfig } = await import('../../core/config.js');
        const { getDatabase } = await import('../../db.js');
        const cfg = readConfig();
        if (!cfg.llm) {
            console.error('No LLM configured. Pattern detection requires an LLM.');
            process.exit(1);
        }
        const result = await runPatternDetector(getDatabase(), cfg.llm, {
            project: opts.project,
            dryRun: !!opts.dryRun,
            maxLlmCalls: opts.maxLlmCalls,
            windowDays: opts.windowDays,
            minSignal: opts.minSignal,
            fallbacks: cfg.llmFallbacks,
        });
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}Pattern detector complete in ${result.durationMs}ms`);
        console.log(`  entities scanned: ${result.entitiesScanned}`);
        console.log(`  LLM calls:        ${result.llmCalls}`);
        console.log(`  patterns proposed: ${result.proposalsCreated}`);
        if (result.skipped.length > 0) {
            console.log(`  skipped:           ${result.skipped.length}`);
            for (const s of result.skipped.slice(0, 5)) {
                console.log(`    - ${s.project ?? '?'}: ${s.reason}`);
            }
        }
        if (!opts.dryRun && result.proposalsCreated > 0) {
            console.log('');
            console.log(`Review with: memesh dream list`);
        }
    });
});
dreamCmd
    .command('list')
    .description('List dream proposals (pending by default)')
    .option('--status <s>', 'Filter by status: pending | applied | rejected', 'pending')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
    await withDatabase(async () => {
        const { listProposals } = await import('../../core/dreamer.js');
        const { getDatabase } = await import('../../db.js');
        const proposals = listProposals(getDatabase(), opts.status);
        if (opts.json) {
            console.log(JSON.stringify(proposals, null, 2));
            return;
        }
        if (proposals.length === 0) {
            console.log(`No ${opts.status} dream proposals.`);
            return;
        }
        console.log(`${proposals.length} ${opts.status} proposal(s):`);
        console.log('');
        for (const p of proposals) {
            console.log(`  #${p.id}  [${p.project}/${p.cluster_key}]  ${p.source_count} sources → "${p.digest_name}"`);
            console.log(`         ${p.digest_observations_preview}`);
            console.log(`         created: ${p.created_at}`);
            console.log('');
        }
        console.log(`Apply: memesh dream accept <id>   |   Reject: memesh dream reject <id>`);
    });
});
dreamCmd
    .command('accept <id>')
    .description('Accept a pending proposal — creates digest entity, soft-archives sources')
    .action(async (id) => {
    await withDatabase(async () => {
        const { applyProposal } = await import('../../core/dreamer.js');
        const { getDatabase } = await import('../../db.js');
        const { KnowledgeGraph } = await import('../../knowledge-graph.js');
        const kg = new KnowledgeGraph(getDatabase());
        const result = applyProposal(getDatabase(), parseInt(id, 10), kg);
        console.log(`Applied proposal #${result.proposalId}`);
        console.log(`  digest entity: ${result.digestEntityName}`);
        console.log(`  sources archived: ${result.sourcesArchived}`);
    });
});
dreamCmd
    .command('reject <id>')
    .description('Reject a pending proposal — sources untouched, proposal marked rejected')
    .option('--reason <text>', 'Reason for rejection (saved for audit)')
    .action(async (id, opts) => {
    await withDatabase(async () => {
        const { rejectProposal } = await import('../../core/dreamer.js');
        const { getDatabase } = await import('../../db.js');
        rejectProposal(getDatabase(), parseInt(id, 10), opts.reason);
        console.log(`Rejected proposal #${id}`);
    });
});
program
    .command('install-hooks')
    .description('Wire memesh\'s session hooks into Claude Code (~/.claude/settings.json)')
    .option('--scope <scope>', 'user (default) or project — project writes to ./.claude/settings.json', 'user')
    .option('--dry-run', 'Show what would change without modifying any file')
    .option('--force-over-plugin', 'Write user-level hooks even when Claude Code\'s plugin runtime already wires them. Causes double-firing — only use if you genuinely want both surfaces.')
    .action(async (opts) => {
    const { installHooks } = await import('../../core/install-hooks.js');
    const scope = opts.scope === 'project' ? 'project' : 'user';
    try {
        const result = installHooks({
            pluginRoot: packageRoot,
            pluginVersion: pkg.version,
            scope,
            dryRun: !!opts.dryRun,
            forceOverPlugin: !!opts.forceOverPlugin,
        });
        if (result.pluginRuntimeDetected) {
            console.log('memesh is already wired via the Claude Code plugin runtime — skipping install-hooks to avoid double-firing.');
            console.log(`  Plugin install: ${result.pluginRuntimeDetected.installPath} (v${result.pluginRuntimeDetected.version})`);
            console.log('');
            console.log('Hooks are active. Verify with: memesh doctor');
            console.log('');
            console.log('If you really want a second copy in ~/.claude/settings.json on top of the plugin, re-run with --force-over-plugin. (Not recommended — every session-start / Stop / PreToolUse event will fire memesh\'s hooks twice.)');
            return;
        }
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}Settings: ${result.settingsPath}`);
        console.log(`${opts.dryRun ? '[dry-run] Would add ' : 'Added '}${result.added} hook entr${result.added === 1 ? 'y' : 'ies'}, ${opts.dryRun ? 'would skip ' : 'skipped '}${result.skipped} already-installed.`);
        if (result.backupPath)
            console.log(`Backup: ${result.backupPath}`);
        if (result.conflicts.length > 0) {
            console.log('');
            console.log('Note: memesh hooks now coexist with the following pre-existing entries:');
            for (const c of result.conflicts) {
                console.log(`  - ${c.event} (matcher: ${c.matcher}) — ${c.existingCount} non-memesh hook command${c.existingCount === 1 ? '' : 's'} preserved`);
            }
        }
        if (!opts.dryRun) {
            console.log('');
            console.log('Restart Claude Code (or open a new session) for hooks to take effect.');
            console.log('Verify with: memesh doctor');
        }
    }
    catch (err) {
        console.error(`install-hooks failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
});
program
    .command('uninstall-hooks')
    .description('Remove memesh\'s session hooks from Claude Code settings')
    .option('--scope <scope>', 'user (default) or project', 'user')
    .option('--dry-run', 'Show what would change without modifying any file')
    .action(async (opts) => {
    const { uninstallHooks } = await import('../../core/install-hooks.js');
    const scope = opts.scope === 'project' ? 'project' : 'user';
    try {
        const result = uninstallHooks({ scope, dryRun: !!opts.dryRun });
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}Settings: ${result.settingsPath}`);
        console.log(`${opts.dryRun ? '[dry-run] ' : ''}Removed ${result.removed} memesh hook command${result.removed === 1 ? '' : 's'}.`);
        if (result.backupPath)
            console.log(`Backup: ${result.backupPath}`);
    }
    catch (err) {
        console.error(`uninstall-hooks failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
});
program
    .command('feedback')
    .description('Open a pre-filled GitHub issue (bug / feature / question) with optional diagnostics')
    .option('--bug', 'File a bug report (default if no type flag)')
    .option('--feature', 'File a feature request')
    .option('--question', 'Ask a question')
    .option('--no-diagnostics', 'Skip including doctor output and install_id')
    .option('--no-open', 'Print the URL instead of opening a browser (CI / headless)')
    .option('-m, --message <text>', 'Pre-fill the description (otherwise prompt is omitted)')
    .action(async (opts) => {
    const { runDoctor } = await import('../../core/doctor.js');
    const { getInstallId } = await import('../../core/install-id.js');
    const fbType = opts.feature ? 'feature' : opts.question ? 'question' : 'bug';
    const typeLabel = fbType.charAt(0).toUpperCase() + fbType.slice(1);
    const labels = `feedback,from-cli,${fbType}`;
    let body = (opts.message ?? '').trim() || `<!-- Describe the ${fbType} here -->`;
    if (opts.diagnostics !== false) {
        try {
            const result = await runDoctor({ packageRoot, packageVersion: pkg.version });
            const installCheck = result.checks.find(c => c.id === 'install_id');
            const installLine = installCheck
                ? `\n_Anonymous install ID: \`${(installCheck.summary.match(/[0-9a-f-]{36}/) ?? [getInstallId()])[0]}\` — included only because --diagnostics is on (default)._\n`
                : '';
            const otherChecks = result.checks
                .filter(c => c.id !== 'install_id')
                .sort((a, b) => {
                const order = { fail: 0, warn: 1, pass: 2 };
                return (order[a.status] ?? 3) - (order[b.status] ?? 3);
            });
            const lines = otherChecks.map(c => {
                const icon = c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅';
                const fix = c.fix ? ` _Fix: ${c.fix}_` : '';
                return `- ${icon} **${c.label}**: ${c.summary}${fix}`;
            });
            body += `\n\n---\n**System Info**\n- Version: \`${pkg.version}\`\n- Node: \`${process.version}\`\n- Platform: \`${process.platform} ${process.arch}\`\n\n**Diagnostics** (overall: ${result.status})${installLine}\n${lines.join('\n')}`;
        }
        catch {
            body += `\n\n---\n**System Info**\n- Version: \`${pkg.version}\`\n- Node: \`${process.version}\`\n- Platform: \`${process.platform} ${process.arch}\`\n_Diagnostics unavailable: doctor probe failed._`;
        }
    }
    const url = `https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=${encodeURIComponent(`[${typeLabel}] `)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;
    if (opts.open === false) {
        console.log(url);
        return;
    }
    const { spawn } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd'
            : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.unref();
        console.log(`Opened browser to file ${fbType} issue.`);
        console.log('Edit the title + body before submitting.');
    }
    catch {
        console.log('Could not open browser. URL:');
        console.log(url);
    }
});
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
            }
            else {
                console.log(`✅ Reindex complete:`);
                console.log(`   Processed: ${result.processed}`);
                console.log(`   Embedded:  ${result.embedded}`);
                console.log(`   Skipped:   ${result.skipped}`);
            }
        });
    }
    catch (err) {
        if (err instanceof Error) {
            console.error(`❌ Reindex failed: ${err.message}`);
            process.exit(1);
        }
        throw err;
    }
});
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
    if (summary.first_event)
        console.log(`  first event:  ${summary.first_event}`);
    if (summary.last_event)
        console.log(`  last event:   ${summary.last_event}`);
    if (summary.total_events === 0) {
        console.log('  (no events recorded yet — open a Claude Code session with memesh installed, or run a verification, to start collecting)');
        return;
    }
    console.log('  events by name:');
    for (const [name, count] of Object.entries(summary.events_by_name).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${count.toString().padStart(6)}  ${name}`);
    }
});
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
    const confirmedNoUpgradeTarget = Boolean(update?.currentVersionDeprecated
        && update.latestVersion
        && update.latestVersion === update.currentVersion
        && update.freshness === 'fresh');
    if (!confirmedNoUpgradeTarget) {
        if (installSupport.recommendedCommand) {
            console.log(`Update path: ${installSupport.recommendedCommand}`);
        }
        else {
            console.log(`Update path: ${installSupport.guidance}`);
        }
    }
});
program.action(async () => {
    const stray = program.args.filter((a) => !a.startsWith('-'));
    if (stray.length > 0) {
        console.error(`Error: unknown command '${stray[0]}'.`);
        console.error(`       Run 'memesh --help' to see available commands.`);
        process.exit(1);
    }
    const { startServer } = await import('../http/server.js');
    const server = startServer('127.0.0.1', 0);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const addr = server.address();
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
    }
    else if (process.platform === 'win32') {
        execFile('cmd.exe', ['/c', 'start', '', url]);
    }
    else {
        execFile('xdg-open', [url]);
    }
    process.on('SIGINT', () => {
        server.close();
        try {
            closeDatabase();
        }
        catch { }
        process.exit(0);
    });
});
program.parse();
//# sourceMappingURL=cli.js.map