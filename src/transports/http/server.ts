#!/usr/bin/env node

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'crypto';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities } from '../../core/config.js';
import { computePatterns } from '../../core/patterns.js';
import { computeAnalytics } from '../../core/analytics.js';
import { computeStats } from '../../core/stats.js';
import { computeProjects } from '../../core/projects.js';
import { computeGraph } from '../../core/graph.js';
import { verifyAgentWork } from '../../core/verifier.js';
import type { CountRow } from '../../core/types.js';
import {
  RememberSchema as RememberBody, RecallSchema as RecallBody,
  ForgetSchema as ForgetBody, ConsolidateSchema as ConsolidateBody,
  ExportSchema as ExportBody, ImportSchema as ImportBody,
  LearnSchema as LearnBody, VerifyAgentWorkSchema as VerifyBody,
} from '../schemas.js';
import { getUpdateCheck } from '../../core/version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from '../../core/install-channel.js';
import { getDbPath, getMemeshDirFromDbPath } from '../../core/paths.js';

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

// JSON body parsing is registered LATER, scoped to /v1/* and gated
// behind bearerAuth + apiLimiter. The earlier global registration was
// a pre-auth DoS primitive: an unauthenticated attacker could force up
// to 1 MB of JSON parsing per request before getting a 401.

// --- Rate limiting (CodeQL security requirement) ---
// Protects against DoS attacks and API abuse.
// IMPORTANT: registered AFTER bearerAuth below so that an unauthenticated
// attacker cannot drain the rate-limit budget for legitimate clients
// sharing an IP. Express runs middleware in registration order.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.',
});

// --- Bearer-token auth (only enforced when bound to non-loopback) ---
// F3: when --allow-remote is set, the API was previously exposing the
// entire memory store with zero auth. Loopback default keeps zero-auth
// because process-owner UNIX semantics are the trust boundary there.
//
// `remoteToken` holds the canonical token loaded by the most recent
// remote-binding `startServer()` call. Zero-token (loopback-only)
// processes leave it null. The auth requirement per listener is
// tracked in `serverAuthRequired` keyed on the http.Server instance,
// so a process that holds BOTH a remote and a loopback listener on
// the same Express app does not cross-authenticate (the loopback
// listener stays zero-auth even after a remote one set the token).
let remoteToken: Buffer | null = null;
const serverAuthRequired = new WeakMap<import('http').Server, boolean>();

function memeshDir(): string {
  return getMemeshDirFromDbPath();
}

function loadOrCreateRemoteToken(): { token: Buffer; freshlyCreated: boolean } {
  const fromEnv = process.env.MEMESH_REMOTE_TOKEN;
  if (fromEnv && fromEnv.length >= 16) {
    return { token: Buffer.from(fromEnv, 'utf8'), freshlyCreated: false };
  }
  const dir = memeshDir();
  const tokenPath = path.join(dir, 'remote-token');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }

  // Race-free create: try O_EXCL first. If two memesh-http instances
  // launch simultaneously, exactly one wins the create; the loser falls
  // through to the read branch and uses the winner's token. Without
  // this, both could randomBytes()+writeFileSync() and the in-memory
  // token of one server would not match what's on disk for the other.
  const generated = randomBytes(32).toString('hex');
  try {
    const fd = fs.openSync(tokenPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, generated + '\n');
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* non-POSIX */ }
    return { token: Buffer.from(generated, 'utf8'), freshlyCreated: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    // File already exists — fall through to read it.
  }

  const value = fs.readFileSync(tokenPath, 'utf8').trim();
  if (value.length < 16) {
    // Existing file is too short / corrupted. Don't silently overwrite —
    // tell the operator so they can decide whether to delete and restart.
    throw new Error(
      `Existing ${tokenPath} is too short (<16 chars). Delete it and restart memesh-http to regenerate.`
    );
  }
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* non-POSIX */ }
  return { token: Buffer.from(value, 'utf8'), freshlyCreated: false };
}

function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual requires equal length; pad to max so we don't leak
  // the operand-length difference via early-exit.
  const max = Math.max(a.length, b.length);
  const aPad = Buffer.alloc(max);
  const bPad = Buffer.alloc(max);
  a.copy(aPad);
  b.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && a.length === b.length;
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  // Per-listener auth gating. The previous design used a single
  // module-global `remoteToken` and decided on auth by whether it was
  // null — a second loopback `startServer()` could clobber it back to
  // null and silently de-authenticate the existing remote listener.
  // Now: each `startServer()` records its requirement in
  // `serverAuthRequired` keyed on the http.Server instance that
  // accepted the connection (`req.socket.server`). A loopback listener
  // is tagged false; a remote listener is tagged true. The two
  // listeners therefore don't cross-contaminate.
  // `net.Socket.server` is set by http internals on accepted sockets;
  // it's not in the public Socket type, hence the cast.
  const ownerServer = (req.socket as unknown as { server?: import('http').Server }).server;
  const requiresAuth = ownerServer ? (serverAuthRequired.get(ownerServer) ?? false) : false;
  if (!requiresAuth) {
    next();
    return;
  }
  if (!remoteToken) {
    // Misconfiguration: a remote listener is up but no token was
    // provisioned. Fail closed.
    res.status(503).json({
      success: false,
      error: 'remote bearer auth not configured on this server',
    });
    return;
  }
  const header = req.header('authorization') || req.header('Authorization') || '';
  // Parse "Bearer <token>" without a quantified-overlap regex.
  // Earlier `/^Bearer\s+(.+)$/i.exec(...)` was flagged by CodeQL
  // (js/polynomial-redos): `\s+` and `.+` both match whitespace, so on
  // header values that are all whitespace the engine has to enumerate
  // every split between the two quantifiers — quadratic in the input
  // length. We substitute a single linear scan for the first
  // whitespace, verify the prefix is the literal "Bearer" token, then
  // take the suffix.
  const trimmed = header.trim();
  const wsIndex = trimmed.search(/\s/);
  if (wsIndex < 0 || trimmed.slice(0, wsIndex).toLowerCase() !== 'bearer') {
    res.status(401).json({ success: false, error: 'Missing Authorization: Bearer <token>' });
    return;
  }
  const tokenPart = trimmed.slice(wsIndex + 1).trim();
  if (!tokenPart) {
    res.status(401).json({ success: false, error: 'Missing Authorization: Bearer <token>' });
    return;
  }
  const presented = Buffer.from(tokenPart, 'utf8');
  if (!constantTimeEquals(presented, remoteToken)) {
    res.status(401).json({ success: false, error: 'Invalid bearer token' });
    return;
  }
  next();
}

// Auth applies to /v1/* only. The dashboard HTML is intentionally
// unauthenticated: browsers cannot attach an Authorization header on a
// top-level navigation, so an authed /dashboard would 401 on every
// remote-bind deployment. Instead the SPA reads the token from
// localStorage and attaches it to all /v1/* fetches; an empty/wrong
// token still produces a 401 that the SPA can route into a token-prompt
// modal. /favicon.ico is unauthed (browsers fetch it before any header
// is set).
//
// Order on /v1/* is intentional:
//   1. bearerAuth   — reject unauthenticated requests with no body parse
//   2. apiLimiter   — rate-limit only authenticated traffic (so unauth
//                     attacker cannot drain the per-IP budget shared
//                     with legitimate clients)
//   3. express.json — body parse only after auth + rate-limit, so
//                     unauthenticated requests cannot force pre-auth
//                     CPU/memory work on a 1 MB JSON parse
app.use('/v1/', bearerAuth);
app.use('/v1/', apiLimiter);
app.use('/v1/', express.json({ limit: '1mb' }));

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
    // Fallback to legacy template (only reached in source checkouts pre-build)
    import('../../cli/view-live.js')
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // F15: Provide actionable error message for database initialization failures
    if (message === 'Database not opened') {
      res.status(503).json({
        success: false,
        error: 'Database not initialized',
        details: 'MeMesh database failed to open at startup. Check server logs for details, or run "memesh doctor" to diagnose.',
      });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

// --- Doctor (structured diagnostics for the FeedbackWidget) ---
//
// The dashboard FeedbackWidget calls this when a user opts to
// "include system info" in a feedback issue. Returning the same
// `DoctorResult` shape the CLI emits with `--json` lets us evolve
// the diagnostic surface in one place without divergence.
//
// SecretSafe defence (gstack pattern, gstack-brain-sync's stdin
// regex scan): doctor itself never reads secret-bearing fields, but
// a regex sweep belt-and-suspenders any future check that
// accidentally includes one. Matches on Anthropic / OpenAI / GitHub
// / AWS-style key prefixes plus generic `sk-` / Bearer tokens.
function redactSecrets(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-***REDACTED***')
    .replace(/sk-proj-[A-Za-z0-9_-]{20,}/g, 'sk-proj-***REDACTED***')
    .replace(/sk-[A-Za-z0-9]{32,}/g, 'sk-***REDACTED***')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, 'ghp_***REDACTED***')
    .replace(/gho_[A-Za-z0-9]{30,}/g, 'gho_***REDACTED***')
    .replace(/AKIA[A-Z0-9]{16}/g, 'AKIA***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer ***REDACTED***');
}

app.get('/v1/doctor', async (_req, res) => {
  try {
    const { runDoctor } = await import('../../core/doctor.js');
    const result = await runDoctor({
      packageRoot,
      packageVersion,
    });
    // Walk the result and redact any secret-shaped substring before
    // it leaves the server — defense in depth, not a primary defence.
    const safe = JSON.parse(redactSecrets(JSON.stringify(result)));
    res.json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// DX: every POST endpoint used to repeat a 10-line safeParse + 400
// error mapping + try/catch + 200/400 block. handlePost factors that
// into one place. Async handlers are fine — Promise.resolve unifies
// sync (remember/forget) and async (consolidate) code paths.
function handlePost<T>(
  schema: z.ZodType<T>,
  req: Request,
  res: Response,
  handler: (data: T) => unknown | Promise<unknown>,
): void {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  Promise.resolve(handler(parsed.data))
    .then((data) => res.json({ success: true, data }))
    .catch((err: unknown) => res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) }));
}

// --- Remember ---
app.post('/v1/remember', (req, res) => handlePost(RememberBody, req, res, remember));

// --- Recall ---
app.post('/v1/recall', async (req, res) => {
  const parsed = RecallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    // recallEnhanced: FTS5 + sqlite-vec, no LLM in the hot path
    const entities = await recallEnhanced(parsed.data);
    const kg = new KnowledgeGraph(getDatabase());
    const conflicts = kg.findConflicts(entities.map(e => e.name));
    if (conflicts.length > 0) {
      res.json({ success: true, data: { entities, conflicts } });
    } else {
      res.json({ success: true, data: entities });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Forget / Consolidate / Export / Import / Learn / Verify ---
// All 6 follow the same shape; handlePost above does the heavy lifting.
app.post('/v1/forget',      (req, res) => handlePost(ForgetBody, req, res, forget));
app.post('/v1/consolidate', (req, res) => handlePost(ConsolidateBody, req, res, consolidate));
app.post('/v1/export',      (req, res) => handlePost(ExportBody, req, res, exportMemories));
app.post('/v1/import',      (req, res) => handlePost(ImportBody, req, res, importMemories));
app.post('/v1/learn',       (req, res) => handlePost(LearnBody, req, res, learn));
app.post('/v1/verify',      (req, res) => handlePost(VerifyBody, req, res, verifyAgentWork));

// --- Config ---
app.get('/v1/config', (_req, res) => {
  try {
    const config = readConfig();
    const caps = detectCapabilities(config);
    const safeConfig = { ...config };
    if (safeConfig.llm?.apiKey) {
      safeConfig.llm = { ...safeConfig.llm, apiKey: '***' };
    }
    // Mask EVERY apiKey in the fallback chain — without this loop a
    // user who configures `llmFallbacks: [{provider:'openai',
    // apiKey:'sk-...'}]` would see their fallback key returned in
    // plaintext to the dashboard SPA. The primary `llm.apiKey` mask
    // above is mirrored here for the chain.
    if (Array.isArray(safeConfig.llmFallbacks) && safeConfig.llmFallbacks.length > 0) {
      safeConfig.llmFallbacks = safeConfig.llmFallbacks.map(fb =>
        fb?.apiKey ? { ...fb, apiKey: '***' } : fb
      );
    }
    // Also mask API key in capabilities (detectCapabilities returns llm config with raw key)
    if (caps.llm?.apiKey) {
      caps.llm = { ...caps.llm, apiKey: '***' };
    }
    if (Array.isArray(caps.llmFallbacks) && caps.llmFallbacks.length > 0) {
      caps.llmFallbacks = caps.llmFallbacks.map(fb =>
        fb?.apiKey ? { ...fb, apiKey: '***' } : fb
      );
    }
    res.json({ success: true, data: { config: safeConfig, capabilities: caps } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

const ConfigBody = z.object({
  // F17: `llm: null` removes the provider entirely (Core Mode). Used by
  // the dashboard "Remove provider" action so the user can opt out of
  // LLM-backed features without hand-editing config.json.
  llm: z.union([
    z.object({
      provider: z.enum(['anthropic', 'openai', 'ollama']),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    }),
    z.null(),
  ]).optional(),
  // Cross-provider failover chain — accepted via dashboard Settings
  // UI so the user can configure their fallback plan (e.g.
  // anthropic-primary -> openai-fallback -> ollama-local) without
  // hand-editing config.json. Without this entry, ConfigBody.strip()
  // would silently drop the field on every POST.
  llmFallbacks: z.array(z.object({
    provider: z.enum(['anthropic', 'openai', 'ollama']),
    model: z.string().optional(),
    apiKey: z.string().optional(),
  })).optional(),
  autoCapture: z.boolean().optional(),
  sessionLimit: z.number().int().min(1).max(100).optional(),
  // Opt-in for the experimental agentic-orchestration protocol.
  // Mirrors MEMESH_ENABLE_AGENTIC_ORCHESTRATION env var. Env wins
  // when both are set so existing env-var users are not surprised.
  enableAgenticOrchestration: z.boolean().optional(),
  // Auto-update policy for the session-start hook. Mirrors
  // MEMESH_AUTO_UPDATE env var with env > config precedence.
  // Without this on the write surface, the only way to opt into
  // the new policy was hand-editing ~/.memesh/config.json.
  autoUpdate: z.enum(['off', 'patch', 'minor', 'major']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  setupCompleted: z.boolean().optional(),
}).strip();

app.post('/v1/config', async (req, res) => {
  const parsed = ConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    // NOTE: read-modify-write across `before`/`updateConfig` is non-atomic.
    // Concurrent POSTs could interleave such that the embedder cache fails
    // to reset. This is acceptable for the MeMesh dashboard (single user,
    // single tab in practice); revisit if the HTTP API ever serves
    // multi-tenant config writes.
    const before = readConfig();
    const updated = updateConfig(parsed.data);
    // If the LLM provider/apiKey changed, the embedder may have cached an
    // ONNX pipeline (or be about to use the now-stale apiKey path). Reset
    // so the next embed call picks up the new config — eliminates the
    // "restart server to apply" footgun.
    // F17: `llm: null` removes the provider, which also counts as a change.
    // `parsed.data.llm !== undefined` covers both set-to-something and
    // set-to-null; `=== undefined` would be "user did not touch llm".
    const llmChanged =
      parsed.data.llm !== undefined &&
      (before.llm?.provider !== updated.llm?.provider ||
        before.llm?.apiKey !== updated.llm?.apiKey);
    if (llmChanged) {
      const { resetEmbeddingState } = await import('../../core/embedder.js');
      resetEmbeddingState();
    }
    // Mask API key before returning
    const safeUpdated = { ...updated };
    if (safeUpdated.llm?.apiKey) {
      safeUpdated.llm = { ...safeUpdated.llm, apiKey: '***' };
    }
    res.json({ success: true, data: safeUpdated });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Test LLM credentials + fetch live model list ---
//
// Probe the provider's models endpoint with the supplied apiKey before the
// user commits to writing it to disk. Returns a fresh model catalog so the
// dashboard can populate a dropdown with real choices instead of stale
// hardcoded names. Rate-limited at /v1/* shared limiter.
const ConfigTestBody = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama']),
  apiKey: z.string().max(500).optional(),
  host: z.string().max(500).optional(),
});

app.post('/v1/config/test', async (req, res) => {
  const parsed = ConfigTestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  try {
    const { probeProvider } = await import('../../core/llm-validator.js');
    const { provider, host } = parsed.data;
    let { apiKey } = parsed.data;
    // If the caller omits apiKey, fall back to the one already saved for this
    // provider — lets the dashboard offer "Test with current settings" without
    // forcing the user to re-enter a key they previously saved. Without this,
    // re-testing after a fresh page load would require digging up the key.
    if (!apiKey && (provider === 'anthropic' || provider === 'openai')) {
      const existing = readConfig();
      if (existing.llm?.provider === provider && existing.llm.apiKey) {
        apiKey = existing.llm.apiKey;
      }
    }
    const result = await probeProvider(provider, apiKey, host);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
        lastAttemptAt: update?.lastAttemptAt ?? null,
        lastSuccessfulCheckAt: update?.lastSuccessfulCheckAt ?? null,
        lastError: update?.lastError ?? null,
        updateAvailable: update?.updateAvailable ?? false,
        checkSucceeded: update?.checkSucceeded ?? false,
        source: update?.source ?? null,
        freshness: update?.freshness ?? 'unavailable',
        installChannel: installSupport.channel,
        canSelfUpdate: installSupport.canSelfUpdate,
        // Codex rounds 32 / 34 / 35: suppress the recommended command
        // ONLY when we're certain the maintainer-deprecated install
        // has no upgrade target on npm yet. "Certain" means:
        //   1. latestVersion is the SAME as the installed version, AND
        //   2. that equality came from a FRESH lookup (round 35).
        // Cached/stale equality could be wrong if a replacement was
        // published since the last successful check. Null-latest
        // (round 34, version-lookup failed) is also unknown. In
        // every uncertain case we keep the command so the dashboard
        // has an actionable path — `memesh update` resolves @latest
        // at install time and will succeed if a replacement exists.
        recommendedCommand: (
          update?.currentVersionDeprecated
          && update.latestVersion
          && update.latestVersion === update.currentVersion
          && update.freshness === 'fresh'
        ) ? null : installSupport.recommendedCommand,
        // Surface deprecation state so the dashboard can render the
        // security warning. Without these the SettingsTab only shows
        // generic update-available text and a deprecated install
        // appears healthy in the UI.
        currentVersionDeprecated: update?.currentVersionDeprecated ?? false,
        deprecationMessage: update?.deprecationMessage ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Graph / Stats / Analytics ---
// All three pull pure read-only aggregations from the DB. Their query
// shapes used to be inlined here; they now live in src/core/{graph,stats,
// analytics}.ts so CLI/MCP can call the same logic without re-implementing
// the SQL.
app.get('/v1/graph', (_req, res) => {
  try { res.json({ success: true, data: computeGraph(getDatabase()) }); }
  catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});
app.get('/v1/stats', (_req, res) => {
  try { res.json({ success: true, data: computeStats(getDatabase()) }); }
  catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});
app.get('/v1/analytics', (_req, res) => {
  try { res.json({ success: true, data: computeAnalytics(getDatabase()) }); }
  catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});
// --- Demo seeder ---
//
// SDD plan SPEC-4: a fresh install renders empty charts. The dashboard
// onboarding banner POSTs to these endpoints so the user gets a
// one-click tour without leaving the GUI to run `memesh demo` from a
// terminal. The CLI command remains for headless / CI flows.
app.post('/v1/demo/seed', async (_req, res) => {
  try {
    const { seedDemo } = await import('../../core/demo.js');
    const data = seedDemo(getDatabase());
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});
app.post('/v1/demo/reset', async (_req, res) => {
  try {
    const { seedDemo } = await import('../../core/demo.js');
    const data = seedDemo(getDatabase(), { reset: true });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Projects ---
//
// Lists distinct projects extracted from entity tags (`project:*`) and entity
// name prefixes. Used by the dashboard Browse / Lessons tabs to populate
// per-project filter chips so users can scope memory exploration to one
// codebase at a time.
app.get('/v1/projects', (_req, res) => {
  try { res.json({ success: true, data: computeProjects(getDatabase()) }); }
  catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

// --- Patterns ---
app.get('/v1/patterns', (_req, res) => {
  try {
    const db = getDatabase();
    const data = computePatterns(db);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- LLM telemetry ---
//
// Surfaces the `llm_telemetry` table contents (see core/llm-telemetry.ts)
// as a per-flow scorecard for the dashboard Analytics tab. Same shape
// as the `memesh telemetry` CLI output. Default 30-day window.
const TelemetryQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(365).default(30),
});
app.get('/v1/telemetry', async (req, res) => {
  try {
    const parsed = TelemetryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues.map(i => i.message).join('; ') });
      return;
    }
    const { summariseTelemetry } = await import('../../core/llm-telemetry.js');
    const summaries = summariseTelemetry(parsed.data.window);
    res.json({ success: true, data: { window_days: parsed.data.window, summaries } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Dream proposals (Insights tab) ---
//
// Backs the dashboard's Insights surface, replacing CLI-only
// `memesh dream list` / `accept` / `reject`. The dreamer's propose-
// then-review pattern (see src/core/dreamer.ts) only generates value
// when there is an interactive review surface; without these endpoints
// proposals piled up indefinitely in the dream_proposals table, which
// is why the maintainer reported "knowledge graph 很多memory沒有
//被好好消化".
const DreamProposalsQuerySchema = z.object({
  status: z.enum(['pending', 'applied', 'rejected', 'all']).default('pending'),
});
app.get('/v1/dream/proposals', (req, res) => {
  try {
    const parsed = DreamProposalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues.map(i => i.message).join('; ') });
      return;
    }
    const status = parsed.data.status;
    // listProposals takes a single status; for 'all' we run the
    // pending+applied+rejected union.
    import('../../core/dreamer.js').then(({ listProposals }) => {
      const db = getDatabase();
      const rows = status === 'all'
        ? [...listProposals(db, 'pending'), ...listProposals(db, 'applied'), ...listProposals(db, 'rejected')]
        : listProposals(db, status);
      res.json({ success: true, data: rows });
    }).catch((err: unknown) => res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }));
  } catch (err) { res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) }); }
});

// Full proposed_digest content (observations, tags, source_ids) for the
// detail view in the Insights tab — listProposals only returns a
// truncated preview.
//
// Validator surfacing channel: when the dreamer was invoked with
// `validateBeforeStage: true` and the LLM validator returned a 'soften'
// verdict, `writeProposal` in src/core/dreamer.ts persists the
// SuspiciousClaim[] onto the JSON blob as `proposed_digest.validation_warnings`.
// This endpoint JSON-parses the blob and returns it whole, so the
// `validation_warnings` field passes through untouched and is the
// channel the dashboard reads to render its "Flagged claims" section.
// No additional projection is needed — adding/removing fields on the
// digest blob automatically flows through here.
app.get('/v1/dream/proposals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, error: 'invalid id' });
    return;
  }
  try {
    const row = getDatabase().prepare(
      'SELECT id, project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, status, reason, created_at, reviewed_at FROM dream_proposals WHERE id = ?'
    ).get(id) as { proposed_digest: string; source_ids: string; [k: string]: unknown } | undefined;
    if (!row) {
      res.status(404).json({ success: false, error: `proposal #${id} not found` });
      return;
    }
    let digest: unknown = null;
    let sourceIds: number[] = [];
    try { digest = JSON.parse(row.proposed_digest); } catch { /* corrupt — surface as null */ }
    try { sourceIds = JSON.parse(row.source_ids); } catch { /* leave empty */ }
    res.json({ success: true, data: { ...row, proposed_digest: digest, source_ids: sourceIds } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Run a dream pass on demand ---
//
// Closes the v4.2.0 known limitation: the digest validator existed only
// behind `memesh dream run --validate` on the CLI. The dashboard
// Insights tab can now POST here to trigger a pass without leaving the
// browser. Bounds match the CLI defaults (windowDays/maxLlmCalls) and
// add a hard ceiling so a hostile/runaway client cannot ask for a
// 1-year window with 10000 LLM calls.
//
// Forwards `cfg.llmFallbacks` so users with a primary+fallback chain
// configured in Settings get the same failover behaviour the CLI does.
const DreamRunBody = z.object({
  project: z.string().min(1).max(100).optional(),
  windowDays: z.number().int().min(1).max(90).default(14),
  maxLlmCalls: z.number().int().min(1).max(20).default(5),
  validate: z.boolean().default(false),
});
app.post('/v1/dream/run', async (req, res) => {
  const parsed = DreamRunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  try {
    const { runDreamer } = await import('../../core/dreamer.js');
    const cfg = readConfig();
    if (!cfg.llm) {
      res.status(400).json({
        success: false,
        error: 'No LLM configured — dream run requires Smart Mode. Configure a provider in Settings.',
      });
      return;
    }
    const result = await runDreamer(getDatabase(), cfg.llm, {
      project: parsed.data.project,
      windowDays: parsed.data.windowDays,
      maxLlmCalls: parsed.data.maxLlmCalls,
      fallbacks: cfg.llmFallbacks,
      validateBeforeStage: parsed.data.validate,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/v1/dream/proposals/:id/accept', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, error: 'invalid id' });
    return;
  }
  try {
    const { applyProposal } = await import('../../core/dreamer.js');
    const kg = new KnowledgeGraph(getDatabase());
    const result = applyProposal(getDatabase(), id, kg);
    res.json({ success: true, data: result });
  } catch (err) {
    // applyProposal throws "proposal #X not found or not pending" for
    // invalid IDs — surface as 404 rather than a 500.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found or not pending/.test(msg)) {
      res.status(404).json({ success: false, error: msg });
    } else {
      res.status(500).json({ success: false, error: msg });
    }
  }
});

const RejectBodySchema = z.object({
  reason: z.string().max(500).optional(),
});
app.post('/v1/dream/proposals/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, error: 'invalid id' });
    return;
  }
  const parsed = RejectBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues.map(i => i.message).join('; ') });
    return;
  }
  try {
    const { rejectProposal } = await import('../../core/dreamer.js');
    rejectProposal(getDatabase(), id, parsed.data.reason);
    res.json({ success: true, data: { id, status: 'rejected' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found or not pending/.test(msg)) {
      res.status(404).json({ success: false, error: msg });
    } else {
      res.status(500).json({ success: false, error: msg });
    }
  }
});

const EntitiesQuerySchema = z.object({
  type: z.string().min(1).max(100).optional(),
  // Cap at 5000 — Browse legitimately fetches the full set for client-side
  // filter / sort / search across the whole DB.
  limit: z.coerce.number().int().min(1).max(5000).default(20),
  status: z.enum(['all', 'active']).optional(),
});

// --- List entities ---
app.get('/v1/entities', (req, res) => {
  try {
    const parsed = EntitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: `Invalid query: ${parsed.error.message}` });
      return;
    }
    const { type: typeFilter, limit, status } = parsed.data;
    const includeArchived = status === 'all';

    const db = getDatabase();
    const kg = new KnowledgeGraph(db);

    let entities;
    if (typeFilter) {
      const statusFilter = includeArchived ? '' : "AND status = 'active'";
      const names = (db.prepare(
        `SELECT name FROM entities WHERE type = ? ${statusFilter} ORDER BY id DESC LIMIT ?`
      ).all(typeFilter, limit) as { name: string }[]);
      entities = names.map(r => kg.getEntity(r.name)).filter(Boolean);
    } else {
      entities = kg.listRecent(limit, includeArchived);
    }
    res.json({ success: true, data: entities });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
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
  const isRemote = !isLoopbackHost(host);
  if (!allowRemote && isRemote) {
    throw new Error(
      `Refusing to bind MeMesh HTTP server to non-loopback host "${host}" without explicit remote access opt-in. Use --allow-remote or MEMESH_HTTP_ALLOW_REMOTE=true.`
    );
  }
  if (isRemote) {
    // F3: non-loopback bind requires bearer-token auth on every request.
    // We load (or generate-and-persist) the token before app.listen so a
    // freshly-installed user is not silently exposed during the moment
    // between listen() resolving and the first 401-emitting request.
    const { token, freshlyCreated } = loadOrCreateRemoteToken();
    remoteToken = token;
    if (freshlyCreated) {
      const dir = memeshDir();
      const tokenPath = path.join(dir, 'remote-token');
      process.stderr.write(
        `\nMeMesh HTTP: bearer token generated for remote access.\n` +
        `  Token file: ${tokenPath} (mode 600)\n` +
        `  Use header: Authorization: Bearer <token>\n` +
        `  Rotate by deleting ${tokenPath} and restarting.\n` +
        `  Override: set MEMESH_REMOTE_TOKEN.\n\n`
      );
    } else {
      process.stderr.write(
        `MeMesh HTTP: remote bind requires Authorization: Bearer <token>. ` +
        `Token loaded from ${process.env.MEMESH_REMOTE_TOKEN ? 'MEMESH_REMOTE_TOKEN' : path.join(memeshDir(), 'remote-token')}.\n`
      );
    }
  }
  // NB: previously this `else` branch unconditionally set `remoteToken
  // = null`, which would silently de-authenticate any *already-running*
  // remote listener attached to the same Express app. Auth is now
  // gated per-request via `isLoopbackHost(req.socket.localAddress)` in
  // `bearerAuth`, so the token only matters for connections that
  // arrived on a remote-bound socket. Leaving the token in place is
  // safe: loopback requests skip the check before it's read.

  // F15: Startup health check — fail fast with actionable error if DB
  // cannot be opened. Previously, openDatabase() failure was an uncaught
  // promise rejection in CLI async action, leaving the server running
  // but returning 500 on every request with cryptic "Database not opened"
  // message. Now we validate and provide clear remediation steps.
  try {
    openDatabase();
    // Verify DB is actually usable (schema exists, can query)
    const db = getDatabase();
    db.prepare('SELECT COUNT(*) FROM entities').get();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dbPath = getDbPath();
    console.error('\n❌ MeMesh startup failed: database cannot be opened\n');
    console.error(`   Database path: ${dbPath}`);
    console.error(`   Error: ${message}\n`);
    console.error('Possible causes:');
    console.error('  • Database file is corrupted (run: memesh doctor)');
    console.error('  • Insufficient permissions (check file ownership)');
    console.error('  • Another process has locked the database');
    console.error('  • Disk is full or read-only\n');
    console.error('Quick fix: Backup and reset the database:');
    console.error(`  mv "${dbPath}" "${dbPath}.backup"`);
    console.error('  memesh (will create a fresh database)\n');
    throw new Error(`Database initialization failed: ${message}`, { cause: err });
  }

  logCapabilities();
  const server = app.listen(port, host, () => {
    // F15: Show actual bound address, not the input parameter. When port=0
    // (random port), the input shows "http://127.0.0.1:0" which is confusing.
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      console.log(`MeMesh HTTP server running at http://${addr.address}:${addr.port}`);
    } else {
      console.log(`MeMesh HTTP server running at http://${host}:${port}`);
    }
  });
  // Tag this listener as auth-required-or-not. bearerAuth reads this
  // back via `req.socket.server` so the requirement is per-listener,
  // not process-global.
  serverAuthRequired.set(server, isRemote);
  return server;
}

// Exported for tests only. Lets a test fixture inject a known token
// without going through the file-system persistence path.
export function __setRemoteTokenForTest(value: Buffer | null): void {
  remoteToken = value;
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
