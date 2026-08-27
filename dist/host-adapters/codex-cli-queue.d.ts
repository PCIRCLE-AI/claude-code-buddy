import { type ExecFileOptions } from 'node:child_process';
import type { AgentHostAdapter, AgentHostRegistration } from '../core/agent-router.js';
export interface CodexCliQueueResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error_code?: string;
}
export type RunCodexCliQueue = (command: string, args: string[], options: ExecFileOptions) => Promise<CodexCliQueueResult>;
export interface CodexCliQueueAdapterOptions {
    authenticate(registration: AgentHostRegistration): boolean | Promise<boolean>;
    codex_command?: string;
    timeout_ms?: number;
    run?: RunCodexCliQueue;
}
export declare function createCodexCliQueueAdapter(options: CodexCliQueueAdapterOptions): AgentHostAdapter;
//# sourceMappingURL=codex-cli-queue.d.ts.map