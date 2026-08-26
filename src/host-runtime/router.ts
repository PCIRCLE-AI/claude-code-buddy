#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../db.js';
import { AgentRouter, type AgentHostRegistration } from '../core/agent-router.js';
import { getMemeshDirFromDbPath } from '../core/paths.js';

const dataDir = getMemeshDirFromDbPath();
const socketPath = process.env.MEMESH_ROUTER_SOCKET ?? path.join(dataDir, 'agent-router.sock');
const tokenFile = process.env.MEMESH_ROUTER_TOKEN_FILE ?? path.join(dataDir, 'agent-router.token');

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
}
const tokenStat = fs.statSync(tokenFile);
if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) {
  throw new Error('The router token file must be owner-private.');
}
const expectedToken = fs.readFileSync(tokenFile, 'utf8').trim();

function authenticate(registration: AgentHostRegistration): boolean {
  if (!registration.auth_token) return false;
  const actual = Buffer.from(registration.auth_token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const router = new AgentRouter({
  db: openDatabase(),
  socket_path: socketPath,
  adapters: ['claude-channel', 'codex-app-server', 'acp'].map(kind => ({ kind, authenticate })),
});

async function shutdown(): Promise<void> {
  await router.stop();
  closeDatabase();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

router.start().catch(error => {
  process.stderr.write(`MeMesh router failed: ${error instanceof Error ? error.message : String(error)}\n`);
  closeDatabase();
  process.exit(1);
});
