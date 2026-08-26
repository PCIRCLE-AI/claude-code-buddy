#!/usr/bin/env node

import { createCodexAppServerAdapter } from '../host-adapters/codex-app-server.js';
import { connectRouterHost } from './router-client.js';
import { readHostConfig, readTokenFile, requiredString } from './config.js';

const config = readHostConfig<Record<string, unknown>>();
const adapter = createCodexAppServerAdapter();
const connection = await connectRouterHost({
  socket_path: requiredString(config.router_socket, 'router_socket'),
  auth_token: readTokenFile(config.token_file),
  identity: {
    project: requiredString(config.project, 'project'),
    principal_id: requiredString(config.principal_id, 'principal_id'),
    session_instance_id: requiredString(config.session_instance_id, 'session_instance_id'),
    adapter_kind: 'codex-app-server',
  },
  async deliver(delivery) {
    const receipt = await adapter.queue({
      control_socket_path: requiredString(config.control_socket, 'control_socket'),
      thread_id: requiredString(config.thread_id, 'thread_id'),
      routing: {
        project: delivery.envelope.project,
        sender: delivery.envelope.sender,
        recipient: delivery.envelope.recipient,
        message_id: delivery.envelope.message_id,
        delivery_id: delivery.delivery_id,
        correlation_id: delivery.envelope.correlation_id,
      },
      envelope: delivery.envelope,
    });
    return {
      host: receipt.host,
      status: receipt.status,
      thread_id: receipt.thread_id,
      client_user_message_id: receipt.client_user_message_id,
      queued_submission_id: receipt.queued_submission_id,
    };
  },
});

process.once('SIGINT', () => { void connection.close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void connection.close().finally(() => process.exit(0)); });
