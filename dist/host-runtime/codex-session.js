#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMemeshDirFromDbPath } from '../core/paths.js';
import { readHostConfigFile, readTokenFile, requiredString } from './config.js';
import { connectRouterHost } from './router-client.js';
const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function startCodexSessionCompanion(config, hookInput, environment, dependencies = {}) {
    if (hookInput.hook_event_name !== undefined && hookInput.hook_event_name !== 'SessionStart')
        return null;
    if (hookInput.source === 'compact')
        return null;
    const threadId = environment.CODEX_THREAD_ID;
    if (!threadId || !CODEX_THREAD_ID.test(threadId))
        return null;
    if (hookInput.session_id !== undefined && hookInput.session_id !== threadId)
        return null;
    const realpath = dependencies.realpath ?? fs.realpathSync;
    const workspace = realpath(requiredAbsolutePath(config.workspace, 'workspace'));
    const cwd = realpath(requiredAbsolutePath(hookInput.cwd, 'cwd'));
    if (workspace !== cwd)
        return null;
    return (dependencies.connect ?? connectRouterHost)({
        socket_path: requiredString(config.router_socket, 'router_socket'),
        auth_token: readTokenFile(config.token_file),
        identity: {
            project: requiredString(config.project, 'project'),
            principal_id: requiredString(config.principal_id, 'principal_id'),
            session_instance_id: threadId,
            adapter_kind: 'codex-cli-queue',
        },
        async deliver() {
            throw new Error('Codex CLI queue delivery must remain metadata-only inside the router.');
        },
    });
}
function requiredAbsolutePath(value, field) {
    const result = requiredString(value, field);
    if (!path.isAbsolute(result))
        throw new Error(`${field} must be an absolute path.`);
    return result;
}
async function readHookInput() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input, 'utf8') > MAX_HOOK_INPUT_BYTES) {
            throw new Error('Codex SessionStart hook input exceeds the byte limit.');
        }
    }
    const value = JSON.parse(input);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Codex SessionStart hook input must be an object.');
    }
    return value;
}
async function main() {
    const configPath = path.join(getMemeshDirFromDbPath(), 'hosts', 'codex-session.json');
    if (!fs.existsSync(configPath))
        return;
    const input = await readHookInput();
    const connection = await startCodexSessionCompanion(readHostConfigFile(configPath), input, { CODEX_THREAD_ID: process.env.CODEX_THREAD_ID });
    if (!connection)
        return;
    let closing = false;
    const close = () => {
        if (closing)
            return;
        closing = true;
        void connection.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}
function isMainModule() {
    const entrypoint = process.argv[1];
    if (!entrypoint)
        return false;
    try {
        return fs.realpathSync(entrypoint) === fs.realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isMainModule()) {
    try {
        await main();
    }
    catch {
        process.stderr.write('memesh-host-codex-session: session registration failed.\n');
        process.exitCode = 1;
    }
}
//# sourceMappingURL=codex-session.js.map