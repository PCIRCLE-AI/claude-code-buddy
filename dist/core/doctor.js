import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'node:net';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { detectCapabilities, getConfigPath, isTranscriptMiningEnabled, readConfig } from './config.js';
import { embedText } from './embedder.js';
import { probeProvider } from './llm-validator.js';
import { openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen, readVectorGeneration, generationRowIds, } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { classifyBump } from './updater.js';
import { getCurrentInstallChannel, getInstallChannelSupport, detectPluginHost, pluginHostConfigRoot, versionedPluginCacheRoots, PLUGIN_REFRESH_COMMANDS, } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { citationRulePath, citationRuleState } from './citation-rule.js';
import { getDbPath, getMemeshDirFromDbPath, homeDir, memeshDir, getProjectName } from './paths.js';
import { detectPluginRuntime, readInstallMarker } from './install-hooks.js';
import { lastTranscriptMineAt } from './transcript-source.js';
import { countMissingVectors } from './operations.js';
import { hasVectorIndex } from '../storage/vector-index.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';
import { MemeshDatabase } from '../storage/sqlite.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { autoCaptureDecision } from './capture-flag.js';
import { guardFromMetadata } from './guards.js';
import { getAgentMessageStorageReport } from './agent-message-storage.js';
import { readHostConfigFile } from '../host-runtime/config.js';
const EMBEDDING_PROBE_TIMEOUT_MS = 15000;
const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];
const AGENT_MESSAGE_STORAGE_QUOTA_ENV = 'MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES';
const LOCALE_README_FILES = [
    'README.de.md',
    'README.zh-TW.md',
];
const LOCALE_H2_TOLERANCE = 1;
function countH2Headings(content) {
    let n = 0;
    let inFence = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (line.startsWith('## '))
            n++;
    }
    return n;
}
function inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const englishPath = path.join(packageRoot, 'README.md');
    if (!existsSyncImpl(englishPath)) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', 'README.md not present in this install (likely a packaged tarball without docs); locale-parity check skipped.');
    }
    let englishCount;
    try {
        englishCount = countH2Headings(readFileSyncImpl(englishPath, 'utf8'));
    }
    catch (err) {
        return createCheck('readme_locale_parity', 'README locale parity', 'warn', `Could not read README.md: ${err instanceof Error ? err.message : String(err)}`, undefined, { code: 'readme-parity.unreadable', params: { detail: err instanceof Error ? err.message : String(err) } });
    }
    const missing = [];
    const drift = [];
    let anyLocalePresent = false;
    for (const filename of LOCALE_README_FILES) {
        const localePath = path.join(packageRoot, filename);
        if (!existsSyncImpl(localePath)) {
            missing.push(filename);
            continue;
        }
        anyLocalePresent = true;
        try {
            const count = countH2Headings(readFileSyncImpl(localePath, 'utf8'));
            if (Math.abs(count - englishCount) > LOCALE_H2_TOLERANCE) {
                drift.push({ name: filename, count });
            }
        }
        catch {
            drift.push({ name: filename, count: -1 });
        }
    }
    if (!anyLocalePresent) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', 'Locale READMEs not present in this install (packaged installs ship README.md only); locale-parity check skipped.');
    }
    if (missing.length === 0 && drift.length === 0) {
        return createCheck('readme_locale_parity', 'README locale parity', 'pass', `All ${LOCALE_README_FILES.length} locale READMEs match English H2 count (${englishCount}).`);
    }
    const parts = [];
    if (missing.length > 0) {
        parts.push(`missing: ${missing.join(', ')}`);
    }
    if (drift.length > 0) {
        const driftDetail = drift
            .map((d) => `${d.name}=${d.count === -1 ? 'unreadable' : d.count}`)
            .join(', ');
        parts.push(`H2 count drift (English=${englishCount}): ${driftDetail}`);
    }
    return createCheck('readme_locale_parity', 'README locale parity', 'warn', parts.join('; '), `Re-sync the listed READMEs against README.md so section structure matches (±${LOCALE_H2_TOLERANCE} H2 tolerated to absorb translation collapse).`, { code: 'readme-parity.drift', params: { detail: parts.join('; '), tolerance: LOCALE_H2_TOLERANCE } });
}
function resolveDatabasePath() {
    return getDbPath();
}
function createCheck(id, label, status, summary, fix, i18n, fixId) {
    return { id, label, status, summary, fix, code: i18n?.code, params: i18n?.params, fixId };
}
function createInfo(id, label, summary, fix) {
    return { id, label, status: 'pass', summary, fix, informational: true };
}
function inspectAgentMessageStorage(db, databasePath, policy) {
    try {
        const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'").get();
        if (!present?.present)
            return undefined;
        const cutoff = policy?.retention_cutoff ?? new Date(0);
        const report = getAgentMessageStorageReport(db, { cutoff, databasePath });
        const quota = policy?.storage_quota_bytes;
        const invalidQuota = quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0);
        const quotaText = quota === undefined
            ? 'quota not configured'
            : !invalidQuota
                ? `quota ${formatStorageBytes(quota)} (${formatStorageBytes(report.payload_bytes)} logical payload used)`
                : 'configured quota is invalid';
        const retentionText = policy?.retention_cutoff === undefined
            ? 'retention policy not configured; terminal-prunable payload was not evaluated'
            : `retention cutoff ${String(policy.retention_cutoff)}; ${report.terminal_prunable_message_count} terminal message(s) `
                + `(${formatStorageBytes(report.terminal_prunable_payload_bytes)}) are prunable by that owner policy`;
        const walText = report.wal_file_bytes === null
            ? 'WAL size unavailable'
            : `WAL ${formatStorageBytes(report.wal_file_bytes)}`;
        const databaseText = report.database_file_bytes === null
            ? 'database file size unavailable'
            : `database file ${formatStorageBytes(report.database_file_bytes)}`;
        const summary = `${report.message_count} message(s), ${formatStorageBytes(report.payload_bytes)} logical payload `
            + `(${report.protected_unresolved_message_count} unresolved/protected); ${formatStorageBytes(report.reusable_freelist_bytes)} `
            + `SQLite freelist reusable; ${databaseText}; ${walText}; ${quotaText}; ${retentionText}. `
            + 'Doctor only read this state: it did not prune payloads, checkpoint WAL, or run VACUUM.';
        if (invalidQuota) {
            return createCheck('agent_message_storage', 'Agent message storage', 'warn', `${summary} Send enforcement rejects this quota configuration; use a canonical non-negative safe decimal integer.`, `Set ${AGENT_MESSAGE_STORAGE_QUOTA_ENV} to 0 or a positive decimal integer within the safe integer range, then re-run memesh doctor.`);
        }
        return createInfo('agent_message_storage', 'Agent message storage', summary);
    }
    catch {
        return undefined;
    }
}
function inspectCodexSessionSetup(codexPluginCacheDetected, existsSyncImpl) {
    if (!codexPluginCacheDetected)
        return null;
    const configPath = path.join(getMemeshDirFromDbPath(), 'hosts', 'codex-session.json');
    if (existsSyncImpl(configPath)) {
        return createCheck('codex-session-setup', 'Codex ordinary-session notification setup', 'pass', 'A Codex plugin cache copy was detected, but this proves only that cached source exists, not that the plugin is enabled or registered. The explicit opt-in ordinary-session notification setup is present; durable inbox remains available, and MeMesh will not auto-attach.');
    }
    return createCheck('codex-session-setup', 'Codex ordinary-session notification setup', 'warn', 'A Codex plugin cache copy was detected, but this proves only that cached source exists, not that the plugin is enabled or registered. Durable inbox remains available, but live ordinary-session wakeup is inactive. Setup is explicit opt-in; MeMesh will not auto-attach.', 'Run `memesh agent setup codex-session --project <project> --principal <principal> --workspace <exact-workspace>`, then restart Codex.', { code: 'codex-session.config-missing' });
}
function configuredAgentMessageStoragePolicy(explicit) {
    if (explicit !== undefined)
        return explicit;
    const quotaRaw = process.env[AGENT_MESSAGE_STORAGE_QUOTA_ENV];
    if (quotaRaw === undefined || quotaRaw === '')
        return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(quotaRaw)) {
        return { storage_quota_bytes: Number.NaN };
    }
    const parsed = Number(quotaRaw);
    return { storage_quota_bytes: Number.isSafeInteger(parsed) ? parsed : Number.NaN };
}
function formatStorageBytes(value) {
    if (!Number.isFinite(value) || value < 0)
        return 'unknown size';
    if (value < 1024)
        return `${value} B`;
    if (value < 1024 * 1024)
        return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
function parseJsonFile(filePath, readFileSyncImpl) {
    try {
        const raw = readFileSyncImpl(filePath, 'utf8');
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') {
            return { ok: false, error: 'JSON root must be an object.' };
        }
        return { ok: true, value: value };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : 'unknown parse error',
        };
    }
}
function inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl, envLlm) {
    const configPath = getConfigPathImpl();
    if (!existsSyncImpl(configPath)) {
        return createCheck('config', 'Config', 'pass', envLlm
            ? `No config file yet (${configPath}), but your environment names ${envLlm.provider}${envLlm.apiKey ? ' (via its API key)' : ' (via OLLAMA_HOST)'}, which enables Smart Mode. A file is only needed to pin a provider or change defaults.`
            : `No config file yet (${configPath}). MeMesh will run in Core mode until you configure Smart Mode.`, envLlm
            ? `Optional: \`memesh config set llm.provider ${envLlm.provider}\` pins it so it does not depend on which shell you run from.`
            : 'Optional: run `memesh config list` or set an LLM with `memesh config set llm.provider anthropic`.');
    }
    try {
        const raw = readFileSyncImpl(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return createCheck('config', 'Config', 'fail', `${configPath} parsed but is not a JSON object — every setting is being ignored.`, `Fix or remove ${configPath}, then re-run memesh doctor.`, { code: 'config-parse.not-object', params: { path: configPath } });
        }
        return createCheck('config', 'Config', 'pass', `${configPath} is valid JSON and its settings are in effect.`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('config', 'Config', 'fail', `${configPath} could not be read or parsed (${msg}). Every setting in it — LLM provider, fallbacks, embedder — is being silently ignored right now.`, `Fix the JSON or remove the file to fall back to defaults: mv ${configPath} ${configPath}.bak`, { code: 'config-parse.unreadable', params: { path: configPath, detail: msg } });
    }
}
function inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const mcpPath = path.join(packageRoot, '.mcp.json');
    if (!existsSyncImpl(mcpPath)) {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json is missing.', 'Restore `.mcp.json` from the package or reinstall MeMesh.', { code: 'mcp-config.missing' });
    }
    const parsed = parseJsonFile(mcpPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json is not valid JSON.', `Fix ${mcpPath} so Claude Code can read the MCP server definition.`, { code: 'mcp-config.invalid-json', params: { path: mcpPath } });
    }
    const server = parsed.value.mcpServers?.memesh;
    if (!server || typeof server.command !== 'string') {
        return createCheck('mcp-config', 'MCP config', 'fail', '.mcp.json does not define a usable `memesh` MCP server entry.', 'Reinstall MeMesh or restore the `mcpServers.memesh` entry in `.mcp.json`.', { code: 'mcp-config.no-entry' });
    }
    const args = Array.isArray(server.args) ? server.args : [];
    const entry = typeof args[0] === 'string' ? args[0] : null;
    if (entry) {
        const resolved = path.resolve(entry.replaceAll('${CLAUDE_PLUGIN_ROOT}', packageRoot));
        if (!existsSyncImpl(resolved)) {
            return createCheck('mcp-config', 'MCP config', 'fail', `.mcp.json starts \`${entry}\`, and that file is not in this install — so every memesh MCP tool fails to start.`, 'Reinstall MeMesh; if you edited `.mcp.json` by hand, point it back at `${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js`.', { code: 'mcp-config.entry-missing', params: { entry, resolved } });
        }
    }
    return createCheck('mcp-config', 'MCP config', 'pass', '.mcp.json is present, defines the memesh MCP server, and the script it starts exists.');
}
function extractHookScriptPaths(hooksConfig, packageRoot) {
    const hooks = hooksConfig.hooks;
    if (!hooks)
        return [];
    const scripts = new Set();
    for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries))
            continue;
        for (const entry of entries) {
            if (!Array.isArray(entry.hooks))
                continue;
            for (const hook of entry.hooks) {
                if (typeof hook.command !== 'string')
                    continue;
                const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '');
                scripts.add(path.join(packageRoot, command));
            }
        }
    }
    return Array.from(scripts).sort();
}
function inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl) {
    const hooksPath = path.join(packageRoot, 'hooks', 'hooks.json');
    if (!existsSyncImpl(hooksPath)) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is missing.', 'Restore `hooks/hooks.json` from the package or reinstall MeMesh.', { code: 'hooks-config.missing' }),
        ];
    }
    const parsed = parseJsonFile(hooksPath, readFileSyncImpl);
    if (!parsed.ok) {
        return [
            createCheck('hooks-config', 'Hooks config', 'fail', 'hooks/hooks.json is not valid JSON.', `Fix ${hooksPath} so Claude Code can load the hook definitions.`, { code: 'hooks-config.invalid-json', params: { path: hooksPath } }),
        ];
    }
    const parsedHooks = parsed.value.hooks;
    const hookTypes = parsedHooks && typeof parsedHooks === 'object' && !Array.isArray(parsedHooks)
        ? Object.keys(parsedHooks)
        : [];
    const missingTypes = EXPECTED_HOOK_TYPES.filter((type) => !hookTypes.includes(type));
    const configCheck = missingTypes.length > 0
        ? createCheck('hooks-config', 'Hooks config', 'fail', `hooks/hooks.json is missing expected hook types: ${missingTypes.join(', ')}.`, 'Restore the shipped hook configuration or reinstall MeMesh.', { code: 'hooks-config.missing-types', params: { types: missingTypes.join(', ') } })
        : createCheck('hooks-config', 'Hooks config', 'pass', `hooks/hooks.json is present with ${hookTypes.length} hook types configured.`);
    const scriptPaths = extractHookScriptPaths(parsed.value, packageRoot);
    if (scriptPaths.length === 0) {
        return [
            configCheck,
            createCheck('hook-scripts', 'Hook scripts', 'fail', 'hooks/hooks.json parsed, but yields zero hook script commands — hooks can never fire.', 'Restore the shipped hook configuration or reinstall MeMesh.', { code: 'hook-scripts.none' }),
        ];
    }
    const missingScripts = scriptPaths.filter((scriptPath) => !existsSyncImpl(scriptPath));
    if (missingScripts.length > 0) {
        return [
            configCheck,
            createCheck('hook-scripts', 'Hook scripts', 'fail', `Missing hook scripts: ${missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Restore the missing files from the package or reinstall MeMesh.', { code: 'hook-scripts.missing', params: { files: missingScripts.map((entry) => path.relative(packageRoot, entry)).join(', ') } }),
        ];
    }
    if (platform !== 'win32') {
        const nonExecutable = scriptPaths.filter((scriptPath) => {
            const mode = statSyncImpl(scriptPath).mode;
            return (mode & 0o111) === 0;
        });
        if (nonExecutable.length > 0) {
            return [
                configCheck,
                createCheck('hook-scripts', 'Hook scripts', 'fail', `Hook scripts are not executable: ${nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ')}.`, 'Run `npm run build` from the repo checkout or `chmod +x scripts/hooks/*.js` for a local repair.', { code: 'hook-scripts.not-executable', params: { files: nonExecutable.map((entry) => path.relative(packageRoot, entry)).join(', ') } }),
            ];
        }
    }
    return [
        configCheck,
        createCheck('hook-scripts', 'Hook scripts', 'pass', `All ${scriptPaths.length} hook scripts are present${platform === 'win32' ? '' : ' and executable'}.`),
    ];
}
function inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir, installChannel, installedPluginsPath, pluginHost) {
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    if (!existsSyncImpl(markerPath)) {
        if (installChannel === 'plugin-marketplace') {
            const runtime = pluginHost === 'codex' ? 'Codex CLI' : 'Claude Code';
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Wired via the ${runtime} plugin runtime (this is a plugin-marketplace install). The install-hooks marker is not used on this install path.`);
        }
        if (detectPluginRuntime(installedPluginsPath)) {
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', 'Wired via the Claude Code plugin runtime (found in installed_plugins.json). This copy is not the one doing the capturing — the plugin manages the hooks.');
        }
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'memesh is not connected to Claude Code yet, so nothing gets remembered automatically from your sessions.', 'Run `memesh install-hooks` once to connect it, then `memesh doctor` to confirm.', { code: 'hook-wiring.no-marker' }, 'install-hooks');
    }
    const parsed = parseJsonFile(markerPath, readFileSyncImpl);
    if (!parsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', `install-hooks marker at ${markerPath} is unreadable.`, 'Re-run `memesh install-hooks` to refresh the marker.', { code: 'hook-wiring.marker-unreadable', params: { path: markerPath } });
    }
    const marker = parsed.value;
    if (typeof marker.settings_path !== 'string') {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'warn', 'install-hooks marker is malformed (missing settings_path).', 'Re-run `memesh install-hooks`.', { code: 'hook-wiring.marker-malformed' });
    }
    if (!existsSyncImpl(marker.settings_path)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded settings at ${marker.settings_path} but the file no longer exists. Hooks are not wired.`, 'Re-run `memesh install-hooks`.', { code: 'hook-wiring.settings-missing', params: { path: String(marker.settings_path) } });
    }
    const settingsParsed = parseJsonFile(marker.settings_path, readFileSyncImpl);
    if (!settingsParsed.ok) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `${marker.settings_path} is no longer valid JSON, so nothing can read your hook wiring — including memesh.`, `Repair the JSON, or move the file aside (\`mv ${marker.settings_path} ${marker.settings_path}.broken\`) — memesh keeps timestamped \`.bak-pre-memesh-*\` copies next to it. Then run \`memesh install-hooks\`.`, { code: 'hook-wiring.settings-invalid', params: { path: String(marker.settings_path) } });
    }
    const CAPTURE_EVENTS = new Set(['Stop', 'PostToolUse', 'PreCompact']);
    const hooks = settingsParsed.value.hooks;
    let hasMemeshHook = false;
    let hasCaptureHook = false;
    let missingScript = null;
    if (hooks && typeof hooks === 'object') {
        for (const [event, entries] of Object.entries(hooks)) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                const cmds = entry.hooks;
                if (!Array.isArray(cmds))
                    continue;
                for (const c of cmds) {
                    const cmd = c;
                    if (cmd._memesh !== true)
                        continue;
                    hasMemeshHook = true;
                    if (CAPTURE_EVENTS.has(event))
                        hasCaptureHook = true;
                    if (missingScript === null && typeof cmd.command === 'string'
                        && path.isAbsolute(cmd.command) && !existsSyncImpl(cmd.command)) {
                        missingScript = cmd.command;
                    }
                }
            }
        }
    }
    if (missingScript !== null) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `A wired memesh hook points at ${missingScript}, which no longer exists — the agent invokes a missing file on every matching event. This is usually residue from an upgrade that retired the hook.`, 'Run `memesh install-hooks` to re-wire (it now removes retired entries), then restart your agent.', { code: 'hook-wiring.script-missing', params: { path: missingScript } });
    }
    if (!hasMemeshHook) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Marker recorded a memesh install at ${marker.settings_path}, but no _memesh:true hook entries are present anymore. Settings drifted (manual edit?) or memesh was uninstalled out-of-band.`, 'Re-run `memesh install-hooks` to re-wire.', { code: 'hook-wiring.entries-removed', params: { path: String(marker.settings_path) } });
    }
    if (typeof marker.plugin_root === 'string' && !existsSyncImpl(marker.plugin_root)) {
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `Hook commands point at ${marker.plugin_root}, which no longer exists (likely after an npm-global path change).`, 'Re-run `memesh install-hooks` to refresh paths.', { code: 'hook-wiring.root-moved', params: { path: String(marker.plugin_root) } });
    }
    return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', `Wired in ${marker.settings_path} (scope: ${marker.scope ?? 'user'}, version: ${marker.version ?? 'unknown'}).`, undefined, { params: { captureWired: hasCaptureHook ? 1 : 0 } });
}
function inspectHookActivity(openDatabaseImpl, closeDatabaseImpl, existsSyncImpl = fs.existsSync, statSyncImpl = fs.statSync, wiringPresent = true) {
    const TITLE = 'Hook activity';
    const captureOff = autoCaptureOffSource();
    if (captureOff === 'config') {
        return createCheck('hook-activity', TITLE, 'pass', 'Automatic capture is turned off (config autoCapture: false) — deliberately, so hook silence is expected. Re-enable it to resume capturing sessions.', undefined, { code: 'hook-activity.disabled' });
    }
    if (captureOff === 'env') {
        return createCheck('hook-activity', TITLE, 'pass', 'Automatic capture is turned off by MEMESH_AUTO_CAPTURE=false in this shell\'s environment. Doctor can only see its own environment — if your agent runs without this variable, capture there is unaffected.', undefined, { code: 'hook-activity.disabled-env' });
    }
    let db = null;
    try {
        db = openDatabaseImpl();
        const hookRunsTablePresent = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hook_runs'").get();
        const rows = hookRunsTablePresent
            ? db.prepare(`SELECT hook, last_run_at FROM hook_runs`).all()
            : [];
        const captured = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > datetime('now', '-24 hours')`).get(AUTO_CAPTURE_TAG)?.c ?? 0;
        const since = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'hook_runs_since'").get()?.value;
        const measuringHours = since !== undefined ? hoursSince(since) : null;
        const SKEW_TOLERANCE_H = 5 / 60;
        const KNOWN_HOOKS = new Set(['session-summary', 'post-commit', 'pre-compact']);
        const ages = new Map();
        for (const r of rows) {
            if (!KNOWN_HOOKS.has(r.hook))
                continue;
            const age = hoursSince(r.last_run_at);
            ages.set(r.hook, age !== null && age >= -SKEW_TOLERANCE_H ? Math.max(age, 0) : null);
        }
        if (ages.size > 0) {
            const capturedTail = captured > 0
                ? `${captured} memor${captured === 1 ? 'y' : 'ies'} captured in the last 24h.`
                : 'Nothing was worth saving in that time, which is normal — the loop still ran.';
            const staleUnknown = (hook) => createCheck('hook-activity', TITLE, 'fail', `The ${hook} hook's last-run timestamp cannot be read (corrupt, or stamped by a machine with a wrong clock). ` +
                'Capture health is unknown, which is not the same as healthy.', 'End one work session, then re-run `memesh doctor` — a fresh run overwrites the bad timestamp.', { code: 'hook-activity.stale-unknown', params: { hook } });
            const stale = (hook, age, status) => createCheck('hook-activity', TITLE, status, `The ${hook} hook last ran ${formatHoursAgo(Math.ceil(age))}. ` +
                'If you have worked since then, capture has stopped and nothing from those sessions was saved.', 'Restart your agent, then end one session and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.', { code: 'hook-activity.stale', params: { hook, hours: Math.ceil(age) } });
            const ssAge = ages.has('session-summary') ? ages.get('session-summary') : undefined;
            if (ssAge === null)
                return staleUnknown('session-summary');
            if (ssAge !== undefined) {
                if (ssAge <= 24) {
                    return createCheck('hook-activity', TITLE, 'pass', `The session-summary hook last ran ${formatHoursAgo(ssAge)} — auto-capture is alive. ${capturedTail}`);
                }
                if (ssAge <= 72)
                    return stale('session-summary', ssAge, 'warn');
                const ccWrites = db.prepare(`SELECT COUNT(*) as c FROM entities
           WHERE created_at > datetime('now', '-72 hours')
             AND json_valid(metadata)
             AND json_extract(metadata, '$.provenance.source_host') = 'claude-code'`).get()?.c ?? 0;
                if (ccWrites > 0)
                    return stale('session-summary', ssAge, 'fail');
                return createCheck('hook-activity', TITLE, 'warn', `The session-summary hook last ran ${formatHoursAgo(Math.ceil(ssAge))}, and no Claude Code writes landed in the last 3 days either. If this machine has moved to another agent (Codex / Gemini), this is expected; if you still use Claude Code here, capture has stopped.`, 'If you still use Claude Code on this machine: restart it, end one session, and re-run `memesh doctor`. If it does not recover, run `memesh install-hooks`.', { code: 'hook-activity.stale-unconfirmed', params: { hook: 'session-summary', hours: Math.ceil(ssAge) } });
            }
            const known = [...ages.entries()].filter((e) => e[1] !== null);
            if (known.length === 0) {
                const [hook] = [...ages.keys()].sort();
                return staleUnknown(hook);
            }
            const [freshestHook, freshestAge] = known.sort((a, b) => a[1] - b[1])[0];
            if (freshestAge <= 24) {
                if (measuringHours !== null && measuringHours > 72) {
                    return createCheck('hook-activity', TITLE, 'warn', `The ${freshestHook} hook is stamping (last ran ${formatHoursAgo(freshestAge)}), but the session-summary hook has never run once in the ${Math.round(measuringHours)} hours since tracking began — session capture may be broken while commit capture hides it.`, 'End one work session and re-run `memesh doctor`. If session-summary still has not run, run `memesh install-hooks` and restart your agent.', { code: 'hook-activity.stop-silent', params: { hook: freshestHook, hours: Math.round(measuringHours) } });
                }
                return createCheck('hook-activity', TITLE, 'pass', `The ${freshestHook} hook last ran ${formatHoursAgo(freshestAge)} — auto-capture is alive. ` +
                    `(session-summary has not stamped yet — expected until a session with real work ends.) ${capturedTail}`);
            }
            return stale(freshestHook, freshestAge, 'warn');
        }
        if (since !== undefined && (measuringHours === null || measuringHours < 0)) {
            return createCheck('hook-activity', TITLE, 'pass', 'The hook-run tracking marker is unreadable — it will be re-stamped automatically the next time the database is opened for writing (any session, commit, or memesh command does it). Tracking restarts then.');
        }
        if (measuringHours === null || measuringHours < 24) {
            return createCheck('hook-activity', TITLE, 'pass', 'Hook-run tracking has only just started on this database — the first work session will fill it in.');
        }
        const markerPath = path.join(memeshDir(), 'install-hooks.json');
        if (existsSyncImpl(markerPath)) {
            try {
                if (Date.now() - statSyncImpl(markerPath).mtimeMs < 24 * 60 * 60 * 1000) {
                    return createCheck('hook-activity', TITLE, 'pass', 'Hooks were wired in the last day and no session has ended yet — normal for a fresh install.');
                }
            }
            catch { }
        }
        const legacyCaptured = db.prepare(`SELECT COUNT(DISTINCT e.id) as c FROM entities e
       JOIN tags t ON t.entity_id = e.id
       WHERE t.tag = ?
         AND e.created_at > ?`).get(AUTO_CAPTURE_TAG, since)?.c ?? 0;
        if (legacyCaptured > 0) {
            return createCheck('hook-activity', TITLE, 'warn', `No hook has stamped the heartbeat, but ${legacyCaptured} auto-capture memor${legacyCaptured === 1 ? 'y' : 'ies'} landed since tracking began — hooks from a version before heartbeat tracking are probably still running.`, 'Update the memesh hooks to the current version (plugin installs: `/plugin update memesh`; npm installs: `memesh install-hooks`), then restart your agent.', { code: 'hook-activity.never-ran-legacy', params: { captured: legacyCaptured } });
        }
        if (!wiringPresent) {
            return createCheck('hook-activity', TITLE, 'warn', 'No capture hook has ever run — and no capture hook (Stop / PostToolUse / PreCompact) is confirmed wired on this machine, so there is nothing to run.', 'If you want automatic capture, run `memesh install-hooks`. If this install is MCP-only (Codex / Gemini), this is expected and safe to ignore.', { code: 'hook-activity.not-wired' });
        }
        return createCheck('hook-activity', TITLE, 'fail', `No capture hook has run since tracking began ${formatHoursAgo(measuringHours)}. ` +
            'Hook wiring is in place, so they should be executing and are not — nothing is being remembered.', 'Run `memesh doctor` after ending one work session. If this still says no hook has run, run `memesh install-hooks` and restart your agent.', { code: 'hook-activity.never-ran', params: { hours: Math.round(measuringHours) } });
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return createCheck('hook-activity', TITLE, 'fail', `Could not read hook activity from the database: ${detail}. Capture health is unknown, which is not the same as healthy.`, 'The error is quoted above. Check that ~/.memesh is readable and that the disk is not full.', { code: 'hook-activity.query-failed', params: { detail } });
    }
    finally {
        try {
            if (db)
                closeDatabaseImpl();
        }
        catch { }
    }
}
function autoCaptureOffSource() {
    let configAutoCapture;
    try {
        configAutoCapture = readConfig().autoCapture;
    }
    catch {
        configAutoCapture = undefined;
    }
    return autoCaptureDecision(process.env.MEMESH_AUTO_CAPTURE, configAutoCapture).offSource;
}
export function hoursSince(sqliteTimestamp) {
    const then = parseSqliteUtcMs(sqliteTimestamp);
    if (then === null)
        return null;
    return (Date.now() - then) / (60 * 60 * 1000);
}
function formatHoursAgo(hours) {
    if (hours === null || !Number.isFinite(hours) || hours < 0)
        return 'at an unknown time';
    if (hours < 1)
        return 'less than an hour ago';
    if (hours < 48) {
        const h = Math.round(hours);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const d = Math.round(hours / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}
function defaultResolveShellMemesh() {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const localRequire = createRequire(import.meta.url);
        const { execFileSync } = localRequire('child_process');
        const out = execFileSync(cmd, ['memesh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first || null;
    }
    catch {
        return null;
    }
}
const RUNTIME_TOO_OLD = 'memesh:node-sqlite-too-old';
function defaultNativeBindingProbe(packageRoot) {
    try {
        const probe = new MemeshDatabase(':memory:', { allowExtension: true });
        try {
            if (typeof probe.enableLoadExtension !== 'function') {
                return { ok: false, message: `${RUNTIME_TOO_OLD}: node:sqlite in ${process.version} has no enableLoadExtension` };
            }
            probe.enableLoadExtension(true);
            const localRequire = createRequire(pathToFileURL(path.join(packageRoot, 'package.json')).href);
            const sqliteVec = localRequire('sqlite-vec');
            sqliteVec.load(probe);
            probe.prepare('SELECT vec_version()').get();
        }
        finally {
            probe.close();
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}
export function satisfiesMinimumNodeRange(version, range) {
    const min = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range.trim());
    const running = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!min || !running)
        return null;
    const wanted = [Number(min[1]), Number(min[2] ?? 0), Number(min[3] ?? 0)];
    const have = [Number(running[1]), Number(running[2]), Number(running[3])];
    for (let i = 0; i < 3; i++) {
        if (have[i] > wanted[i])
            return true;
        if (have[i] < wanted[i])
            return false;
    }
    return true;
}
export function inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl, nodeVersion = process.version, moduleAbi = process.versions.modules, hasNodeSqliteImpl = hasBuiltInSqlite) {
    const facts = `Node ${nodeVersion} (ABI ${moduleAbi}, ${process.platform}/${process.arch}). ` +
        `Built-in node:sqlite: ${hasNodeSqliteImpl() ? 'available' : 'not available'}.`;
    let declared;
    try {
        const pkgPath = path.join(packageRoot, 'package.json');
        if (existsSyncImpl(pkgPath)) {
            const parsed = JSON.parse(String(readFileSyncImpl(pkgPath, 'utf8')));
            if (typeof parsed.engines?.node === 'string')
                declared = parsed.engines.node;
        }
    }
    catch {
    }
    if (!declared) {
        return createInfo('node-runtime', 'Node runtime', `${facts} Supported range not checked: package.json declared no engines.node.`);
    }
    const ok = satisfiesMinimumNodeRange(nodeVersion, declared);
    if (ok === null) {
        return createInfo('node-runtime', 'Node runtime', `${facts} Supported range not checked: engines.node is "${declared}", which this ` +
            `check does not parse (it understands ">=X.Y.Z" only).`);
    }
    if (!ok) {
        return createCheck('node-runtime', 'Node runtime', 'fail', `${facts} This package requires Node ${declared}, so this runtime is BELOW the ` +
            `supported floor. Native modules and hooks may fail in ways that look unrelated.`, `Upgrade Node to ${declared.replace(/^>=\s*/, '')} or newer, then run \`memesh doctor\` again.`, { code: 'node-runtime.too-old', params: { detail: facts, required: declared.replace(/^>=\s*/, '') } });
    }
    return createCheck('node-runtime', 'Node runtime', 'pass', `${facts} Meets the required range ${declared}.`);
}
export function hasBuiltInSqlite() {
    try {
        createRequire(import.meta.url).resolve('node:sqlite');
        return true;
    }
    catch {
        return false;
    }
}
function inspectNativeBinding(packageRoot, _existsSyncImpl, probeImpl = defaultNativeBindingProbe) {
    const result = probeImpl(packageRoot);
    if (result.ok) {
        return createCheck('native-binding', 'SQLite and vector search', 'pass', 'node:sqlite opened a database and sqlite-vec loaded (probe succeeded).');
    }
    if (result.message.startsWith(RUNTIME_TOO_OLD)) {
        return createCheck('native-binding', 'SQLite and vector search', 'fail', `The node:sqlite in this Node (${process.version}) is too old for memesh — it cannot load the vector-search extension. The complete version arrived in Node 22.13.`, 'Upgrade Node to 22.13 or newer, then re-run `memesh doctor`.', { code: 'native-binding.node-too-old', params: { version: process.version } });
    }
    const isMissingPackage = /MODULE_NOT_FOUND|Cannot find module/i.test(result.message);
    if (isMissingPackage) {
        return createCheck('native-binding', 'SQLite and vector search', 'warn', 'sqlite-vec is not installed, so memesh cannot search by meaning. Memories are still saved, and still found by keyword.', 'Run: npm install   (in the directory that depends on @pcircle/memesh)', { code: 'native-binding.not-installed' });
    }
    return createCheck('native-binding', 'SQLite and vector search', 'warn', `sqlite-vec could not be loaded: ${result.message}. Memories are still saved and found by keyword; only search by meaning is off.`, `Run: cd "${packageRoot}" && npm install --omit=dev`, { code: 'native-binding.load-failed', params: { detail: result.message, root: packageRoot } });
}
function readVersionFromInstalledBinary(binaryPath, existsSyncImpl, readFileSyncImpl, realpathSyncImpl = fs.realpathSync) {
    let resolved;
    try {
        resolved = realpathSyncImpl(binaryPath);
    }
    catch {
        resolved = binaryPath;
    }
    let dir = path.dirname(resolved);
    for (let depth = 0; depth < 8; depth += 1) {
        const pkgPath = path.join(dir, 'package.json');
        if (existsSyncImpl(pkgPath)) {
            const parsed = parseJsonFile(pkgPath, readFileSyncImpl);
            if (!parsed.ok)
                return null;
            const { name, version } = parsed.value;
            return name === '@pcircle/memesh' && typeof version === 'string' ? version : null;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
    return null;
}
function inspectShellCli(installChannel, packageRoot, packageVersion, resolveShellMemeshImpl, existsSyncImpl, readFileSyncImpl) {
    const shellPath = resolveShellMemeshImpl();
    const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
    const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;
    if (installChannel === 'npm-global') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
            ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
            : 'Running from npm-global install — shell access available in this terminal.');
    }
    if (hasDistinctShellCli) {
        const shellVersion = readVersionFromInstalledBinary(shellPath, existsSyncImpl, readFileSyncImpl);
        const shellIsBehind = shellVersion ? classifyBump(shellVersion, packageVersion) : null;
        const thisIsBehind = shellVersion ? classifyBump(packageVersion, shellVersion) : null;
        if (shellIsBehind) {
            return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}), and it is running ${shellVersion} — behind this install's ${packageVersion}. Both share the same DB, but an agent using this install and a human typing \`memesh\` in a terminal are running different code.`, 'Run `npm install -g @pcircle/memesh@latest` to bring the shell CLI up to date — a separate global install is never updated automatically by the plugin marketplace.');
        }
        if (thisIsBehind) {
            const pluginHost = installChannel === 'plugin-marketplace' ? (detectPluginHost(packageRoot) ?? 'claude-code') : null;
            const fix = pluginHost
                ? `Run \`${PLUGIN_REFRESH_COMMANDS[pluginHost]}\` to bring this plugin copy to ${shellVersion} (or newer).`
                : `Update this install (a ${installChannel}) to ${shellVersion} or newer via its own channel — see \`memesh status\`.`;
            return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}), and it is running ${shellVersion} — ahead of this install's ${packageVersion}.`, fix);
        }
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}). Both paths coexist and share the same DB`
            + (shellVersion ? `, both on ${packageVersion}.` : ' — could not read the shell copy\'s own version to compare.'));
    }
    if (installChannel === 'plugin-marketplace') {
        const host = detectPluginHost(packageRoot) === 'codex' ? 'Codex CLI' : 'Claude Code';
        return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', 'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
            + `${host} MCP / hooks / \`/memesh\` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).`, 'Run `npm install -g @pcircle/memesh` to add the shell CLI. Both paths coexist; they share the same `~/.memesh/knowledge-graph.db`.', { code: 'shell-cli.not-on-path' });
    }
    return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
        ? `\`memesh\` resolves to ${shellPath}.`
        : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`);
}
function defaultMarketplaceHeadSha(host) {
    if (host === 'codex') {
        const codexHome = pluginHostConfigRoot('codex');
        return readCodexInstallRevision(path.join(codexHome, '.tmp', 'marketplaces', 'pcircle-memesh'), fs.readFileSync);
    }
    const dir = path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'marketplaces', 'pcircle-memesh');
    try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return /^[0-9a-f]{40}$/.test(out) ? out : null;
    }
    catch {
        return null;
    }
}
function readCodexInstallRevision(root, readFileSyncImpl) {
    const parsed = parseJsonFile(path.join(root, '.codex-marketplace-install.json'), readFileSyncImpl);
    if (!parsed.ok)
        return null;
    const rev = parsed.value.revision;
    return typeof rev === 'string' && /^[0-9a-f]{40}$/.test(rev) ? rev : null;
}
function pluginCacheUnverifiable(host, missing) {
    const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
    const command = PLUGIN_REFRESH_COMMANDS[host];
    return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'warn', `Could not tell whether the plugin cache matches the marketplace: ${missing}. The version alone cannot answer this — two builds can carry the same version.`, `Run \`${command}\` — it re-stages the cache from the marketplace and records the commit, after which this check can answer.`, { code: 'plugin-cache.unverifiable', params: { host: hostLabel, command } });
}
function readClaudePluginEntries(registryPath, readFileSyncImpl, existsSyncImpl) {
    if (!existsSyncImpl(registryPath)) {
        return { exists: false, readable: false, defined: false, malformed: false, entries: [] };
    }
    const parsed = parseJsonFile(registryPath, readFileSyncImpl);
    if (!parsed.ok)
        return { exists: true, readable: false, defined: false, malformed: false, entries: [] };
    const raw = parsed.value?.plugins?.['memesh@pcircle-memesh'];
    const entries = Array.isArray(raw)
        ? raw.filter((entry) => !!entry && typeof entry === 'object')
        : [];
    return {
        exists: true,
        readable: true,
        defined: raw !== undefined,
        malformed: raw !== undefined && (!Array.isArray(raw) || entries.length !== raw.length),
        entries,
    };
}
function defaultPluginCacheDiscovery(readFileSyncImpl, existsSyncImpl) {
    const discovered = [];
    const claudeConfigRoot = pluginHostConfigRoot('claude-code');
    const claudeRegistry = path.join(claudeConfigRoot, 'plugins', 'installed_plugins.json');
    const claudeCacheRoot = path.join(claudeConfigRoot, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
    const registry = readClaudePluginEntries(claudeRegistry, readFileSyncImpl, existsSyncImpl);
    const entries = registry.entries;
    if (registry.malformed) {
        discovered.push({
            host: 'claude-code',
            packageRoot: claudeCacheRoot,
            installedPluginsPath: claudeRegistry,
            unverifiableReason: 'installed_plugins.json has a malformed memesh entry',
        });
    }
    else if (entries.length > 0) {
        const cachesByRoot = new Map();
        for (const entry of entries) {
            const recordedInstallPath = typeof entry.installPath === 'string' && entry.installPath.length > 0
                ? entry.installPath
                : null;
            const installPath = recordedInstallPath ?? claudeCacheRoot;
            const cache = {
                host: 'claude-code', packageRoot: installPath, installedPluginsPath: claudeRegistry,
                ...(!recordedInstallPath ? { unverifiableReason: 'an installed_plugins.json entry has no usable installPath' }
                    : !existsSyncImpl(installPath) ? { unverifiableReason: `the recorded plugin cache does not exist at ${installPath}` } : {}),
            };
            const rootKey = path.resolve(installPath);
            const existing = cachesByRoot.get(rootKey);
            if (!existing)
                cachesByRoot.set(rootKey, cache);
            else if (!existing.unverifiableReason && cache.unverifiableReason) {
                existing.unverifiableReason = cache.unverifiableReason;
            }
        }
        discovered.push(...cachesByRoot.values());
    }
    else if (registry.defined) {
        const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
        if (cachedRoots.length > 0) {
            discovered.push({
                host: 'claude-code',
                packageRoot: cachedRoots[cachedRoots.length - 1],
                installedPluginsPath: claudeRegistry,
                unverifiableReason: 'installed_plugins.json records no active memesh install while a versioned plugin cache still exists',
            });
        }
    }
    else if (!registry.readable) {
        const cachedRoots = versionedPluginCacheRoots(claudeCacheRoot);
        const cachedRoot = cachedRoots[cachedRoots.length - 1];
        if (cachedRoot) {
            discovered.push({
                host: 'claude-code', packageRoot: cachedRoot, installedPluginsPath: claudeRegistry,
                unverifiableReason: registry.exists
                    ? 'installed_plugins.json could not be read or parsed'
                    : 'installed_plugins.json does not exist while a versioned plugin cache still exists',
            });
        }
    }
    const codexHome = pluginHostConfigRoot('codex');
    const codexCacheRoot = path.join(codexHome, 'plugins', 'cache', 'pcircle-memesh', 'memesh');
    const codexRoots = versionedPluginCacheRoots(codexCacheRoot);
    if (codexRoots.length === 1) {
        discovered.push({ host: 'codex', packageRoot: codexRoots[0] });
    }
    else if (codexRoots.length > 1) {
        discovered.push({
            host: 'codex',
            packageRoot: codexRoots[codexRoots.length - 1],
            unverifiableReason: `several versioned Codex plugin cache directories exist under ${codexCacheRoot}`,
        });
    }
    return discovered;
}
function inspectPluginCacheCurrency(installChannel, pluginHost, packageRoot, installedPluginsPath, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl) {
    if (installChannel !== 'plugin-marketplace')
        return null;
    const host = pluginHost === 'codex' ? 'codex' : 'claude-code';
    const hostLabel = host === 'codex' ? 'Codex' : 'Claude Code';
    const command = PLUGIN_REFRESH_COMMANDS[host];
    let installedSha;
    let installedMissing;
    if (host === 'codex') {
        installedSha = readCodexInstallRevision(packageRoot, readFileSyncImpl);
        installedMissing = 'the plugin cache carries no readable .codex-marketplace-install.json revision';
    }
    else {
        const registryPath = installedPluginsPath ?? path.join(pluginHostConfigRoot('claude-code'), 'plugins', 'installed_plugins.json');
        const registry = readClaudePluginEntries(registryPath, readFileSyncImpl, existsSyncImpl);
        const entries = registry.entries;
        const here = path.resolve(packageRoot);
        const matching = entries.filter(e => typeof e?.installPath === 'string' && path.resolve(e.installPath) === here);
        const soleEntry = entries.length === 1 ? entries[0] : undefined;
        const soleEntryHasPath = typeof soleEntry?.installPath === 'string' && soleEntry.installPath.length > 0;
        const entry = matching.length === 1 ? matching[0] : undefined;
        installedSha = !registry.malformed
            && typeof entry?.gitCommitSha === 'string'
            && /^[0-9a-f]{40}$/.test(entry.gitCommitSha)
            ? entry.gitCommitSha
            : null;
        if (!registry.exists) {
            installedMissing = `installed_plugins.json does not exist at ${registryPath}`;
        }
        else if (!registry.readable) {
            installedMissing = 'installed_plugins.json could not be read or parsed';
        }
        else if (registry.malformed) {
            installedMissing = 'installed_plugins.json has a malformed memesh entry';
        }
        else if (!registry.defined) {
            installedMissing = 'installed_plugins.json has no memesh@pcircle-memesh entry';
        }
        else if (entries.length === 0) {
            installedMissing = 'installed_plugins.json records no active memesh install for this cache';
        }
        else if (matching.length > 1) {
            installedMissing = `installed_plugins.json lists ${matching.length} memesh entries for this install (${packageRoot})`;
        }
        else if (matching.length === 0 && soleEntryHasPath) {
            installedMissing = `the only memesh entry in installed_plugins.json names another install, not this one (${packageRoot})`;
        }
        else if (matching.length === 0 && soleEntry) {
            installedMissing = 'the only memesh entry in installed_plugins.json has no usable installPath to identify this cache';
        }
        else if (entries.length > 1 && matching.length === 0) {
            installedMissing = `installed_plugins.json lists ${entries.length} memesh entries and none of them is this install (${packageRoot})`;
        }
        else {
            installedMissing = 'installed_plugins.json does not record the commit this plugin was installed from';
        }
    }
    const marketplaceSha = marketplaceHeadShaImpl(host);
    if (!installedSha || !marketplaceSha) {
        const missing = !installedSha ? installedMissing : `the ${hostLabel} marketplace snapshot has no readable commit`;
        return pluginCacheUnverifiable(host, missing);
    }
    if (installedSha === marketplaceSha) {
        return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'pass', `The plugin cache records marketplace commit ${marketplaceSha.slice(0, 8)}, which matches the current marketplace snapshot.`);
    }
    return createCheck('plugin-cache', `Plugin cache source record is current (${hostLabel})`, 'warn', `The plugin cache records commit ${installedSha.slice(0, 8)}, but the marketplace has moved to ${marketplaceSha.slice(0, 8)} under the same version — ${hostLabel} does not normally refresh a cache whose version did not change, so refresh the cache before relying on the newer marketplace code.`, `Run \`${command}\` to refresh the cache in place, then restart ${hostLabel}.`, { code: 'plugin-cache.stale', params: { installed: installedSha.slice(0, 8), marketplace: marketplaceSha.slice(0, 8), host: hostLabel, command } });
}
function annotateNpmGlobalPluginCacheVersion(check, discoveredPackageRoot, hostLabel, runningVersion) {
    const cacheRoot = path.dirname(discoveredPackageRoot);
    const discoveredVersion = path.basename(discoveredPackageRoot);
    let amended = check;
    if (discoveredVersion !== runningVersion && classifyBump(runningVersion, discoveredVersion)) {
        const skewNote = `This npm-global install is on ${runningVersion}; the ${hostLabel} plugin cache is on ${discoveredVersion}. `
            + 'The plugin marketplace\'s own auto-updater only ever refreshes its plugin copy — it cannot and will not update this separate npm-global install.';
        const skewFix = `Run \`memesh update\` to bring this npm-global install to ${discoveredVersion} (or newer) — it does not update itself automatically.`;
        amended = {
            ...amended,
            status: amended.status === 'pass' ? 'warn' : amended.status,
            summary: `${amended.summary} ${skewNote}`,
            fix: amended.fix ? `${amended.fix} Also: ${skewFix}` : skewFix,
            code: undefined,
            params: undefined,
        };
    }
    const cachedVersions = versionedPluginCacheRoots(cacheRoot);
    if (cachedVersions.length > 2) {
        amended = {
            ...amended,
            summary: `${amended.summary} ${cachedVersions.length} versioned copies of the ${hostLabel} plugin are cached under ${cacheRoot}; old ones are never removed automatically. `
                + `Delete ones you no longer need once no ${hostLabel} process is using them, e.g. \`rm -rf "${cachedVersions[0]}"\`.`,
        };
    }
    return amended;
}
function inspectClaudeChannelRegistration(existsSyncImpl, readFileSyncImpl) {
    const configPath = path.join(homeDir(), '.claude.json');
    let parsed = null;
    if (existsSyncImpl(configPath)) {
        try {
            const value = JSON.parse(readFileSyncImpl(configPath, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('not an object');
            parsed = value;
        }
        catch {
            return createCheck('claude-channel', 'Claude Channel registration', 'warn', 'The canonical Claude user config could not be read as JSON, so the memesh-channel registration is malformed or unverifiable.', 'Repair the owner-controlled Claude config with `claude mcp remove memesh-channel` and re-run `memesh agent setup claude` to obtain a fresh registration command.');
        }
    }
    const servers = parsed?.mcpServers;
    const server = servers && typeof servers === 'object' && !Array.isArray(servers)
        ? servers['memesh-channel']
        : undefined;
    if (server === undefined) {
        return createCheck('claude-channel', 'Claude Channel registration', 'warn', 'No user-scoped memesh-channel registration was found. Durable MCP/inbox messaging can still work, but live Claude Channel notification is inactive. The upstream research-preview channel remains opt-in.', 'If you want the opt-in channel, run `memesh agent setup claude` and then register the printed user-scoped MCP command.');
    }
    const record = server && typeof server === 'object' && !Array.isArray(server)
        ? server
        : null;
    const command = record?.command;
    const rawArgs = record?.args;
    const args = Array.isArray(rawArgs) ? rawArgs : null;
    const configIndex = args?.indexOf('--config') ?? -1;
    const target = args && configIndex >= 0 && typeof args[configIndex + 1] === 'string'
        ? args[configIndex + 1]
        : null;
    let targetConfigValid = false;
    if (target) {
        try {
            const config = readHostConfigFile(target);
            const required = ['router_socket', 'token_file', 'project', 'principal_id'];
            targetConfigValid = config.server_name === 'memesh-channel'
                && required.every((key) => {
                    const value = config[key];
                    return typeof value === 'string'
                        && value.length > 0
                        && Buffer.byteLength(value) <= 4096;
                });
        }
        catch {
            targetConfigValid = false;
        }
    }
    const coherent = command === 'memesh-host-claude'
        && args !== null
        && args.length === 2
        && configIndex === 0
        && target !== null
        && targetConfigValid;
    if (!coherent) {
        const reason = command !== 'memesh-host-claude' || args === null || configIndex !== 0 || target === null
            ? 'the command or --config declaration is malformed'
            : 'the declared owner config target is missing, insecure, malformed, or incomplete';
        return createCheck('claude-channel', 'Claude Channel registration', 'warn', `The user-scoped memesh-channel registration is present but ${reason}. Live Claude Channel notification is not established.`, 'Remove and re-register the owner-controlled memesh-channel entry with `memesh agent setup claude`; keep its generated config file owner-private.');
    }
    return createInfo('claude-channel', 'Claude Channel registration', 'The user-scoped memesh-channel registration and owner-private config target are coherent (CONFIGURED). Development-channel admission and agent surfacing are not verified; durable MCP/inbox messaging remains a separate path.');
}
function inspectDashboardArtifact(packageRoot, existsSyncImpl) {
    const dashboardPath = path.join(packageRoot, 'dashboard', 'dist', 'index.html');
    if (!existsSyncImpl(dashboardPath)) {
        return createCheck('dashboard', 'Dashboard artifact', 'fail', 'dashboard/dist/index.html is missing.', 'Build the dashboard with `cd dashboard && npm install && npm run build`, then run `npm run build` at the repo root if needed.', { code: 'dashboard.missing' });
    }
    return createCheck('dashboard', 'Dashboard artifact', 'pass', 'dashboard/dist/index.html is present.');
}
function isFreshInstall() {
    try {
        const createdAt = new Date(getInstallRecord().created_at).getTime();
        if (!Number.isFinite(createdAt))
            return false;
        return (Date.now() - createdAt) / (60 * 60 * 1000) < 24;
    }
    catch {
        return false;
    }
}
async function inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport) {
    const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
    if (!update) {
        if (isFreshInstall()) {
            return createCheck('update-status', 'Update status', 'pass', 'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.');
        }
        return createCheck('update-status', 'Update status', 'warn', 'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.', 'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.', { code: 'update-status.no-cache' });
    }
    if (update.currentVersionDeprecated && update.deprecationMessage) {
        const target = update.latestVersion && update.latestVersion !== packageVersion
            ? ` -> ${update.latestVersion}`
            : '';
        const hasUpgradeTarget = update.latestVersion
            && update.latestVersion !== packageVersion;
        let fix;
        if (installSupport?.canSelfUpdate) {
            fix = hasUpgradeTarget
                ? `Run \`memesh update\`${target}.`
                : 'Run `memesh update` to refresh the registry lookup and apply any newly-published fix.';
        }
        else if (installSupport?.guidance) {
            fix = installSupport.guidance + (hasUpgradeTarget
                ? ` Upgrade target: ${update.latestVersion}.`
                : ' Upgrade target uncertain — re-check `memesh status` while online.');
        }
        else {
            fix = `Upgrade via your install method (see \`memesh status\`).`;
        }
        return createCheck('update-status', 'Update status', 'fail', `Installed version ${packageVersion} is DEPRECATED by maintainers: ${update.deprecationMessage}`, fix, { code: 'update-status.deprecated', params: { version: packageVersion, detail: update.deprecationMessage ?? '' } });
    }
    if (update.freshness === 'unavailable') {
        if (isFreshInstall()) {
            return createCheck('update-status', 'Update status', 'pass', 'Installed recently — memesh has not had a chance to check for updates yet. This resolves itself on the first successful check.');
        }
        return createCheck('update-status', 'Update status', 'warn', 'memesh has not been able to check for newer versions yet, so it cannot tell you whether an update exists.', 'Run `memesh status` once while connected to the internet — that stores the answer and this notice goes away.', { code: 'update-status.no-cache' });
    }
    if (update.checkSucceeded && update.lastError) {
        const hasUpdate = Boolean(update.updateAvailable && update.latestVersion);
        const summary = hasUpdate
            ? `Deprecation status unknown for ${packageVersion}: ${update.lastError}. Update ${update.latestVersion} is available.`
            : `Deprecation status unknown for ${packageVersion}: ${update.lastError}.`;
        let upgradeHint;
        if (hasUpdate) {
            if (installSupport?.canSelfUpdate) {
                upgradeHint = `, or \`memesh update\` to apply ${update.latestVersion}`;
            }
            else if (installSupport?.guidance) {
                upgradeHint = `. Upgrade target ${update.latestVersion} via your install method: ${installSupport.guidance}`;
            }
            else {
                upgradeHint = `. Upgrade target: ${update.latestVersion}.`;
            }
        }
        else {
            upgradeHint = '';
        }
        const fix = `Run \`memesh status\` while online to retry the deprecation lookup${upgradeHint}.`;
        return createCheck('update-status', 'Update status', 'warn', summary, fix, {
            code: 'update-status.deprecation-unknown',
            params: { version: packageVersion, detail: update.lastError ?? '' },
        });
    }
    if (update.updateAvailable && update.latestVersion) {
        if (classifyBump(packageVersion, update.latestVersion)) {
            return createCheck('update-status', 'Update status', 'warn', `Update available: ${update.latestVersion} (current: ${packageVersion})`, `Run 'memesh update' to upgrade`, { code: 'update-status.update-available', params: { latest: update.latestVersion, current: packageVersion } });
        }
        else {
            return createCheck('update-status', 'Update status', 'pass', `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`);
        }
    }
    const checkedHoursAgo = update.lastSuccessfulCheckAt === null
        ? null
        : (Date.now() - Date.parse(update.lastSuccessfulCheckAt)) / 3600_000;
    const checkedAgo = formatHoursAgo(checkedHoursAgo);
    return createCheck('update-status', 'Update status', update.freshness === 'stale' ? 'warn' : 'pass', update.freshness === 'stale'
        ? `As of the last check (${checkedAgo}), ${packageVersion} was the latest version — that check is more than 24h old, so a newer release may exist since. Doctor never makes a live registry call itself.`
        : `As of the last check (${checkedAgo}), ${packageVersion} was the latest version.`, update.freshness === 'stale'
        ? 'Run `memesh status` while online to refresh cached update metadata.'
        : undefined, update.freshness === 'stale'
        ? { code: 'update-status.stale', params: { version: packageVersion } }
        : undefined);
}
async function inspectHttpProbe(httpBaseUrl, fetchImpl) {
    try {
        const response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}/v1/health`);
        if (!response.ok) {
            return createCheck('http-probe', 'HTTP probe', 'warn', `HTTP server responded with ${response.status} at ${httpBaseUrl}.`, 'Run `memesh serve` and check the logs, then retry `memesh doctor --probe-http`.', { code: 'http-probe.bad-status', params: { status: response.status, url: httpBaseUrl } });
        }
        return createCheck('http-probe', 'HTTP probe', 'pass', `HTTP server is reachable at ${httpBaseUrl}.`);
    }
    catch {
        return createCheck('http-probe', 'HTTP probe', 'warn', `No running HTTP server detected at ${httpBaseUrl}.`, 'Start the local server with `memesh serve` if you want dashboard and HTTP API verification.', { code: 'http-probe.no-server', params: { url: httpBaseUrl } });
    }
}
function verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl, installSupport) {
    const reinstall = installSupport.guidance;
    const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
    if (!existsSyncImpl(manifestPath)) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'warn', 'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.', `Run \`npm run build\` to regenerate, or reinstall: ${reinstall}`, { code: 'skills-manifest.missing-dev' });
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
    }
    catch (err) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`, `Reinstall the package: ${reinstall} If the problem persists open an issue.`, { code: 'skills-manifest.unreadable', params: { detail: err instanceof Error ? err.message : 'parse error' } });
    }
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    if (entries.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', 'skills-manifest.json contains zero entries.', `Reinstall the package: ${reinstall}`, { code: 'skills-manifest.empty' });
    }
    const mismatches = [];
    const missing = [];
    for (const entry of entries) {
        const full = path.join(packageRoot, entry.path);
        if (!existsSyncImpl(full)) {
            missing.push(entry.path);
            continue;
        }
        let actualHash;
        try {
            const buf = readFileSyncImpl(full);
            actualHash = createHash('sha256').update(buf).digest('hex');
        }
        catch (err) {
            mismatches.push(`${entry.path} (read error: ${err instanceof Error ? err.message : 'unknown'})`);
            continue;
        }
        if (actualHash !== entry.sha256)
            mismatches.push(entry.path);
    }
    if (missing.length === 0 && mismatches.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'pass', `${entries.length} skill / hook files match the published manifest (SHA-256 verified).`);
    }
    const detail = [
        missing.length > 0 ? `${missing.length} missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}` : null,
        mismatches.length > 0 ? `${mismatches.length} tampered: ${mismatches.slice(0, 3).join(', ')}${mismatches.length > 3 ? ` (+${mismatches.length - 3} more)` : ''}` : null,
    ].filter(Boolean).join('; ');
    return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `Manifest verification failed: ${detail}.`, `Reinstall the package: ${reinstall} If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.`, { code: 'skills-manifest.verify-failed', params: { detail } });
}
function probeInstalledMessageCapability(packageRoot) {
    const required = [
        'dist/mcp/server.js',
        'dist/transports/mcp/handlers.js',
        'dist/host-adapters/codex-app-server.js',
        'dist/host-adapters/claude-channel.js',
        'dist/host-adapters/acp-client.js',
    ];
    const absent = required.filter((relative) => !fs.existsSync(path.join(packageRoot, relative)));
    if (absent.length > 0)
        return { ok: false, message: `installed runtime is missing ${absent.join(', ')}` };
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctor-message-'));
    try {
        execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      import { Client } from '@modelcontextprotocol/sdk/client/index.js';
      import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
      const root = ${JSON.stringify(packageRoot)};
      await Promise.all([
        import(pathToFileURL(root + '/dist/host-adapters/codex-app-server.js').href),
        import(pathToFileURL(root + '/dist/host-adapters/claude-channel.js').href),
        import(pathToFileURL(root + '/dist/host-adapters/acp-client.js').href),
      ]);
      const client = new Client({ name: 'memesh-doctor-message-probe', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [root + '/dist/mcp/server.js'], env: process.env });
      try {
        await client.connect(transport);
        const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'message');
        assert.ok(tool, 'installed MCP did not advertise message');
        const actions = tool.inputSchema?.properties?.action?.enum;
        assert.deepEqual(actions, ['send', 'poll', 'discover', 'fetch', 'intake', 'ack', 'disposition', 'activation', 'receipts']);
      } finally { await client.close(); }
    `], {
            cwd: packageRoot,
            stdio: 'pipe',
            timeout: 15_000,
            env: { ...process.env, HOME: probeHome, MEMESH_AUTO_CAPTURE: 'false' },
        });
        return { ok: true };
    }
    catch {
        return { ok: false, message: 'installed MCP or bundled host adapters did not complete the message capability probe' };
    }
    finally {
        fs.rmSync(probeHome, { recursive: true, force: true });
    }
}
function inspectMessageCapability(packageRoot, enabled, probe) {
    if (!enabled) {
        return createInfo('message-capability', 'Message adapter imports', 'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1 to start this installed MCP and verify its nine-action message schema plus bundled host-adapter imports. This does not check a live router socket or host registration.');
    }
    const result = probe(packageRoot);
    if (result.ok)
        return createCheck('message-capability', 'Message adapter imports', 'pass', 'This installed MCP advertised the nine-action message schema and all bundled host adapters imported successfully. No live router socket, host registration, or host acceptance was verified.');
    return createCheck('message-capability', 'Message adapter imports', 'fail', `Installed message capability probe failed: ${result.message}.`, 'Reinstall or rebuild this package, then retry with MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY=1.', { code: 'message-capability.probe-failed', params: { detail: result.message } });
}
async function defaultMessageRouterStatusProbe() {
    const socketPath = process.env.MEMESH_ROUTER_SOCKET
        ?? path.join(getMemeshDirFromDbPath(), 'agent-router.sock');
    let stat;
    try {
        stat = fs.lstatSync(socketPath);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { socket_path: socketPath, socket: 'missing', detail };
    }
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
        return { socket_path: socketPath, socket: 'insecure' };
    }
    const reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ path: socketPath });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 1_500);
        timer.unref();
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
    return { socket_path: socketPath, socket: reachable ? 'reachable' : 'unreachable' };
}
async function inspectMessageRouterStatus(enabled, probe) {
    if (!enabled) {
        return createInfo('message-router-status', 'Live message router / host registration', 'Not verified (opt-in). Set MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER=1 to check only whether the owner-private Local router socket is live. This check never starts a router, registers a host, sends a message, or wakes a stopped session.');
    }
    const result = await probe();
    switch (result.socket) {
        case 'reachable':
            return createCheck('message-router-status', 'Live message router / host registration', 'pass', `Owner-private Local router socket is reachable at ${result.socket_path}. This proves only router availability; it does not prove an active host registration, native delivery, host_accept, ACK, or stopped-session wake-up.`);
        case 'missing':
            return createCheck('message-router-status', 'Live message router / host registration', 'warn', `No Local router socket exists at ${result.socket_path}. No active host is registered through this router, and MeMesh will not wake a stopped or missing session.`, 'Start the owner-configured router with `memesh-router`, then run this opt-in probe again.', { code: 'message-router.socket-missing', params: { path: result.socket_path } });
        case 'insecure':
            return createCheck('message-router-status', 'Live message router / host registration', 'fail', `Router socket at ${result.socket_path} is not an owner-private Unix socket.`, 'Stop the router, remove the unsafe socket, and restart `memesh-router` under the owning user.', { code: 'message-router.socket-insecure', params: { path: result.socket_path } });
        case 'unreachable':
            return createCheck('message-router-status', 'Live message router / host registration', 'warn', `An owner-private router socket exists at ${result.socket_path}, but it did not accept a local connection. No host registration or native delivery is verified.`, 'Check the owner-configured `memesh-router` process, then run this opt-in probe again.', { code: 'message-router.socket-unreachable', params: { path: result.socket_path } });
    }
}
async function inspectEmbeddingProbe(capabilities, probeCapabilities, embedTextImpl) {
    if (capabilities.embeddings === 'tfidf') {
        return createInfo('embeddings_probe', 'Embeddings work', 'No neural embedder configured — recall runs on FTS5 keyword search alone. That is a supported mode, not a fault.');
    }
    if (!probeCapabilities) {
        return createInfo('embeddings_probe', 'Embeddings work', `NOT VERIFIED. Config names "${capabilities.embeddings}", but generating a test embedding is a network call (billed on hosted providers) so it was not made — a revoked key or an unreachable host would look identical to a healthy setup here.`, 'Run: memesh doctor --probe   (generates one test embedding to confirm)');
    }
    let timer;
    try {
        const vector = await Promise.race([
            embedTextImpl('memesh doctor embedding probe'),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no response within ${EMBEDDING_PROBE_TIMEOUT_MS / 1000}s`)), EMBEDDING_PROBE_TIMEOUT_MS);
            }),
        ]);
        if (!vector || vector.length === 0) {
            return createCheck('embeddings_probe', 'Embeddings work', 'warn', `Config selects "${capabilities.embeddings}" but generating a test embedding returned nothing. Semantic recall is degraded to FTS5-only; keyword search still works.`, 'Run: memesh doctor --probe for detail, or check network access to the embedding provider.', { code: 'embeddings.empty', params: { provider: String(capabilities.embeddings) } });
        }
        return createCheck('embeddings_probe', 'Embeddings work', 'pass', `Generated a ${vector.length}-dim test embedding via "${capabilities.embeddings}".`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('embeddings_probe', 'Embeddings work', 'warn', `Config selects "${capabilities.embeddings}" but the embedder threw (${msg}). Semantic recall is degraded to FTS5-only.`, 'Check the embedding provider is reachable (e.g. run `ollama serve`), or remove embedder config to use keyword-only search.', { code: 'embeddings.threw', params: { provider: String(capabilities.embeddings), detail: msg } });
    }
    finally {
        clearTimeout(timer);
    }
}
async function inspectLlmProbe(capabilities, probeCapabilities, probeProviderImpl) {
    const llm = capabilities.llm;
    if (!llm) {
        return createInfo('llm_probe', 'LLM reachable', 'No LLM configured — Core Mode. Write-side features (lessons, auto-tag, dream) are off by design.');
    }
    if (!probeCapabilities) {
        return createInfo('llm_probe', 'LLM reachable', `NOT VERIFIED. Config names ${llm.provider} (${llm.model ?? 'default'}), but no live call was made — an expired key or an unreachable host would look identical to a healthy setup here.`, 'Run: memesh doctor --probe   (makes one small live call to confirm)');
    }
    try {
        const result = await probeProviderImpl(llm.provider, llm.apiKey);
        if (result.valid) {
            return createCheck('llm_probe', 'LLM reachable', 'pass', `${llm.provider} answered a live probe.`);
        }
        return createCheck('llm_probe', 'LLM reachable', 'fail', `${llm.provider} is configured but did not answer: ${result.error ?? 'unknown error'}. Every LLM-backed feature is silently doing nothing.`, 'Check the API key / host, then re-run: memesh doctor --probe', { code: 'llm.unreachable', params: { provider: llm.provider, detail: result.error ?? 'unknown error' } });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return createCheck('llm_probe', 'LLM reachable', 'fail', `${llm.provider} probe threw: ${msg}. Every LLM-backed feature is silently doing nothing.`, 'Check the API key / host, then re-run: memesh doctor --probe', { code: 'llm.threw', params: { provider: llm.provider, detail: msg } });
    }
}
function summarizeOverallStatus(checks) {
    const assertions = checks.filter((check) => !check.informational);
    if (assertions.some((check) => check.status === 'fail'))
        return 'FAIL';
    if (assertions.some((check) => check.status === 'warn'))
        return 'PASS_WITH_CONCERNS';
    return 'PASS';
}
export async function runDoctor(options) {
    const { packageRoot, packageVersion, probeHttp = false, probeCapabilities = false, embedTextImpl = embedText, probeProviderImpl = probeProvider, httpBaseUrl = 'http://127.0.0.1:3737', platform = process.platform, openDatabaseImpl = openDatabase, closeDatabaseImpl = closeDatabase, isDatabaseOpenImpl = isDatabaseOpen, detectCapabilitiesImpl = detectCapabilities, getConfigPathImpl = getConfigPath, getUpdateCheckImpl = getUpdateCheck, getCurrentInstallChannelImpl = getCurrentInstallChannel, installedPluginsPathImpl, marketplaceHeadShaImpl = defaultMarketplaceHeadSha, pluginCacheDiscoveryImpl, getInstallChannelSupportImpl = getInstallChannelSupport, existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, statSyncImpl = fs.statSync, fetchImpl = fetch, agentMessageStoragePolicy, nativeBindingProbeImpl, resolveShellMemeshImpl = defaultResolveShellMemesh, probeMessageCapability = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_CAPABILITY === '1', messageCapabilityProbeImpl = probeInstalledMessageCapability, probeMessageRouterStatus = process.env.MEMESH_DOCTOR_PROBE_MESSAGE_ROUTER === '1', messageRouterStatusProbeImpl = defaultMessageRouterStatusProbe, } = options;
    const wasDbOpenBeforeUs = isDatabaseOpenImpl();
    const safeCloseDatabaseImpl = wasDbOpenBeforeUs
        ? () => undefined
        : closeDatabaseImpl;
    const checks = [];
    const install = getCurrentInstallChannelImpl({ packageRoot });
    const installSupport = getInstallChannelSupportImpl(install, packageRoot);
    checks.push(createCheck('install-channel', 'Install method', install === 'unknown' ? 'warn' : 'pass', `Install method detected: ${installSupport.label}.`, install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined, install === 'unknown' ? { code: 'install-channel.unknown' } : undefined));
    const databasePath = resolveDatabasePath();
    const dbChecks = [];
    try {
        const db = openDatabaseImpl(databasePath);
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get()?.c ?? 0;
        dbChecks.push(createCheck('database', 'Database', 'pass', `Database opened successfully at ${databasePath} (${count} entities).`));
        const messageStorage = inspectAgentMessageStorage(db, databasePath, configuredAgentMessageStoragePolicy(agentMessageStoragePolicy));
        if (messageStorage)
            dbChecks.push(messageStorage);
        const hasVocab = db
            .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'fts_vocab'`)
            .get();
        if (hasVocab?.present) {
            const unsegmented = db
                .prepare(`SELECT COUNT(*) AS c FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?`)
                .get(UNSPACED_SCRIPT_GLOB_RUN3);
            if (unsegmented?.c) {
                dbChecks.push(createCheck('fts_segmentation', 'Keyword index segmentation', 'warn', `The keyword index holds ${unsegmented.c} unsegmented term(s), so some memories are only ` +
                    `findable by their exact full text. This happens when an older build wrote to a database ` +
                    `that a newer one had already migrated — the version marker only moves forward, so the ` +
                    `automatic rebuild cannot notice. Re-run doctor after the rebuild: this count should be 0.`, `Run 'memesh reindex --fts' to rebuild the keyword index.`, { code: 'fts.unsegmented', params: { count: unsegmented.c } }, 'fts-rebuild'));
            }
        }
        const pendingReindex = getPendingReindexInfo();
        const vectorDb = db;
        let missingVectors;
        let vectorsPossible = true;
        try {
            vectorsPossible = hasVectorIndex(vectorDb);
            missingVectors = vectorsPossible ? countMissingVectors(vectorDb) : 0;
        }
        catch {
            missingVectors = null;
        }
        const payableDebt = pendingReindex && !(pendingReindex.reason === 'vectors-missing' && !vectorsPossible);
        if (payableDebt || missingVectors === null || missingVectors > 0) {
            const owed = pendingReindex && pendingReindex.reason !== 'vectors-missing'
                ? 'Search index needs rebuilding (embedding configuration changed)'
                : missingVectors === null
                    ? 'The vector index could not be read, so how much of your memory semantic recall can see is unknown'
                    : `${missingVectors} memor${missingVectors === 1 ? 'y has' : 'ies have'} no search vector, `
                        + 'so semantic recall cannot find them (keyword search still works)';
            dbChecks.push(createCheck('vector_index', 'Vector Index', 'warn', owed, `Run 'memesh reindex' to fix. This will restore full search functionality.`, { code: 'vector-index.stale', params: { missing: missingVectors ?? -1 } }));
        }
        const generation = readVectorGeneration();
        if (generation.state !== 'none') {
            const staged = generationRowIds().size;
            const detail = generation.state === 'open'
                ? `${staged} vectors staged at ${generation.info.dimension} dimensions `
                    + `(provider ${generation.info.provider}, started ${generation.info.startedAt})`
                : `${staged} vectors staged, but the marker cannot be read (${generation.detail})`;
            dbChecks.push(createCheck('vector_generation', 'Half-built search index', 'warn', `An unfinished index rebuild is holding disk space: ${detail}.`, generation.state === 'open'
                ? `Run 'memesh reindex' to finish it (the vectors already produced are reused), `
                    + `or 'memesh reindex --discard-generation' to reclaim the space.`
                : `Run 'memesh reindex --discard-generation' to clear it, then 'memesh reindex'.`, { code: 'vector-generation.open', params: { staged } }));
        }
        try {
            const guardRows = db
                .prepare(`SELECT id, name, metadata FROM entities
           WHERE status = 'active'
             AND type IN ('lesson_learned', 'lesson', 'mistake')
             AND metadata LIKE '%"guard"%'`)
                .all();
            const fired = guardRows
                .filter((r) => guardFromMetadata(r.id, r.metadata) !== null)
                .map((r) => {
                let fires = 0;
                try {
                    const parsedMeta = JSON.parse(r.metadata);
                    if (typeof parsedMeta.guard?.fires === 'number')
                        fires = parsedMeta.guard.fires;
                }
                catch { }
                return { name: r.name, fires };
            })
                .sort((a, b) => b.fires - a.fires);
            if (fired.length > 0) {
                const everFired = fired.filter((g) => g.fires > 0);
                const top = everFired.slice(0, 3).map((g) => `${g.name} (${g.fires})`).join(', ');
                dbChecks.push(createInfo('guard_activity', 'Guard activity', `${fired.length} active guard(s); ${everFired.length} have ever fired`
                    + (top ? `. Most: ${top}.` : '. None has matched yet.')));
            }
        }
        catch {
        }
        const citationTotalRow = db
            .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_total'`)
            .get();
        const citedRow = db
            .prepare(`SELECT value FROM memesh_metadata WHERE key = 'citation_sessions_cited'`)
            .get();
        const citationTotal = Number.parseInt(String(citationTotalRow?.value ?? ''), 10);
        if (Number.isInteger(citationTotal) && citationTotal > 0) {
            const citedKnown = citedRow?.value !== undefined;
            const cited = Number.parseInt(String(citedRow?.value ?? ''), 10);
            const rate = citedKnown && Number.isInteger(cited)
                ? Math.round((cited / citationTotal) * 100)
                : null;
            const ruleScope = readInstallMarker()?.scope === 'project' ? 'project' : 'user';
            let rule;
            try {
                rule = citationRuleState(ruleScope, homeDir(), process.cwd(), {
                    readFileSync: readFileSyncImpl,
                });
            }
            catch {
                rule = { path: citationRulePath(ruleScope, homeDir(), process.cwd()), state: 'unreadable' };
            }
            if (rate === null) {
                dbChecks.push(createInfo('citation_compliance', 'Memory citation rate', `${citationTotal} session(s) received injected memories; how many cited one is not recorded `
                    + `(this database predates the counter that would say). The rate will be measurable from the next session on.`));
            }
            else if (rate === 0) {
                dbChecks.push(createCheck('citation_compliance', 'Memory citation rate', 'warn', `${citationTotal} session(s) received injected memories and NONE cited one. Every injection is `
                    + `costing tokens with no evidence any of it was used — and with no citations, ranking cannot `
                    + `learn which memories are worth injecting.`, rule.state === 'current'
                    ? `The citation contract is installed at ${rule.path}. If this stays at 0% across several more sessions, the injected memories are not earning their tokens — consider narrowing what is injected.`
                    : `The citation contract is ${rule.state} at ${rule.path}. Run 'memesh install-hooks' (or start a new session) to write it, then re-check after a few sessions.`, { code: 'citation.none', params: { total: citationTotal } }));
            }
            else {
                dbChecks.push(createInfo('citation_compliance', 'Memory citation rate', `${cited} of ${citationTotal} session(s) with injected memories cited at least one (${rate}%).`));
            }
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'unknown database error';
        let diagnosis;
        let fix;
        let fixId;
        if (existsSyncImpl(databasePath)) {
            try {
                const stat = statSyncImpl(databasePath);
                const canRead = !!(stat.mode & 0o400);
                const canWrite = !!(stat.mode & 0o200);
                if (!canRead || !canWrite) {
                    diagnosis = `Database file exists but has insufficient permissions (${(stat.mode & 0o777).toString(8)})`;
                    fix = `Fix permissions: chmod 600 "${databasePath}"`;
                    fixId = 'chmod-db';
                }
                else if (stat.size === 0) {
                    diagnosis = 'Database file is empty (0 bytes) — likely corrupted';
                    fix = `Delete and recreate: rm "${databasePath}" && memesh recall (will create fresh DB)`;
                }
                else {
                    diagnosis = `Database file exists (${stat.size} bytes) but cannot be opened: ${message}`;
                    fix = `Backup and reset: mv "${databasePath}" "${databasePath}.backup" && memesh recall`;
                }
            }
            catch {
                diagnosis = `Database file exists at ${databasePath} but stat() failed: ${message}`;
                fix = `Check file system integrity and permissions`;
            }
        }
        else {
            const dir = path.dirname(databasePath);
            if (!existsSyncImpl(dir)) {
                diagnosis = `Database directory does not exist: ${dir}`;
                fix = `Create directory: mkdir -p "${dir}" && memesh recall (will create fresh DB)`;
            }
            else {
                try {
                    const dirStat = statSyncImpl(dir);
                    const canWrite = !!(dirStat.mode & 0o200);
                    if (!canWrite) {
                        diagnosis = `Cannot create database — directory is not writable: ${dir}`;
                        fix = `Fix directory permissions: chmod 700 "${dir}"`;
                    }
                    else {
                        diagnosis = `Database file missing at ${databasePath}, but directory exists and is writable`;
                        fix = `Run any memesh command (e.g., memesh recall) to create a fresh database`;
                    }
                }
                catch {
                    diagnosis = `Database directory exists but cannot be accessed: ${dir}`;
                    fix = `Check directory permissions and ownership`;
                }
            }
        }
        dbChecks.length = 0;
        dbChecks.push(createCheck('database', 'Database', 'fail', diagnosis, fix, { code: 'database.broken', params: { detail: diagnosis } }, fixId));
    }
    finally {
        checks.push(...dbChecks);
        try {
            safeCloseDatabaseImpl();
        }
        catch {
        }
    }
    checks.push(inspectConfigFile(existsSyncImpl, readFileSyncImpl, getConfigPathImpl, detectCapabilitiesImpl().llm));
    checks.push(inspectMcpConfig(packageRoot, existsSyncImpl, readFileSyncImpl));
    checks.push(...inspectHooksConfig(packageRoot, platform, existsSyncImpl, readFileSyncImpl, statSyncImpl));
    const pluginHost = detectPluginHost(packageRoot);
    let codexPluginCacheDetected = pluginHost === 'codex';
    let claudePluginCacheDetected = pluginHost === 'claude-code';
    const wiring = inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), install, installedPluginsPathImpl, pluginHost);
    const pluginCache = inspectPluginCacheCurrency(install, pluginHost, packageRoot, installedPluginsPathImpl, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl);
    if (pluginCache)
        checks.push(pluginCache);
    if (install === 'npm-global') {
        const discoveredCounts = new Map();
        const discoveredPluginCaches = pluginCacheDiscoveryImpl
            ? pluginCacheDiscoveryImpl()
            : defaultPluginCacheDiscovery(readFileSyncImpl, existsSyncImpl);
        for (const discovered of discoveredPluginCaches) {
            if (discovered.host === 'codex')
                codexPluginCacheDetected = true;
            if (discovered.host === 'claude-code')
                claudePluginCacheDetected = true;
            let check = discovered.unverifiableReason
                ? pluginCacheUnverifiable(discovered.host, discovered.unverifiableReason)
                : inspectPluginCacheCurrency('plugin-marketplace', discovered.host, discovered.packageRoot, discovered.installedPluginsPath, readFileSyncImpl, existsSyncImpl, marketplaceHeadShaImpl);
            if (check && !discovered.unverifiableReason) {
                check = annotateNpmGlobalPluginCacheVersion(check, discovered.packageRoot, discovered.host === 'codex' ? 'Codex' : 'Claude Code', packageVersion);
            }
            if (check) {
                const hostName = discovered.host;
                const index = (discoveredCounts.get(discovered.host) ?? 0) + 1;
                discoveredCounts.set(discovered.host, index);
                checks.push({ ...check, id: `plugin-cache-${hostName}${index === 1 ? '' : `-${index}`}` });
            }
        }
    }
    checks.push(wiring);
    if (claudePluginCacheDetected) {
        checks.push(inspectClaudeChannelRegistration(existsSyncImpl, readFileSyncImpl));
    }
    const codexSessionSetup = inspectCodexSessionSetup(codexPluginCacheDetected, existsSyncImpl);
    if (codexSessionSetup)
        checks.push(codexSessionSetup);
    const captureWired = wiring.status === 'pass'
        && (wiring.params === undefined || wiring.params.captureWired === 1);
    checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl, captureWired));
    checks.push(inspectDashboardArtifact(packageRoot, existsSyncImpl));
    checks.push(inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl));
    checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
    checks.push(inspectShellCli(install, packageRoot, packageVersion, resolveShellMemeshImpl, existsSyncImpl, readFileSyncImpl));
    checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl, installSupport));
    checks.push(inspectMessageCapability(packageRoot, probeMessageCapability, messageCapabilityProbeImpl));
    checks.push(await inspectMessageRouterStatus(probeMessageRouterStatus, messageRouterStatusProbeImpl));
    const capabilities = detectCapabilitiesImpl();
    checks.push(createInfo('capabilities', 'Capabilities (configured)', `Search level ${capabilities.searchLevel} (${capabilities.searchLevel === 1 ? 'Smart Mode' : 'Core'}); embeddings: ${capabilities.embeddings}; LLM: ${capabilities.llm ? `${capabilities.llm.provider} (${capabilities.llm.model ?? 'default'})` : 'not configured'}. Configured values only — see the probe rows below for what actually works.`));
    if (!isTranscriptMiningEnabled()) {
        checks.push(createInfo('transcript-mining', 'Scheduled transcript mining', 'Off (opt-in). memesh can mine this project\'s Claude Code session transcripts for decisions and lessons and STAGE them for your review. Turn it on with `memesh config set transcriptMining true`, then have a scheduler (cron/launchd) run `memesh dream run --from-transcripts --if-due` — it self-throttles and stages only, so nothing enters your graph without `dream accept`.'));
    }
    else {
        const last = lastTranscriptMineAt(getProjectName(process.cwd()));
        const when = last === null
            ? 'not yet run for this project'
            : `last mined ${((Date.now() - last) / 3600_000).toFixed(1)}h ago`;
        checks.push(createInfo('transcript-mining', 'Scheduled transcript mining', `On for this project — ${when}. Have a scheduler run \`memesh dream run --from-transcripts --if-due\`; it mines when due (default every 24h) and stages proposals. Review the queue with \`memesh dream list\`.`));
    }
    checks.push(await inspectEmbeddingProbe(capabilities, probeCapabilities, embedTextImpl));
    checks.push(await inspectLlmProbe(capabilities, probeCapabilities, probeProviderImpl));
    checks.push(await inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport));
    try {
        const record = getInstallRecord();
        checks.push(createInfo('install_id', 'Install ID', `Anonymous install ID: ${record.install_id} (created ${record.created_at}). Stored locally at ${path.join(memeshDir(), 'install.json')}. Never transmitted automatically; included only in feedback issues you submit with the "Include system info" checkbox on.`));
    }
    catch {
    }
    checks.push(inspectLocaleReadmeParity(packageRoot, existsSyncImpl, readFileSyncImpl));
    if (probeHttp) {
        checks.push(await inspectHttpProbe(httpBaseUrl, fetchImpl));
    }
    return {
        status: summarizeOverallStatus(checks),
        checks,
    };
}
function iconForStatus(status) {
    switch (status) {
        case 'pass':
            return 'PASS';
        case 'warn':
            return 'WARN';
        default:
            return 'FAIL';
    }
}
export function formatDoctorReport(result, packageVersion) {
    const lines = [`MeMesh doctor v${packageVersion}`, `Overall: ${result.status}`];
    for (const check of result.checks) {
        lines.push('');
        lines.push(`[${check.informational ? 'INFO' : iconForStatus(check.status)}] ${check.label}`);
        lines.push(`  ${check.summary}`);
        if (check.fix) {
            lines.push(`  Fix: ${check.fix}`);
        }
    }
    return lines;
}
//# sourceMappingURL=doctor.js.map