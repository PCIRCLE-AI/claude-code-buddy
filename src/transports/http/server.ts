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

// --- Analytics ---
app.get('/v1/analytics', (_req, res) => {
  try {
    const db = getDatabase();

    // Use SQLite datetime() for consistent comparison regardless of timestamp format
    const thirtyDaysAgo = "datetime('now', '-30 days')";
    const sevenDaysAgo = "datetime('now', '-7 days')";

    // --- Health Score ---
    const totalActive = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE status = 'active'"
    ).get() as CountRow).c;

    // Activity: % of active entities accessed in last 30 days
    const recentlyAccessed = (db.prepare(
      `SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND last_accessed_at >= ${thirtyDaysAgo}`
    ).get() as CountRow).c;
    const activityRatio = totalActive > 0 ? recentlyAccessed / totalActive : 0;

    // Quality: % of active entities with confidence > 0.7
    const highConfidence = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND confidence > 0.7"
    ).get() as CountRow).c;
    const qualityRatio = totalActive > 0 ? highConfidence / totalActive : 0;

    // Freshness: new entities this week relative to total (capped at 1.0)
    const newThisWeek = (db.prepare(
      `SELECT COUNT(*) as c FROM entities WHERE created_at >= ${sevenDaysAgo}`
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
      WHERE created_at >= ${thirtyDaysAgo}
      GROUP BY DATE(created_at)
      ORDER BY day
    `).all() as Array<{ day: string; created: number }>;

    const recalledTimeline = db.prepare(`
      SELECT DATE(last_accessed_at) as day, COUNT(*) as recalled
      FROM entities
      WHERE last_accessed_at >= ${thirtyDaysAgo}
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
        AND (last_accessed_at IS NULL OR last_accessed_at < ${thirtyDaysAgo})
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

    res.json({
      success: true,
      data: {
        healthScore,
        healthFactors,
        timeline,
        valueMetrics,
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

    // 1. Work Schedule — hour distribution
    const hourDistribution = db.prepare(`
      SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
      FROM entities
      GROUP BY hour ORDER BY hour
    `).all() as Array<{ hour: number; count: number }>;

    // 2. Day distribution
    const dayDistribution = db.prepare(`
      SELECT CASE CAST(strftime('%w', created_at) AS INTEGER)
        WHEN 0 THEN 'Sunday' WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday'
        WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
        WHEN 6 THEN 'Saturday' END as day,
        CAST(strftime('%w', created_at) AS INTEGER) as dayNum,
        COUNT(*) as count
      FROM entities GROUP BY dayNum ORDER BY dayNum
    `).all() as Array<{ day: string; dayNum: number; count: number }>;

    // 3. Tool preferences — parse from session_keypoint observations
    const sessionObs = db.prepare(`
      SELECT o.content FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.type = 'session_keypoint' AND o.content LIKE '[FOCUS]%'
      LIMIT 500
    `).all() as Array<{ content: string }>;

    const toolCounts: Record<string, number> = {};
    for (const row of sessionObs) {
      const match = row.content.match(/Top tools: (.+)/);
      if (match) {
        for (const part of match[1].split(', ')) {
          const name = part.split('(')[0].trim();
          if (name) toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    }
    const toolPreferences = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, sessions]) => ({ tool, sessions }));

    // 4. Focus areas — entity types that represent intentional knowledge (not auto-tracked)
    const autoTypes = ['session_keypoint', 'commit', 'session_identity', 'workflow_checkpoint'];
    const focusAreas = db.prepare(`
      SELECT type, COUNT(*) as count FROM entities
      WHERE status = 'active' AND type NOT IN (${autoTypes.map(() => '?').join(',')})
      GROUP BY type ORDER BY count DESC LIMIT 10
    `).all(...autoTypes) as Array<{ type: string; count: number }>;

    // 5. Workflow style — avg commits per session, avg session duration
    const sessionDurations = db.prepare(`
      SELECT o.content FROM observations o
      JOIN entities e ON o.entity_id = e.id
      WHERE e.type = 'session_keypoint' AND o.content LIKE '[SESSION]%'
      LIMIT 200
    `).all() as Array<{ content: string }>;

    let totalMinutes = 0;
    let sessionCount = 0;
    for (const row of sessionDurations) {
      const match = row.content.match(/Duration: (\d+)m/);
      if (match) {
        totalMinutes += parseInt(match[1]);
        sessionCount++;
      }
    }
    const avgSessionMinutes = sessionCount > 0 ? Math.round(totalMinutes / sessionCount) : 0;

    const commitCount = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type = 'commit'"
    ).get() as { c: number }).c;
    const totalSessions = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type = 'session_keypoint'"
    ).get() as { c: number }).c;
    const commitsPerSession = totalSessions > 0 ? Math.round((commitCount / totalSessions) * 10) / 10 : 0;

    // 6. Strengths — types with high avg confidence
    const strengths = db.prepare(`
      SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
      FROM entities WHERE status = 'active' AND type NOT IN (${autoTypes.map(() => '?').join(',')})
      GROUP BY type HAVING count >= 2
      ORDER BY avgConfidence DESC LIMIT 5
    `).all(...autoTypes) as Array<{ type: string; avgConfidence: number; count: number }>;

    // 7. Learning areas — types with most mistake/bug_fix/lesson entities
    const learningTypes = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];
    const learningAreas = db.prepare(`
      SELECT t.tag, COUNT(*) as count FROM tags t
      JOIN entities e ON t.entity_id = e.id
      WHERE e.type IN (${learningTypes.map(() => '?').join(',')})
        AND t.tag NOT LIKE 'date:%' AND t.tag NOT LIKE 'auto%' AND t.tag NOT LIKE 'session%'
        AND t.tag != 'scope:project'
      GROUP BY t.tag ORDER BY count DESC LIMIT 10
    `).all(...learningTypes) as Array<{ tag: string; count: number }>;

    res.json({
      success: true,
      data: {
        workSchedule: { hourDistribution, dayDistribution },
        toolPreferences,
        focusAreas,
        workflow: { avgSessionMinutes, commitsPerSession, totalSessions, totalCommits: commitCount },
        strengths,
        learningAreas,
      },
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
