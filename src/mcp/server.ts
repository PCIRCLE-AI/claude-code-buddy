#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase } from '../db.js';
import { handleTool, TOOL_DEFINITIONS } from './tools.js';
import { logCapabilities } from '../core/config.js';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../package.json'
);
const packageVersion =
  JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? '0.0.0';

const server = new Server(
  { name: 'memesh', version: packageVersion },
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
  logCapabilities();
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
