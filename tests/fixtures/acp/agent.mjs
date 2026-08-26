import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const sessionId = mode === 'load' ? 'fixture-loaded-session' : 'fixture-session';
let activePrompt = null;
let promptSequence = 0;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function notify(update, targetSessionId = sessionId) {
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: targetSessionId, update },
  });
}

function finishPrompt(stopReason = 'end_turn') {
  if (!activePrompt) return;
  const current = activePrompt;
  activePrompt = null;
  if (current.timer) clearTimeout(current.timer);
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `finish:${current.sequence}` } });
  respond(current.id, { stopReason });
}

async function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    if (String(message.id).startsWith('permission-')) {
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `permission:${JSON.stringify(message.result)}` },
      });
    }
    return;
  }

  if (message.method === 'initialize') {
    if (mode === 'hang-initialize') return;
    if (mode === 'bad-frame') {
      process.stdout.write(`${'x'.repeat(4096)}\n`);
      return;
    }
    respond(message.id, {
      protocolVersion: mode === 'protocol-mismatch' ? 2 : 1,
      agentCapabilities: {
        loadSession: mode !== 'no-load',
        promptCapabilities: {},
      },
      agentInfo: { name: 'fixture-acp-agent', title: 'Fixture ACP Agent', version: '1.0.0' },
      authMethods: [],
    });
    return;
  }

  if (message.method === 'session/new') {
    respond(message.id, { sessionId });
    return;
  }

  if (message.method === 'session/load') {
    notify({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'fixture replay' },
    }, message.params.sessionId);
    respond(message.id, {});
    return;
  }

  if (message.method === 'session/prompt') {
    if (mode === 'exit-on-prompt') {
      process.exit(23);
      return;
    }
    promptSequence += 1;
    const sequence = promptSequence;
    const promptText = message.params.prompt[0].text;
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `start:${sequence}` } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: promptText } });
    notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `argv:${JSON.stringify(process.argv.slice(2))}` },
    });
    if (mode === 'permission') {
      write({
        jsonrpc: '2.0',
        id: `permission-${sequence}`,
        method: 'session/request_permission',
        params: {
          sessionId,
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          toolCall: { toolCallId: `tool-${sequence}` },
        },
      });
    }
    if (mode === 'hang-prompt' || mode === 'cancel') {
      activePrompt = { id: message.id, sequence, timer: null };
      return;
    }
    const delay = mode === 'busy' && sequence === 1 ? 80 : 5;
    activePrompt = {
      id: message.id,
      sequence,
      timer: setTimeout(() => finishPrompt(), delay),
    };
    return;
  }

  if (message.method === 'session/cancel') {
    finishPrompt('cancelled');
    return;
  }

}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(2);
    return;
  }
  void handle(message);
});
