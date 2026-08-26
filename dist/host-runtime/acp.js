#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClientHostAdapter, } from '../host-adapters/acp-client.js';
import { optionalStringArray, readHostConfig, readTokenFile, requiredString } from './config.js';
export const ACP_SESSION_UPDATE_MAX_RECORD_BYTES = 64 * 1024;
export const ACP_SESSION_UPDATE_MAX_FILE_BYTES = 1024 * 1024;
export const ACP_SESSION_UPDATE_MAX_RECORDS = 1024;
const ACP_SESSION_UPDATE_PREVIEW_BYTES = 8 * 1024;
export function createAcpSessionUpdateSink(configuredPath) {
    if (configuredPath === undefined)
        return undefined;
    const outputPath = path.resolve(requiredString(configuredPath, 'session_update_file'));
    const parentPath = path.dirname(outputPath);
    const parentStat = fs.lstatSync(parentPath);
    assertOwnerPrivate(parentStat, 'session update parent directory');
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        throw new Error('The session update parent must be a real owner-private directory.');
    }
    const beforeOpen = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    if (beforeOpen)
        assertSafeOutputFile(beforeOpen);
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error('This platform cannot safely reject a symlink session update file.');
    }
    let descriptor;
    try {
        descriptor = fs.openSync(outputPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
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
async function runAcpHost() {
    const config = readHostConfig();
    const sessionUpdateSink = createAcpSessionUpdateSink(config.session_update_file);
    const routerClientModule = './router-client.js';
    const { connectRouterHost } = await import(routerClientModule);
    let routerConnection;
    let adapter;
    try {
        adapter = await AcpClientHostAdapter.connect({
            command: requiredString(config.command ?? 'gemini', 'command'),
            args: optionalStringArray(config.args ?? ['--acp'], 'args'),
            principal_id: requiredString(config.principal_id, 'principal_id'),
            session_instance_id: requiredString(config.session_instance_id, 'session_instance_id'),
            generation: 1,
            workspace: requiredString(config.workspace, 'workspace'),
            ...(sessionUpdateSink ? { onSessionUpdate: sessionUpdateSink.write } : {}),
            router: {
                async register(registration) {
                    routerConnection = await connectRouterHost({
                        socket_path: requiredString(config.router_socket, 'router_socket'),
                        auth_token: readTokenFile(config.token_file),
                        identity: {
                            project: requiredString(config.project, 'project'),
                            principal_id: registration.principal_id,
                            session_instance_id: registration.session_instance_id,
                            adapter_kind: 'acp',
                        },
                        async deliver(delivery) {
                            const receipt = await registration.deliver({
                                envelope: JSON.parse(JSON.stringify(delivery.envelope)),
                                generation: delivery.generation,
                            });
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
                        unregister: () => routerConnection?.close(),
                    };
                },
            },
        });
    }
    catch (error) {
        sessionUpdateSink?.close();
        throw error;
    }
    async function shutdown() {
        try {
            await adapter.close();
            await routerConnection?.close();
        }
        finally {
            sessionUpdateSink?.close();
        }
    }
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}
const entryPath = process.argv[1];
if (entryPath && isExecutedModule(entryPath, import.meta.url)) {
    await runAcpHost();
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