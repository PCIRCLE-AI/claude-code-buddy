import { execFile, type ExecFileOptions } from 'node:child_process';
import {
  AgentNativeMessageTooLargeError,
  serializeNativeAgentMessage,
} from '../core/agent-messaging.js';
import type {
  AgentHostAdapter,
  AgentHostDispatchInput,
  AgentHostDispatchResult,
  AgentHostRegistration,
} from '../core/agent-router.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_IDENTIFIER_BYTES = 512;

export interface CodexCliQueueResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error_code?: string;
}

export type RunCodexCliQueue = (
  command: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<CodexCliQueueResult>;

export interface CodexCliQueueAdapterOptions {
  authenticate(registration: AgentHostRegistration): boolean | Promise<boolean>;
  codex_command?: string;
  timeout_ms?: number;
  run?: RunCodexCliQueue;
}

/** Queue one bounded full message into an already-running Codex CLI thread. */
export function createCodexCliQueueAdapter(options: CodexCliQueueAdapterOptions): AgentHostAdapter {
  const command = requiredIdentifier(options.codex_command ?? 'codex', 'codex_command');
  const timeoutMs = boundedTimeout(options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  const run = options.run ?? runCodexCliQueue;
  return {
    kind: 'codex-cli-queue',
    authenticate: options.authenticate,
    async dispatch(input: AgentHostDispatchInput): Promise<AgentHostDispatchResult> {
      let message: string;
      try {
        message = serializeNativeAgentMessage(input.envelope, input.dispatch_id);
      } catch (error) {
        if (error instanceof AgentNativeMessageTooLargeError) {
          return { accepted: false, receipt: { failure_code: error.code } };
        }
        throw error;
      }
      const result = await run(command, [
        'queue', '--thread', input.session_instance_id, '--message', message,
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
          message_id: input.envelope.message_id,
          delivery_id: input.dispatch_id,
        },
      };
    },
  };
}

function failureCode(result: CodexCliQueueResult): string {
  const text = `${result.error_code ?? ''} ${result.stderr}`.toLowerCase();
  if (text.includes('timedout') || text.includes('timeout')) return 'codex_queue_timeout';
  if (text.includes('no rollout found') || text.includes('not found')) return 'thread_not_found';
  if (text.includes('not allowed') || text.includes('unloaded') || text.includes('stopped')) {
    return 'thread_unavailable';
  }
  if (result.status === null) return 'codex_queue_process_failed';
  return 'codex_queue_rejected';
}

function runCodexCliQueue(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<CodexCliQueueResult> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const code = error ? (error as NodeJS.ErrnoException & { code?: unknown }).code : 0;
      resolve({
        status: typeof code === 'number' ? code : error ? null : 0,
        stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
        ...(typeof code === 'string' ? { error_code: code } : {}),
      });
    });
  });
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${field} must be a bounded non-empty string.`);
  }
  return normalized;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error('timeout_ms must be an integer between 100 and 60000.');
  }
  return value;
}
