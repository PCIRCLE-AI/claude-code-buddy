import fs from 'fs';
import path from 'path';
import { detectPluginRuntime } from './install-hooks.js';
function hasMemeshHookMarker(settingsPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        for (const entries of Object.values(parsed.hooks ?? {})) {
            if (!Array.isArray(entries))
                continue;
            for (const entry of entries) {
                for (const hook of entry.hooks ?? []) {
                    if (hook?._memesh === true)
                        return true;
                }
            }
        }
    }
    catch { }
    return false;
}
function inspectClaudeCode(seams) {
    const claudeDir = path.join(seams.home(), '.claude');
    const present = fs.existsSync(claudeDir);
    const status = {
        host: 'claude-code',
        title: 'Claude Code',
        present,
        presenceDetail: claudeDir,
        wired: null,
        wiredDetail: '',
        actions: [],
    };
    if (!present) {
        status.wiredDetail = 'not on this machine — nothing to wire';
        return status;
    }
    const plugin = detectPluginRuntime(seams.installedPluginsPath ?? path.join(claudeDir, 'plugins', 'installed_plugins.json'));
    if (plugin) {
        status.wired = true;
        status.wiredDetail = `plugin v${plugin.version} manages hooks, MCP and skills (installed_plugins.json)`;
        return status;
    }
    const settingsPath = path.join(claudeDir, 'settings.json');
    const hooksWired = hasMemeshHookMarker(settingsPath);
    let mcpWired = null;
    let mcpDetail;
    if (seams.isOnPath('claude')) {
        const probe = seams.run('claude', ['mcp', 'get', 'memesh']);
        mcpWired = probe.status === 0;
        mcpDetail = mcpWired ? 'claude mcp get memesh → registered' : 'claude mcp get memesh → not registered';
    }
    else {
        mcpDetail = 'claude CLI not on PATH — cannot probe MCP registration';
    }
    status.wired = !hooksWired ? false : mcpWired === null ? null : mcpWired;
    status.wiredDetail = `${hooksWired ? 'hooks wired (settings.json)' : 'hooks NOT wired (no _memesh marker in settings.json)'}; ${mcpDetail}`;
    if (!hooksWired) {
        status.actions.push({
            kind: 'install-hooks',
            label: 'Wire the session hooks into ~/.claude/settings.json (backs the file up first)',
        });
    }
    if (mcpWired === false) {
        status.actions.push({
            kind: 'run',
            label: 'Register the MCP server with Claude Code (user scope, all folders)',
            cmd: 'claude',
            args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
        });
    }
    return status;
}
function inspectCodex(seams) {
    const present = seams.isOnPath('codex');
    const status = {
        host: 'codex',
        title: 'Codex CLI',
        present,
        presenceDetail: 'codex on PATH',
        wired: null,
        wiredDetail: present ? '' : 'not on this machine — nothing to wire',
        actions: [],
    };
    if (!present)
        return status;
    const probe = seams.run('codex', ['mcp', 'get', 'memesh']);
    if (probe.status === null) {
        status.wiredDetail = 'codex mcp get failed to run — could not determine';
    }
    else {
        status.wired = probe.status === 0;
        status.wiredDetail = status.wired ? 'codex mcp get memesh → registered' : 'codex mcp get memesh → not registered';
        if (!status.wired) {
            status.actions.push({
                kind: 'run',
                label: 'Register the MCP server with Codex CLI',
                cmd: 'codex',
                args: ['mcp', 'add', 'memesh', '--', 'memesh-mcp'],
            });
        }
    }
    return status;
}
function inspectGemini(seams) {
    const present = seams.isOnPath('gemini');
    const status = {
        host: 'gemini',
        title: 'Gemini CLI',
        present,
        presenceDetail: 'gemini on PATH',
        wired: null,
        wiredDetail: present ? '' : 'not on this machine — nothing to wire',
        actions: [],
    };
    if (!present)
        return status;
    const settingsPath = path.join(seams.home(), '.gemini', 'settings.json');
    let wired = false;
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        wired = Boolean(parsed.mcpServers && Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'memesh'));
    }
    catch { }
    status.wired = wired;
    status.wiredDetail = wired
        ? 'mcpServers.memesh present in ~/.gemini/settings.json'
        : 'no mcpServers.memesh in ~/.gemini/settings.json';
    if (!wired) {
        status.actions.push({
            kind: 'run',
            label: 'Register the MCP server with Gemini CLI (user scope, all folders)',
            cmd: 'gemini',
            args: ['mcp', 'add', '-s', 'user', 'memesh', 'memesh-mcp'],
        });
    }
    return status;
}
export function inspectHosts(seams) {
    return [inspectClaudeCode(seams), inspectCodex(seams), inspectGemini(seams)];
}
export function allWired(statuses) {
    return statuses.every((s) => !s.present || (s.actions.length === 0 && s.wired !== false));
}
//# sourceMappingURL=setup.js.map