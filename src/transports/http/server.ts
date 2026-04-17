#!/usr/bin/env node

import express from 'express';
import { z } from 'zod';
import { openDatabase, closeDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { getDatabase } from '../../db.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities } from '../../core/config.js';
import type { CountRow } from '../../core/types.js';
import {
  RememberSchema as RememberBody, RecallSchema as RecallBody,
  ForgetSchema as ForgetBody, ConsolidateSchema as ConsolidateBody,
  ExportSchema as ExportBody, ImportSchema as ImportBody,
  LearnSchema as LearnBody,
} from '../schemas.js';

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
app.use(express.json({ limit: '1mb' }));

// --- Rate limiting (in-memory, no external deps) ---
const rateLimitWindowMs = 60_000; // 1 minute
const rateLimitMax = 120; // max requests per window per IP
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

app.use((req, res, next) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + rateLimitWindowMs };
    rateLimitStore.set(ip, entry);
  }
  entry.count++;
  res.setHeader('X-RateLimit-Limit', String(rateLimitMax));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rateLimitMax - entry.count)));
  if (entry.count > rateLimitMax) {
    res.status(429).json({ success: false, error: 'Too many requests. Try again in 1 minute.' });
    return;
  }
  next();
});

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 300_000).unref();

// --- Dashboard ---
app.get('/dashboard', (_req, res) => {
  // Serve Preact SPA build (preferred)
  const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dashboard/dist/index.html');
  if (fs.existsSync(dashboardPath)) {
    res.type('html').sendFile(dashboardPath);
  } else {
    // Fallback to legacy template
    import('../../cli/view.js')
      .then(m => res.type('html').send(m.generateLiveDashboardHtml()))
      .catch(() => res.status(500).send('Dashboard unavailable'));
  }
});

// --- Health ---
app.get('/v1/health', (_req, res) => {
  try {
    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get() as CountRow;
    res.json({ success: true, data: { status: 'ok', version: packageVersion, entity_count: count.c } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Remember ---
app.post('/v1/remember', (req, res) => {
  const parsed = RememberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = remember(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Recall ---
app.post('/v1/recall', async (req, res) => {
  const parsed = RecallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    // recallEnhanced: uses LLM query expansion when configured, falls back otherwise
    const entities = await recallEnhanced(parsed.data);
    const kg = new KnowledgeGraph(getDatabase());
    const conflicts = kg.findConflicts(entities.map(e => e.name));
    if (conflicts.length > 0) {
      res.json({ success: true, data: { entities, conflicts } });
    } else {
      res.json({ success: true, data: entities });
    }
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Forget ---
app.post('/v1/forget', (req, res) => {
  const parsed = ForgetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = forget(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Consolidate ---
app.post('/v1/consolidate', async (req, res) => {
  const parsed = ConsolidateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = await consolidate(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Export ---
app.post('/v1/export', (req, res) => {
  const parsed = ExportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = exportMemories(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Import ---
app.post('/v1/import', (req, res) => {
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = importMemories(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Learn ---
app.post('/v1/learn', (req, res) => {
  const parsed = LearnBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const result = learn(parsed.data);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Config ---
app.get('/v1/config', (_req, res) => {
  try {
    const config = readConfig();
    const caps = detectCapabilities(config);
    const safeConfig = { ...config };
    if (safeConfig.llm?.apiKey) {
      safeConfig.llm = { ...safeConfig.llm, apiKey: '***' };
    }
    // Also mask API key in capabilities (detectCapabilities returns llm config with raw key)
    if (caps.llm?.apiKey) {
      caps.llm = { ...caps.llm, apiKey: '***' };
    }
    res.json({ success: true, data: { config: safeConfig, capabilities: caps } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const ConfigBody = z.object({
  llm: z.object({
    provider: z.enum(['anthropic', 'openai', 'ollama']),
    model: z.string().optional(),
    apiKey: z.string().optional(),
  }).optional(),
  autoCapture: z.boolean().optional(),
  sessionLimit: z.number().int().min(1).max(100).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  setupCompleted: z.boolean().optional(),
}).passthrough();

app.post('/v1/config', (req, res) => {
  const parsed = ConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    const updated = updateConfig(parsed.data);
    // Mask API key before returning
    const safeUpdated = { ...updated };
    if (safeUpdated.llm?.apiKey) {
      safeUpdated.llm = { ...safeUpdated.llm, apiKey: '***' };
    }
    res.json({ success: true, data: safeUpdated });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Graph data (entities + relations) ---
app.get('/v1/graph', (_req, res) => {
  try {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const entities = kg.listRecent(500, true); // include archived

    // Get all relations with entity names
    const relations = db.prepare(`
      SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
      FROM relations r
      JOIN entities e_from ON r.from_entity_id = e_from.id
      JOIN entities e_to ON r.to_entity_id = e_to.id
    `).all();

    res.json({ success: true, data: { entities, relations } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Stats ---
app.get('/v1/stats', (_req, res) => {
  try {
    const db = getDatabase();
    const entities = db.prepare('SELECT COUNT(*) as c FROM entities').get() as CountRow;
    const observations = db.prepare('SELECT COUNT(*) as c FROM observations').get() as CountRow;
    const relations = db.prepare('SELECT COUNT(*) as c FROM relations').get() as CountRow;
    const tags = db.prepare('SELECT COUNT(DISTINCT tag) as c FROM tags').get() as CountRow;

    const typeDistribution = db.prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC LIMIT 50').all();
    const tagDistribution = db.prepare('SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC LIMIT 30').all();
    const statusDistribution = db.prepare("SELECT status, COUNT(*) as count FROM entities GROUP BY status").all();

    res.json({
      success: true,
      data: {
        totalEntities: entities.c,
        totalObservations: observations.c,
        totalRelations: relations.c,
        totalTags: tags.c,
        typeDistribution,
        tagDistribution,
        statusDistribution,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
  logCapabilities();
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
