import { describe, expect, it, vi } from 'vitest';
import {
  createCodexCliQueueAdapter,
  type RunCodexCliQueue,
} from '../../src/host-adapters/codex-cli-queue.js';
import type { AgentHostDispatchInput } from '../../src/core/agent-router.js';

function dispatchInput(): AgentHostDispatchInput {
  return {
    dispatch_id: 'delivery-1',
    attempt_id: 'attempt-1',
    project: 'project-1',
    principal_id: 'principal-1',
    session_instance_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
    connection_id: 'connection-1',
    generation: 1,
    hops: 1,
    untrusted_payload: true,
    envelope: {
      message_id: 'message-1',
      project: 'project-1',
      sender: 'sender-1',
      sender_host: 'claude-code',
      recipient: 'principal-1',
      target_kind: 'session',
      content_type: 'application/json',
      correlation_id: 'correlation-1',
      reply_to: null,
      privacy: 'private',
      created_at: '2026-08-31T00:00:00.000Z',
      payload: { text: 'payload-reaches-native-thread' },
      provenance: { transport: 'mcp' },
    },
  };
}

describe('Codex CLI queue adapter', () => {
  it('queues one bounded full message with shell disabled', async () => {
    const run = vi.fn<RunCodexCliQueue>(async () => ({
      status: 0, stdout: 'Queued message queue-id\n', stderr: '',
    }));
    const adapter = createCodexCliQueueAdapter({ authenticate: () => true, run });

    await expect(adapter.dispatch!(dispatchInput())).resolves.toEqual({
      accepted: true,
      receipt: {
        host: 'codex-cli', status: 'queued',
        thread_id: '01a041b4-5c67-75b3-9505-4e33d7942b8e',
        message_id: 'message-1', delivery_id: 'delivery-1',
      },
    });

    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe('codex');
    expect(args.slice(0, 4)).toEqual([
      'queue', '--thread', '01a041b4-5c67-75b3-9505-4e33d7942b8e', '--message',
    ]);
    expect(options).toMatchObject({ shell: false, timeout: 5_000 });
    expect(JSON.parse(args[4])).toEqual({
      message_type: 'memesh_message',
      handling: expect.stringContaining('No inbox fetch is required'),
      delivery_id: 'delivery-1',
      envelope: dispatchInput().envelope,
    });
    expect(args[4]).toContain('sender-1');
    expect(args[4]).toContain('payload-reaches-native-thread');
  });

  it.each([
    [{ status: 1, stdout: '', stderr: 'No rollout found for thread' }, 'thread_not_found'],
    [{ status: 1, stdout: '', stderr: 'direct input is not allowed for unloaded spawned subagents' }, 'thread_unavailable'],
    [{ status: null, stdout: '', stderr: '', error_code: 'ETIMEDOUT' }, 'codex_queue_timeout'],
    [{ status: null, stdout: '', stderr: '', error_code: 'ENOENT' }, 'codex_queue_process_failed'],
  ])('fails closed without host acceptance: %j', async (result, failureCode) => {
    const adapter = createCodexCliQueueAdapter({
      authenticate: () => true,
      run: async () => result,
    });
    await expect(adapter.dispatch!(dispatchInput())).resolves.toEqual({
      accepted: false,
      receipt: { failure_code: failureCode },
    });
  });

  it('rejects an oversized native message before invoking Codex', async () => {
    const run = vi.fn<RunCodexCliQueue>();
    const adapter = createCodexCliQueueAdapter({ authenticate: () => true, run });
    const input = dispatchInput();
    input.envelope.payload = 'x'.repeat(17 * 1024);

    await expect(adapter.dispatch!(input)).resolves.toEqual({
      accepted: false,
      receipt: { failure_code: 'native_message_too_large' },
    });
    expect(run).not.toHaveBeenCalled();
  });
});
