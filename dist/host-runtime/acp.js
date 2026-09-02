#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClientHostAdapter, } from '../host-adapters/acp-client.js';
import { assertSecureLocalHostRuntimeSupported, optionalStringArray, readHostConfig, readTokenFile, requiredString, } from './config.js';
import { runHostEntry } from './entry.js';
export const ACP_SESSION_UPDATE_MAX_RECORD_BYTES = 64 * 1024;
export const ACP_SESSION_UPDATE_MAX_FILE_BYTES = 1024 * 1024;
export const ACP_SESSION_UPDATE_MAX_RECORDS = 1024;
const ACP_SESSION_UPDATE_PREVIEW_BYTES = 8 * 1024;
const GEMINI_MANAGED_FLAG = '--acp';
const GEMINI_UNMANAGED_SESSION_FLAGS = [
    '--experimental-acp',
    '--no-acp',
    '--prompt',
    '--prompt-interactive',
    '--resume',
    '--session-file',
    '--session-id',
];
const GEMINI_UNMANAGED_SHORT_FLAGS = ['-i', '-p', '-r'];
const ACP_ACCEPTED_STOP_REASONS = new Set(['cancelled', 'end_turn', 'max_tokens', 'max_turn_requests', 'refusal']);
export function createAcpSessionUpdateSink(configuredPath) {
    if (configuredPath === undefined)
        return undefined;
    assertSecureLocalHostRuntimeSupported();
    const outputPath = path.resolve(requiredString(configuredPath, 'session_update_file'));
    const parentPath = path.dirname(outputPath);
    const parentStat = fs.lstatSync(parentPath);
    assertOwnerPrivate(parentStat, 'session update parent directory');
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error('The session update parent must be a real owner-private directory.');
    }
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error('This platform cannot safely reject a symlink session update file.');
    }
    let descriptor;
    try {
        try {
            descriptor = fs.openSync(outputPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
        }
        catch (error) {
            if (isFileSystemError(error, 'ELOOP')) {
                throw new Error('The session update file must be a real owner-private regular file.', { cause: error });
            }
            throw error;
        }
        const opened = fs.fstatSync(descriptor);
        assertSafeOutputFile(opened);
        const linked = fs.lstatSync(outputPath);
        if (linked.isSymbolicLink() || linked.dev !== opened.dev || linked.ino !== opened.ino) {
            throw new Error('The session update file changed while it was opened.');
        }
        const existing = fs.readFileSync(descriptor);
        const state = validateExistingJsonl(existing);
        let fileBytes = existing.byteLength;
        let recordCount = state.recordCount;
        let closed = false;
        const sinkDescriptor = descriptor;
        descriptor = undefined;
        return {
            write(update) {
                if (closed || recordCount >= ACP_SESSION_UPDATE_MAX_RECORDS)
                    return;
                const record = boundedSessionUpdateRecord(update);
                if (fileBytes + record.byteLength > ACP_SESSION_UPDATE_MAX_FILE_BYTES)
                    return;
                writeAll(sinkDescriptor, record);
                fileBytes += record.byteLength;
                recordCount += 1;
            },
            close() {
                if (closed)
                    return;
                closed = true;
                fs.closeSync(sinkDescriptor);
            },
        };
    }
    catch (error) {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        throw error;
    }
}
function isFileSystemError(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function assertSafeOutputFile(stat) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('The session update file must be a real owner-private regular file.');
    }
    assertOwnerPrivate(stat, 'session update file');
    if (stat.nlink !== 1) {
        throw new Error('The session update file must not have additional hard links.');
    }
}
function assertOwnerPrivate(stat, label) {
    if ((stat.mode & 0o077) !== 0) {
        throw new Error(`The ${label} must be owner-private.`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`The ${label} must be owned by the current user.`);
    }
}
function validateExistingJsonl(content) {
    if (content.byteLength > ACP_SESSION_UPDATE_MAX_FILE_BYTES) {
        throw new Error('The session update file already exceeds its byte limit.');
    }
    if (content.byteLength === 0)
        return { recordCount: 0 };
    if (content[content.byteLength - 1] !== 0x0a) {
        throw new Error('The existing session update file is not newline-terminated JSONL.');
    }
    const lines = content.toString('utf8').split('\n').slice(0, -1);
    if (lines.length > ACP_SESSION_UPDATE_MAX_RECORDS) {
        throw new Error('The session update file already exceeds its record limit.');
    }
    for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') + 1 > ACP_SESSION_UPDATE_MAX_RECORD_BYTES) {
            throw new Error('The session update file contains an oversized record.');
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error('The existing session update file contains invalid JSONL.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('The existing session update file contains a non-object record.');
        }
    }
    return { recordCount: lines.length };
}
function boundedSessionUpdateRecord(update) {
    const complete = Buffer.from(`${JSON.stringify(update)}\n`, 'utf8');
    if (complete.byteLength <= ACP_SESSION_UPDATE_MAX_RECORD_BYTES)
        return complete;
    const preview = complete.subarray(0, ACP_SESSION_UPDATE_PREVIEW_BYTES).toString('utf8');
    const bounded = Buffer.from(`${JSON.stringify({
        sessionId: update.sessionId,
        update: {
            sessionUpdate: typeof update.update.sessionUpdate === 'string'
                ? update.update.sessionUpdate
                : 'oversized',
            truncated: true,
            original_bytes: complete.byteLength - 1,
            preview,
        },
    })}\n`, 'utf8');
    if (bounded.byteLength > ACP_SESSION_UPDATE_MAX_RECORD_BYTES) {
        throw new Error('The bounded ACP session update record exceeded its fixed limit.');
    }
    return bounded;
}
function writeAll(descriptor, value) {
    let offset = 0;
    while (offset < value.byteLength) {
        const written = fs.writeSync(descriptor, value, offset, value.byteLength - offset, null);
        if (written <= 0)
            throw new Error('The ACP session update record could not be written.');
        offset += written;
    }
}
export function resolveManagedAcpLaunch(config, createSessionInstanceId = randomUUID) {
    const configuredArgs = optionalStringArray(config.args, 'args');
    const args = configuredArgs.filter((arg) => arg !== GEMINI_MANAGED_FLAG);
    for (const arg of args) {
        if (arg.startsWith(`${GEMINI_MANAGED_FLAG}=`)
            || GEMINI_UNMANAGED_SESSION_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
            || GEMINI_UNMANAGED_SHORT_FLAGS.some((flag) => arg === flag || arg.startsWith(flag))) {
            throw new Error(`Gemini argument ${arg} is not allowed for a MeMesh-managed ACP session.`);
        }
    }
    const sessionInstanceId = config.session_instance_id === undefined
        ? requiredString(createSessionInstanceId(), 'generated session_instance_id')
        : requiredString(config.session_instance_id, 'session_instance_id');
    const session = config.acp_session_id === undefined
        ? { kind: 'new' }
        : {
            kind: 'load',
            acp_session_id: requiredString(config.acp_session_id, 'acp_session_id'),
        };
    return Object.freeze({
        command: requiredString(config.command ?? 'gemini', 'command'),
        args: Object.freeze([GEMINI_MANAGED_FLAG, ...args]),
        principal_id: requiredString(config.principal_id, 'principal_id'),
        session_instance_id: sessionInstanceId,
        workspace: requiredString(config.workspace, 'workspace'),
        session: Object.freeze(session),
    });
}
export async function startManagedAcpHost(config, dependencies) {
    assertSecureLocalHostRuntimeSupported();
    const launch = resolveManagedAcpLaunch(config, dependencies.create_session_instance_id ?? randomUUID);
    const socketPath = requiredString(config.router_socket, 'router_socket');
    const project = requiredString(config.project, 'project');
    const authToken = readTokenFile(config.token_file);
    const model = config.model === undefined ? undefined : requiredString(config.model, 'model');
    const workSummary = config.work_summary === undefined ? undefined : requiredString(config.work_summary, 'work_summary');
    const sessionUpdateSink = createAcpSessionUpdateSink(config.session_update_file);
    const connectAcpHost = dependencies.connect_acp_host
        ?? ((options) => AcpClientHostAdapter.connect(options));
    let routerConnection;
    let adapter;
    async function closeRouterConnection() {
        const connection = routerConnection;
        routerConnection = undefined;
        await connection?.close();
    }
    try {
        adapter = await connectAcpHost({
            command: launch.command,
            args: launch.args,
            principal_id: launch.principal_id,
            session_instance_id: launch.session_instance_id,
            generation: 1,
            workspace: launch.workspace,
            session: launch.session,
            ...(sessionUpdateSink ? { onSessionUpdate: sessionUpdateSink.write } : {}),
            router: {
                async register(registration) {
                    assertExactManagedIdentity(registration, launch);
                    routerConnection = await dependencies.connect_router_host({
                        socket_path: socketPath,
                        auth_token: authToken,
                        identity: {
                            project,
                            principal_id: registration.principal_id,
                            session_instance_id: registration.session_instance_id,
                            adapter_kind: 'acp',
                            ...(model === undefined ? {} : { model }),
                            ...(workSummary === undefined ? {} : { work_summary: workSummary }),
                        },
                        async deliver(delivery) {
                            const receipt = await registration.deliver({
                                envelope: JSON.parse(JSON.stringify(delivery.envelope)),
                                generation: delivery.generation,
                            });
                            assertAcceptedAcpReceipt(receipt, registration.acp_session_id);
                            return {
                                host: receipt.host,
                                acp_session_id: receipt.acp_session_id,
                                accepted: receipt.accepted,
                                stop_reason: receipt.stop_reason,
                            };
                        },
                    });
                    return {
                        generation: routerConnection.generation,
                        unregister: closeRouterConnection,
                    };
                },
            },
        });
    }
    catch (error) {
        try {
            await adapter?.close();
            await closeRouterConnection();
        }
        finally {
            sessionUpdateSink?.close();
        }
        throw error;
    }
    const activeAdapter = adapter;
    let closePromise;
    const close = () => {
        closePromise ??= closeManagedAcpHost(activeAdapter, closeRouterConnection, sessionUpdateSink);
        return closePromise;
    };
    return Object.freeze({
        principal_id: launch.principal_id,
        session_instance_id: launch.session_instance_id,
        acp_session_id: activeAdapter.acp_session_id,
        close,
    });
}
function assertExactManagedIdentity(registration, launch) {
    if (registration.principal_id !== launch.principal_id
        || registration.session_instance_id !== launch.session_instance_id
        || registration.generation !== 1
        || registration.workspace !== launch.workspace
        || registration.host !== 'acp') {
        throw new Error('ACP adapter registration did not preserve the exact managed session identity.');
    }
    requiredString(registration.acp_session_id, 'ACP session id');
}
function assertAcceptedAcpReceipt(receipt, acpSessionId) {
    if (receipt.host !== 'acp'
        || receipt.acp_session_id !== acpSessionId
        || receipt.accepted !== true
        || !ACP_ACCEPTED_STOP_REASONS.has(receipt.stop_reason)) {
        throw new Error('ACP delivery did not produce an exact accepted-session receipt.');
    }
}
async function closeManagedAcpHost(adapter, closeRouterConnection, sessionUpdateSink) {
    let failure;
    try {
        await adapter.close();
    }
    catch (error) {
        failure = error;
    }
    try {
        await closeRouterConnection();
    }
    catch (error) {
        failure ??= error;
    }
    finally {
        sessionUpdateSink?.close();
    }
    if (failure !== undefined)
        throw failure;
}
async function runAcpHost() {
    const config = readHostConfig();
    const routerClientModule = './router-client.js';
    const { connectRouterHost } = await import(routerClientModule);
    const runtime = await startManagedAcpHost(config, {
        connect_router_host: connectRouterHost,
    });
    process.once('SIGINT', () => { void runtime.close().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void runtime.close().finally(() => process.exit(0)); });
}
const entryPath = process.argv[1];
if (entryPath && isExecutedModule(entryPath, import.meta.url)) {
    process.exitCode = await runHostEntry('memesh-host-acp', runAcpHost);
}
function isExecutedModule(entryPath, moduleUrl) {
    try {
        return fs.realpathSync(entryPath) === fs.realpathSync(fileURLToPath(moduleUrl));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=acp.js.map