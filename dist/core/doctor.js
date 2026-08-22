import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { detectCapabilities, getConfigPath, isTranscriptMiningEnabled, readConfig } from './config.js';
import { embedText } from './embedder.js';
import { probeProvider } from './llm-validator.js';
import { openDatabase, closeDatabase, getPendingReindexInfo, isDatabaseOpen, readVectorGeneration, generationRowIds, } from '../db.js';
import { getUpdateCheck } from './version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from './install-channel.js';
import { getInstallRecord } from './install-id.js';
import { getDbPath, memeshDir, getProjectName } from './paths.js';
import { detectPluginRuntime } from './install-hooks.js';
import { lastTranscriptMineAt } from './transcript-source.js';
import { UNSPACED_SCRIPT_GLOB_RUN3 } from '../storage/fts-index.js';
import { MemeshDatabase } from '../storage/sqlite.js';
import { AUTO_CAPTURE_TAG } from './types.js';
import { parseSqliteUtcMs } from './time-utils.js';
import { autoCaptureDecision } from './capture-flag.js';
const EMBEDDING_PROBE_TIMEOUT_MS = 15000;
const EXPECTED_HOOK_TYPES = ['PreToolUse', 'SessionStart', 'PostToolUse', 'Stop', 'PreCompact'];
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
    for (const filename of LOCALE_README_FILES) {
        const localePath = path.join(packageRoot, filename);
        if (!existsSyncImpl(localePath)) {
            missing.push(filename);
            continue;
        }
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
        for (const entry of entries ?? []) {
            for (const hook of entry.hooks ?? []) {
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
    const hookTypes = Object.keys(parsed.value.hooks ?? {});
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
function inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir, installChannel, installedPluginsPath) {
    const markerPath = path.join(memeshDir, 'install-hooks.json');
    if (!existsSyncImpl(markerPath)) {
        if (installChannel === 'plugin-marketplace') {
            return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'pass', 'Wired via the Claude Code plugin runtime (this is a plugin-marketplace install). The install-hooks marker is not used on this install path.');
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
        return createCheck('hook-wiring', 'Hooks wired into Claude Code', 'fail', `${marker.settings_path} is no longer valid JSON.`, 'Restore from your ~/.claude backups or re-create with `memesh install-hooks`.', { code: 'hook-wiring.settings-invalid', params: { path: String(marker.settings_path) } });
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
function inspectShellCli(installChannel, packageRoot, resolveShellMemeshImpl) {
    const shellPath = resolveShellMemeshImpl();
    const isSameAsCurrent = shellPath ? path.resolve(shellPath).startsWith(path.resolve(packageRoot)) : false;
    const hasDistinctShellCli = !!shellPath && !isSameAsCurrent;
    if (installChannel === 'npm-global') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
            ? `\`memesh\` resolves to ${shellPath} (npm-global install — terminals across the machine pick it up).`
            : 'Running from npm-global install — shell access available in this terminal.');
    }
    if (hasDistinctShellCli) {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', `\`memesh\` resolves to ${shellPath} (separate from this install at ${packageRoot}). Both paths coexist and share the same DB.`);
    }
    if (installChannel === 'plugin-marketplace') {
        return createCheck('shell-cli', 'Shell CLI on PATH', 'warn', 'Plugin is installed but `memesh` is not on the shell PATH. Typing `memesh` in a regular terminal will report `command not found`. '
            + 'Claude Code MCP / hooks / `/memesh` skill still work — this only affects standalone shell usage and other MCP clients (Cursor, Cline, etc.).', 'Run `npm install -g @pcircle/memesh` to add the shell CLI. Both paths coexist; they share the same `~/.memesh/knowledge-graph.db`.', { code: 'shell-cli.not-on-path' });
    }
    return createCheck('shell-cli', 'Shell CLI on PATH', 'pass', shellPath
        ? `\`memesh\` resolves to ${shellPath}.`
        : `No shell-PATH \`memesh\` detected. If you want terminal access, run \`npm install -g @pcircle/memesh\` (this install is a ${installChannel}, so the check is informational only).`);
}
function inspectDashboardArtifact(packageRoot, existsSyncImpl) {
    const dashboardPath = path.join(packageRoot, 'dashboard', 'dist', 'index.html');
    if (!existsSyncImpl(dashboardPath)) {
        return createCheck('dashboard', 'Dashboard artifact', 'fail', 'dashboard/dist/index.html is missing.', 'Build the dashboard with `cd dashboard && npm install && npm run build`, then run `npm run build` at the repo root if needed.', { code: 'dashboard.missing' });
    }
    return createCheck('dashboard', 'Dashboard artifact', 'pass', 'dashboard/dist/index.html is present.');
}
async function inspectUpdateStatus(packageVersion, getUpdateCheckImpl, installSupport) {
    const update = await getUpdateCheckImpl(packageVersion, { preferFresh: false });
    if (!update) {
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
        if (packageVersion < update.latestVersion) {
            return createCheck('update-status', 'Update status', 'warn', `Update available: ${update.latestVersion} (current: ${packageVersion})`, `Run 'memesh update' to upgrade`, { code: 'update-status.update-available', params: { latest: update.latestVersion, current: packageVersion } });
        }
        else {
            return createCheck('update-status', 'Update status', 'pass', `Running pre-release version (${packageVersion}), npm latest is ${update.latestVersion}`);
        }
    }
    return createCheck('update-status', 'Update status', update.freshness === 'stale' ? 'warn' : 'pass', `Version ${packageVersion} is current${update.freshness === 'stale' ? ', but cached update data is stale.' : '.'}`, update.freshness === 'stale'
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
function verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl) {
    const manifestPath = path.join(packageRoot, 'dist', 'skills-manifest.json');
    if (!existsSyncImpl(manifestPath)) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'warn', 'No skills-manifest.json found. This is normal for source checkouts — packaged installs ship the manifest.', 'Run `npm run build` to regenerate, or reinstall via `npm install -g @pcircle/memesh`.', { code: 'skills-manifest.missing-dev' });
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSyncImpl(manifestPath, 'utf8'));
    }
    catch (err) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `skills-manifest.json is unreadable (${err instanceof Error ? err.message : 'parse error'}).`, 'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem persists open an issue.', { code: 'skills-manifest.unreadable', params: { detail: err instanceof Error ? err.message : 'parse error' } });
    }
    const entries = manifest.entries ?? [];
    if (entries.length === 0) {
        return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', 'skills-manifest.json contains zero entries.', 'Reinstall the package: `npm install -g @pcircle/memesh`.', { code: 'skills-manifest.empty' });
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
    return createCheck('skills-manifest', 'Skills + hooks integrity', 'fail', `Manifest verification failed: ${detail}.`, 'Reinstall the package: `npm install -g @pcircle/memesh`. If the problem reproduces on a fresh install, open a security issue at https://github.com/PCIRCLE-AI/memesh/security.', { code: 'skills-manifest.verify-failed', params: { detail } });
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
    const { packageRoot, packageVersion, probeHttp = false, probeCapabilities = false, embedTextImpl = embedText, probeProviderImpl = probeProvider, httpBaseUrl = 'http://127.0.0.1:3737', platform = process.platform, openDatabaseImpl = openDatabase, closeDatabaseImpl = closeDatabase, isDatabaseOpenImpl = isDatabaseOpen, detectCapabilitiesImpl = detectCapabilities, getConfigPathImpl = getConfigPath, getUpdateCheckImpl = getUpdateCheck, getCurrentInstallChannelImpl = getCurrentInstallChannel, installedPluginsPathImpl, getInstallChannelSupportImpl = getInstallChannelSupport, existsSyncImpl = fs.existsSync, readFileSyncImpl = fs.readFileSync, statSyncImpl = fs.statSync, fetchImpl = fetch, nativeBindingProbeImpl, resolveShellMemeshImpl = defaultResolveShellMemesh, } = options;
    const wasDbOpenBeforeUs = isDatabaseOpenImpl();
    const safeCloseDatabaseImpl = wasDbOpenBeforeUs
        ? () => undefined
        : closeDatabaseImpl;
    const checks = [];
    const install = getCurrentInstallChannelImpl({ packageRoot });
    const installSupport = getInstallChannelSupportImpl(install);
    checks.push(createCheck('install-channel', 'Install method', install === 'unknown' ? 'warn' : 'pass', `Install method detected: ${installSupport.label}.`, install === 'unknown'
        ? 'If this is a source checkout, run MeMesh from the repo root. If this is a packaged install, reinstall with `npm install -g @pcircle/memesh`.'
        : undefined, install === 'unknown' ? { code: 'install-channel.unknown' } : undefined));
    const databasePath = resolveDatabasePath();
    const dbChecks = [];
    try {
        const db = openDatabaseImpl(databasePath);
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get()?.c ?? 0;
        dbChecks.push(createCheck('database', 'Database', 'pass', `Database opened successfully at ${databasePath} (${count} entities).`));
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
        if (pendingReindex) {
            const owed = pendingReindex.reason === 'vectors-missing'
                ? 'Some memories have no search vector'
                : 'Search index needs rebuilding (embedding configuration changed)';
            dbChecks.push(createCheck('vector_index', 'Vector Index', 'warn', owed, `Run 'memesh reindex' to fix. This will restore full search functionality.`, { code: 'vector-index.stale' }));
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
    const wiring = inspectHookWiring(existsSyncImpl, readFileSyncImpl, memeshDir(), install, installedPluginsPathImpl);
    checks.push(wiring);
    const captureWired = wiring.status === 'pass'
        && (wiring.params === undefined || wiring.params.captureWired === 1);
    checks.push(inspectHookActivity(openDatabaseImpl, safeCloseDatabaseImpl, existsSyncImpl, statSyncImpl, captureWired));
    checks.push(inspectDashboardArtifact(packageRoot, existsSyncImpl));
    checks.push(inspectNodeRuntime(packageRoot, existsSyncImpl, readFileSyncImpl));
    checks.push(inspectNativeBinding(packageRoot, existsSyncImpl, nativeBindingProbeImpl));
    checks.push(inspectShellCli(install, packageRoot, resolveShellMemeshImpl));
    checks.push(verifySkillsManifest(packageRoot, existsSyncImpl, readFileSyncImpl));
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
        checks.push(createCheck('install_id', 'Install ID', 'pass', `Anonymous install ID: ${record.install_id} (created ${record.created_at}). Stored locally at ~/.memesh/install.json. Never transmitted automatically; included only in feedback issues you submit with the "Include system info" checkbox on.`));
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