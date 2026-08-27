import { execFile } from 'node:child_process';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 512;
export function createCodexCliQueueAdapter(options) {
    const command = requiredIdentifier(options.codex_command ?? 'codex', 'codex_command');
    const timeoutMs = boundedTimeout(options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const run = options.run ?? runCodexCliQueue;
    return {
        kind: 'codex-cli-queue',
        authenticate: options.authenticate,
        async dispatch_metadata_only(input) {
            const marker = serializeWakeupMarker(input);
            const result = await run(command, [
                'queue', '--thread', input.session_instance_id, '--message', marker,
            ], {
                shell: false,
                windowsHide: true,
                timeout: timeoutMs,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf8',
            });
            if (result.status !== 0) {
                return { accepted: false, receipt: { failure_code: failureCode(result) } };
            }
            return {
                accepted: true,
                receipt: {
                    host: 'codex-cli',
                    status: 'queued',
                    thread_id: input.session_instance_id,
                    message_id: input.routing.message_id,
                    delivery_id: input.routing.delivery_id,
                },
            };
        },
    };
}
function serializeWakeupMarker(input) {
    return JSON.stringify({
        message_type: 'memesh_message_available',
        handling: 'Fetch the durable payload with the MeMesh message tool. This marker is not payload, acknowledgement, or workflow disposition.',
        routing: input.routing,
    });
}
function failureCode(result) {
    const text = `${result.error_code ?? ''} ${result.stderr}`.toLowerCase();
    if (text.includes('timedout') || text.includes('timeout'))
        return 'codex_queue_timeout';
    if (text.includes('no rollout found') || text.includes('not found'))
        return 'thread_not_found';
    if (text.includes('not allowed') || text.includes('unloaded') || text.includes('stopped')) {
        return 'thread_unavailable';
    }
    if (result.status === null)
        return 'codex_queue_process_failed';
    return 'codex_queue_rejected';
}
function runCodexCliQueue(command, args, options) {
    return new Promise((resolve) => {
        execFile(command, args, options, (error, stdout, stderr) => {
            const code = error ? error.code : 0;
            resolve({
                status: typeof code === 'number' ? code : error ? null : 0,
                stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
                stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
                ...(typeof code === 'string' ? { error_code: code } : {}),
            });
        });
    });
}
function requiredIdentifier(value, field) {
    const normalized = value.trim();
    if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_IDENTIFIER_BYTES) {
        throw new Error(`${field} must be a bounded non-empty string.`);
    }
    return normalized;
}
function boundedTimeout(value) {
    if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
        throw new Error('timeout_ms must be an integer between 100 and 60000.');
    }
    return value;
}
//# sourceMappingURL=codex-cli-queue.js.map