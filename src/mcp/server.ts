#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { openDatabase, closeDatabase } from '../db.js';
import { handleTool, TOOL_DEFINITIONS } from './tools.js';

const server = new Server(
  { name: 'memesh', version: '3.0.0-alpha.1' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleTool(name, args);
});

// Start
async function main() {
  openDatabase();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function shutdown() {
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('MeMesh server error:', err instanceof Error ? err.message : String(err));
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(1);
});
