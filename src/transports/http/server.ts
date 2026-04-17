#!/usr/bin/env node

import express from 'express';
import { openDatabase, closeDatabase } from '../../db.js';
import { remember, recall, forget } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { getDatabase } from '../../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../package.json'
);
const packageVersion =
  JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? '0.0.0';

const app = express();
app.use(express.json());

// --- Health ---
app.get('/v1/health', (_req, res) => {
  try {
    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as any;
    res.json({ success: true, data: { status: 'ok', version: packageVersion, entity_count: count.c } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Remember ---
app.post('/v1/remember', (req, res) => {
  try {
    const result = remember(req.body);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Recall ---
app.post('/v1/recall', (req, res) => {
  try {
    const entities = recall(req.body);
    res.json({ success: true, data: entities });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Forget ---
app.post('/v1/forget', (req, res) => {
  try {
    const result = forget(req.body);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- List entities ---
app.get('/v1/entities', (req, res) => {
  try {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const limit = parseInt(req.query.limit as string) || 20;
    const includeArchived = req.query.status === 'all';
    const entities = kg.listRecent(limit, includeArchived);
    res.json({ success: true, data: entities });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Get single entity ---
app.get('/v1/entities/:name', (req, res) => {
  try {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const entity = kg.getEntity(req.params.name);
    if (!entity) {
      res.status(404).json({ success: false, error: `Entity "${req.params.name}" not found` });
      return;
    }
    res.json({ success: true, data: entity });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start server ---
const HOST = process.env.MEMESH_HTTP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MEMESH_HTTP_PORT || '3737');

export function startServer(host = HOST, port = PORT): ReturnType<typeof app.listen> {
  openDatabase();
  const server = app.listen(port, host, () => {
    console.log(`MeMesh HTTP server running at http://${host}:${port}`);
  });
  return server;
}

// If run directly (not imported)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.endsWith('memesh-http')) {
  const server = startServer();

  function shutdown() {
    server.close();
    try { closeDatabase(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { app };  // for testing
