#!/usr/bin/env node

import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { openDatabase, closeDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { getDatabase } from '../../db.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities } from '../../core/config.js';
import { computePatterns } from '../../core/patterns.js';
import type { CountRow, PragmaColumnRow } from '../../core/types.js';
import {
  RememberSchema as RememberBody, RecallSchema as RecallBody,
  ForgetSchema as ForgetBody, ConsolidateSchema as ConsolidateBody,
  ExportSchema as ExportBody, ImportSchema as ImportBody,
  LearnSchema as LearnBody,
} from '../schemas.js';
import { getUpdateCheck } from '../../core/version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from '../../core/install-channel.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../package.json'
);
const packageRoot = path.dirname(packageJsonPath);
const packageVersion =
  JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? '0.0.0';

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Rate limiting (CodeQL security requirement) ---
// Protects against DoS attacks and API abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.',
});

// Apply rate limiting to all API routes
app.use('/v1/', apiLimiter);

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// --- Security headers ---
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// --- Dashboard ---
app.get('/dashboard', (_req, res) => {
  // Serve Preact SPA build (preferred)
  const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dashboard/dist/index.html');
  if (fs.existsSync(dashboardPath)) {
    // CRITICAL: dotfiles: 'allow' is required for paths containing hidden directories like .nvm
    res.type('html').sendFile(dashboardPath, { dotfiles: 'allow' });
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
}).strip();

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

// --- Update status ---
app.get('/v1/update-status', async (req, res) => {
  try {
    const cached = req.query.cached === '1' || req.query.cached === 'true';
    const install = getCurrentInstallChannel({ packageRoot });
    const installSupport = getInstallChannelSupport(install);
    const update = await getUpdateCheck(packageVersion, { preferFresh: !cached });

    res.json({
      success: true,
      data: {
        currentVersion: packageVersion,
        latestVersion: update?.latestVersion ?? null,
        checkedAt: update?.checkedAt ?? null,
        updateAvailable: update?.updateAvailable ?? false,
        checkSucceeded: update?.checkSucceeded ?? false,
        source: update?.source ?? null,
        installChannel: installSupport.channel,
        canSelfUpdate: installSupport.canSelfUpdate,
        recommendedCommand: installSupport.recommendedCommand,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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

// --- Analytics ---
app.get('/v1/analytics', (_req, res) => {
  try {
    const db = getDatabase();

    // SQL datetime() literals are used inline in queries below — no JS interpolation needed

    // --- Health Score ---
    const totalActive = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE status = 'active'"
    ).get() as CountRow).c;

    // Activity: % of active entities accessed in last 30 days
    const recentlyAccessed = (db.prepare(
      `SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND last_accessed_at >= datetime('now', '-30 days')`
    ).get() as CountRow).c;
    const activityRatio = totalActive > 0 ? recentlyAccessed / totalActive : 0;

    // Quality: % of active entities with confidence > 0.7
    const highConfidence = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND confidence > 0.7"
    ).get() as CountRow).c;
    const qualityRatio = totalActive > 0 ? highConfidence / totalActive : 0;

    // Freshness: new entities this week relative to total (capped at 1.0)
    const newThisWeek = (db.prepare(
      `SELECT COUNT(*) as c FROM entities WHERE created_at >= datetime('now', '-7 days')`
    ).get() as CountRow).c;
    const freshnessRatio = totalActive > 0 ? Math.min(newThisWeek / totalActive, 1.0) : 0;

    // Lessons: lesson_learned entity count, 5+ = full score
    const lessonCount = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned'"
    ).get() as CountRow).c;
    const lessonRatio = Math.min(lessonCount / 5, 1.0);

    const healthScore = Math.round(
      activityRatio * 30 + qualityRatio * 30 + freshnessRatio * 20 + lessonRatio * 20
    );

    const healthFactors = {
      activity: { score: Math.round(activityRatio * 30), weight: 30, detail: `${recentlyAccessed}/${totalActive} active entities accessed in last 30 days` },
      quality: { score: Math.round(qualityRatio * 30), weight: 30, detail: `${highConfidence}/${totalActive} active entities with confidence > 0.7` },
      freshness: { score: Math.round(freshnessRatio * 20), weight: 20, detail: `${newThisWeek} new entities this week` },
      lessons: { score: Math.round(lessonRatio * 20), weight: 20, detail: `${lessonCount} lessons learned` },
    };

    // --- Timeline (last 30 days) ---
    const createdTimeline = db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as created
      FROM entities
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at)
      ORDER BY day
    `).all() as Array<{ day: string; created: number }>;

    const recalledTimeline = db.prepare(`
      SELECT DATE(last_accessed_at) as day, COUNT(*) as recalled
      FROM entities
      WHERE last_accessed_at >= datetime('now', '-30 days')
      GROUP BY DATE(last_accessed_at)
      ORDER BY day
    `).all() as Array<{ day: string; recalled: number }>;

    // Merge into daily buckets
    const timelineMap = new Map<string, { date: string; created: number; recalled: number }>();
    for (const row of createdTimeline) {
      timelineMap.set(row.day, { date: row.day, created: row.created, recalled: 0 });
    }
    for (const row of recalledTimeline) {
      const existing = timelineMap.get(row.day);
      if (existing) {
        existing.recalled = row.recalled;
      } else {
        timelineMap.set(row.day, { date: row.day, created: 0, recalled: row.recalled });
      }
    }
    const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // --- Value Metrics ---
    const totalRecalls = (db.prepare(
      "SELECT COALESCE(SUM(access_count), 0) as c FROM entities"
    ).get() as CountRow).c;

    const lessonsWithWarnings = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned' AND access_count > 0"
    ).get() as CountRow).c;

    const typeDistribution = db.prepare(
      "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC"
    ).all();

    const valueMetrics = {
      totalRecalls,
      lessonCount,
      lessonsWithWarnings,
      typeDistribution,
    };

    // --- Cleanup Suggestions ---
    const staleEntities = db.prepare(`
      SELECT id, name, type, confidence,
        CAST((julianday('now') - julianday(COALESCE(last_accessed_at, created_at))) AS INTEGER) as days_unused
      FROM entities
      WHERE status = 'active'
        AND confidence < 0.4
        AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-30 days'))
      ORDER BY confidence ASC
      LIMIT 10
    `).all();

    const duplicateCandidates = db.prepare(`
      SELECT e1.name as name1, e2.name as name2, e1.type
      FROM entities e1
      JOIN entities e2 ON e1.id < e2.id AND e1.type = e2.type
      WHERE e1.status = 'active' AND e2.status = 'active'
        AND (INSTR(LOWER(e1.name), LOWER(e2.name)) > 0 OR INSTR(LOWER(e2.name), LOWER(e1.name)) > 0)
      LIMIT 5
    `).all();

    const cleanup = {
      staleEntities,
      duplicateCandidates,
    };

    // --- Recall Effectiveness ---
    let recallEffectiveness: {
      overallHitRate: number;
      totalHits: number;
      totalMisses: number;
      trackedEntities: number;
      topEffective: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
      mostIgnored: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
    } | null = null;

    try {
      const recallColCheck = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
      if (recallColCheck.some((c: PragmaColumnRow) => c.name === 'recall_hits')) {
        const totals = db.prepare(
          `SELECT COALESCE(SUM(recall_hits), 0) as hits, COALESCE(SUM(recall_misses), 0) as misses,
           COUNT(*) as tracked FROM entities WHERE (recall_hits > 0 OR recall_misses > 0)`
        ).get() as { hits: number; misses: number; tracked: number };

        const total = totals.hits + totals.misses;
        const overallHitRate = total > 0 ? totals.hits / total : 0;

        const topEffective = db.prepare(
          `SELECT name, type, COALESCE(recall_hits, 0) as hits, COALESCE(recall_misses, 0) as misses,
           CAST(COALESCE(recall_hits, 0) AS REAL) / (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) as hitRate
           FROM entities WHERE (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) > 0
           ORDER BY hitRate DESC, hits DESC LIMIT 5`
        ).all() as Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;

        const mostIgnored = db.prepare(
          `SELECT name, type, COALESCE(recall_hits, 0) as hits, COALESCE(recall_misses, 0) as misses,
           CAST(COALESCE(recall_hits, 0) AS REAL) / (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) as hitRate
           FROM entities WHERE (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) > 0
           ORDER BY hitRate ASC, misses DESC LIMIT 5`
        ).all() as Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;

        recallEffectiveness = {
          overallHitRate,
          totalHits: totals.hits,
          totalMisses: totals.misses,
          trackedEntities: totals.tracked,
          topEffective,
          mostIgnored,
        };
      }
    } catch {
      // recall_hits column may not exist yet — skip gracefully
    }

    res.json({
      success: true,
      data: {
        healthScore,
        healthFactors,
        timeline,
        valueMetrics,
        recallEffectiveness,
        cleanup,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Patterns ---
app.get('/v1/patterns', (_req, res) => {
  try {
    const db = getDatabase();
    const data = computePatterns(db);
    res.json({ success: true, data });
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
const ALLOW_REMOTE_BY_ENV = /^(1|true|yes)$/i.test(process.env.MEMESH_HTTP_ALLOW_REMOTE || '');

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
}

export function startServer(
  host = HOST,
  port = PORT,
  opts?: { allowRemote?: boolean }
): ReturnType<typeof app.listen> {
  const allowRemote = opts?.allowRemote ?? ALLOW_REMOTE_BY_ENV;
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind MeMesh HTTP server to non-loopback host "${host}" without explicit remote access opt-in. Use --allow-remote or MEMESH_HTTP_ALLOW_REMOTE=true.`
    );
  }
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
