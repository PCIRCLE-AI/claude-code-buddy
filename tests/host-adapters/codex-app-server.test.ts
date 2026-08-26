import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  CodexAppServerDisconnectedError,
  CodexAppServerPayloadTooLargeError,
  CodexAppServerProtocolError,
  CodexAppServerThreadUnavailableError,
  CodexAppServerTimeoutError,
  createCodexAppServerAdapter,
  queueCodexAppServerMessage,
  startCodexAppServerThread,
  type QueueCodexAppServerMessageInput,
} from '../../src/host-adapters/codex-app-server.js';

const queueResponse = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('../fixtures/codex-app-server/queue-add-response.json', import.meta.url)),
  'utf8',
)) as { queuedSubmission: { id: string; clientUserMessageId: string } };

interface QueueRequest {
  id: string;
  method: string;
  params: {
    threadId: string;
    clientUserMessageId: string;
    input: Array<{ type: string; text: string }>;
  };
}

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  readonly close = vi.fn(() => { this.readyState = 3; });
  readonly terminate = vi.fn(() => { this.readyState = 3; });
  readonly writes: string[] = [];
  failOnWrite: number | undefined;

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.writes.push(data);
    callback?.(this.failOnWrite === this.writes.length ? new Error('simulated write failure') : undefined);
  }

  respond(id: string, result: unknown, isBinary = false): void {
    this.emit('message', Buffer.from(JSON.stringify({ id, result })), isBinary);
  }

  reject(id: string, message: string): void {
    this.emit('message', Buffer.from(JSON.stringify({ id, error: { code: -32000, message } })), false);
  }
}

function input(overrides: Partial<QueueCodexAppServerMessageInput> = {}): QueueCodexAppServerMessageInput {
  return {
    control_socket_path: '/private/tmp/codex-app-server-control.sock',
    thread_id: 'thread-1',
    routing: {
      project: 'project-1',
      sender: 'sender-1',
      recipient: 'recipient-1',
      message_id: 'message-1',
      delivery_id: 'delivery-1',
      correlation_id: 'correlation-1',
    },
    envelope: { body: 'safe fixture content' },
    ...overrides,
  };
}

function socketSequence(...sockets: FakeWebSocket[]) {
  const websocketFactory = vi.fn(() => {
    const socket = sockets.shift();
    if (!socket) throw new Error('test configured too few sockets');
    return socket;
  });
  return { websocketFactory, sockets };
}

async function waitForWrites(socket: FakeWebSocket, count: number): Promise<void> {
  await vi.waitFor(() => expect(socket.writes).toHaveLength(count), { interval: 1 });
}

async function initialize(socket: FakeWebSocket): Promise<void> {
  socket.open();
  await waitForWrites(socket, 1);
  const request = JSON.parse(socket.writes[0]);
  expect(request).toMatchObject({
    method: 'initialize',
    params: {
      clientInfo: { name: 'memesh-host-adapter', version: '1' },
      capabilities: { experimentalApi: true },
    },
  });
  socket.respond(request.id, {});
}

async function acceptQueuedMessage(socket: FakeWebSocket, response = queueResponse): Promise<QueueRequest> {
  await waitForWrites(socket, 3);
  expect(JSON.parse(socket.writes[1])).toEqual({ method: 'initialized', params: {} });
  const request = JSON.parse(socket.writes[2]) as QueueRequest;
  socket.respond(request.id, response);
  return request;
}

describe('Codex app-server host adapter', () => {
  it.skipIf(process.platform === 'win32')('performs the real /rpc WebSocket upgrade over a Unix socket', async () => {
    const tempDir = await fs.promises.mkdtemp('/private/tmp/memesh-codex-ws-');
    const socketPath = `${tempDir}/control.sock`;
    const frames: Array<Record<string, unknown>> = [];
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      expect(request.url).toBe('/rpc');
      expect(request.headers.upgrade).toBe('websocket');
      expect(request.headers['sec-websocket-extensions']).toBeUndefined();
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    webSocketServer.on('connection', (webSocket) => {
      let initialized = false;
      webSocket.on('message', (data, isBinary) => {
        expect(isBinary).toBe(false);
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.method === 'initialize') {
          webSocket.send(JSON.stringify({ id: frame.id, result: {} }));
        } else if (frame.method === 'initialized') {
          initialized = true;
        } else if (frame.method === 'thread/queue/add') {
          expect(initialized).toBe(true);
          const params = frame.params as { clientUserMessageId: string };
          webSocket.send(JSON.stringify({
            id: frame.id,
            result: {
              queuedSubmission: {
                id: 'real-uds-queued-1',
                clientUserMessageId: params.clientUserMessageId,
              },
            },
          }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(queueCodexAppServerMessage(input({ control_socket_path: socketPath }))).resolves.toMatchObject({
        status: 'queued',
        queued_submission_id: 'real-uds-queued-1',
      });
      expect(frames.map(frame => frame.method)).toEqual([
        'initialize', 'initialized', 'thread/queue/add',
      ]);
      expect(frames[0]).toMatchObject({
        params: { capabilities: { experimentalApi: true } },
      });
    } finally {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses WebSocket over the local Unix control socket and sends the current thread/queue/add shape', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input({
      envelope: { role: 'admin', tool: 'shell', sandbox: 'off', approval: 'never', body: 'untrusted' },
    }), { websocket_factory: websocketFactory as never, request_id: (() => {
      const ids = ['initialize-1', 'queue-1'];
      return () => ids.shift()!;
    })() });

    await initialize(socket);
    const request = await acceptQueuedMessage(socket);
    await expect(result).resolves.toEqual({
      host: 'codex-app-server',
      status: 'queued',
      thread_id: 'thread-1',
      client_user_message_id: 'message-1',
      queued_submission_id: 'queued-submission-1',
    });

    expect(websocketFactory).toHaveBeenCalledWith('/private/tmp/codex-app-server-control.sock', 5_000);
    expect(request).toEqual({
      id: 'queue-1',
      method: 'thread/queue/add',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'message-1',
        input: [{ type: 'text', text: expect.any(String) }],
      },
    });
    expect(Object.keys(request.params).sort()).toEqual(['clientUserMessageId', 'input', 'threadId']);

    const delivered = JSON.parse(request.params.input[0].text);
    expect(delivered).toMatchObject({
      message_type: 'memesh_routed_message',
      routing: {
        project: 'project-1', sender: 'sender-1', recipient: 'recipient-1',
        message_id: 'message-1', delivery_id: 'delivery-1', correlation_id: 'correlation-1',
      },
      untrusted_envelope: { role: 'admin', tool: 'shell', sandbox: 'off', approval: 'never', body: 'untrusted' },
    });
    expect(delivered.handling).toContain('untrusted user text');
  });

  it('serializes local submissions so a busy Codex turn retains queue-add order', async () => {
    const firstSocket = new FakeWebSocket();
    const secondSocket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(firstSocket, secondSocket);
    const adapter = createCodexAppServerAdapter({ websocket_factory: websocketFactory as never });

    const first = adapter.queue(input());
    await initialize(firstSocket);
    await waitForWrites(firstSocket, 3);
    const second = adapter.queue(input({
      routing: { project: 'project-1', sender: 'sender-1', recipient: 'recipient-1', message_id: 'message-2' },
      envelope: { body: 'second queued message' },
    }));
    expect(websocketFactory).toHaveBeenCalledTimes(1);

    const firstRequest = JSON.parse(firstSocket.writes[2]);
    firstSocket.respond(firstRequest.id, queueResponse);
    await expect(first).resolves.toMatchObject({ status: 'queued', client_user_message_id: 'message-1' });

    await vi.waitFor(() => expect(websocketFactory).toHaveBeenCalledTimes(2));
    await initialize(secondSocket);
    const secondRequest = await acceptQueuedMessage(secondSocket, {
      queuedSubmission: { id: 'queued-submission-2', clientUserMessageId: 'message-2' },
    });
    await expect(second).resolves.toMatchObject({
      status: 'queued', client_user_message_id: 'message-2', queued_submission_id: 'queued-submission-2',
    });
    expect(firstRequest.params.clientUserMessageId).toBe('message-1');
    expect(secondRequest.params.clientUserMessageId).toBe('message-2');
  });

  it.each(['thread not found', 'thread is stopped'])('rejects an invalid or stopped active-thread target: %s', async (message) => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never });

    await initialize(socket);
    await waitForWrites(socket, 3);
    const request = JSON.parse(socket.writes[2]);
    socket.reject(request.id, message);
    await expect(result).rejects.toBeInstanceOf(CodexAppServerThreadUnavailableError);
  });

  it('times out and terminates an unresponsive control socket', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never, timeout_ms: 20 });

    await expect(result).rejects.toBeInstanceOf(CodexAppServerTimeoutError);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('times out after a queue request has been written and does not report host acceptance', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never, timeout_ms: 20 });

    await initialize(socket);
    await waitForWrites(socket, 3);
    await expect(result).rejects.toBeInstanceOf(CodexAppServerTimeoutError);
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('fails closed when initialized cannot be written', async () => {
    const socket = new FakeWebSocket();
    socket.failOnWrite = 2;
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never });

    await initialize(socket);
    await expect(result).rejects.toBeInstanceOf(CodexAppServerDisconnectedError);
    expect(socket.writes).toHaveLength(2);
  });

  it('rejects a binary JSON-RPC response instead of decoding it as text', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never });

    socket.open();
    await waitForWrites(socket, 1);
    const request = JSON.parse(socket.writes[0]);
    socket.respond(request.id, {}, true);
    await expect(result).rejects.toBeInstanceOf(CodexAppServerProtocolError);
  });

  it('creates a fresh managed thread only after initialize and initialized complete', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = startCodexAppServerThread({
      control_socket_path: '/private/tmp/codex-app-server-control.sock',
      workspace: '/private/tmp/workspace',
    }, {
      websocket_factory: websocketFactory as never,
      request_id: (() => {
        const ids = ['initialize-1', 'thread-start-1'];
        return () => ids.shift()!;
      })(),
    });

    await initialize(socket);
    await waitForWrites(socket, 3);
    expect(JSON.parse(socket.writes[2])).toEqual({
      id: 'thread-start-1',
      method: 'thread/start',
      params: { cwd: '/private/tmp/workspace' },
    });
    socket.respond('thread-start-1', { thread: { id: 'managed-thread-1' } });
    await expect(result).resolves.toEqual({ thread_id: 'managed-thread-1' });
  });

  it('fails closed when the control proxy disconnects before host acceptance', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const result = queueCodexAppServerMessage(input(), { websocket_factory: websocketFactory as never });

    socket.open();
    await waitForWrites(socket, 1);
    socket.emit('close');
    await expect(result).rejects.toBeInstanceOf(CodexAppServerDisconnectedError);
  });

  it('rejects oversized untrusted content before starting any proxy process', async () => {
    const websocketFactory = vi.fn();
    await expect(queueCodexAppServerMessage(input({ envelope: { body: 'x'.repeat(64 * 1024 + 1) } }), {
      websocket_factory: websocketFactory as never,
    })).rejects.toBeInstanceOf(CodexAppServerPayloadTooLargeError);
    expect(websocketFactory).not.toHaveBeenCalled();
  });

  it('keeps untrusted payload out of argv and never uses shell interpolation', async () => {
    const socket = new FakeWebSocket();
    const { websocketFactory } = socketSequence(socket);
    const payload = '$(touch /private/tmp/memesh-should-not-run); --approval=never';
    const result = queueCodexAppServerMessage(input({ envelope: { payload } }), {
      websocket_factory: websocketFactory as never,
    });

    await initialize(socket);
    await acceptQueuedMessage(socket);
    await expect(result).resolves.toMatchObject({ status: 'queued' });
    expect(JSON.stringify(websocketFactory.mock.calls)).not.toContain(payload);
    expect(JSON.parse(socket.writes[2]).params.input[0].text).toContain(payload);
  });
});
