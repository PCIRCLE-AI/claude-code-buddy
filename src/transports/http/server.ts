#!/usr/bin/env node

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallEnhanced, forget, consolidate, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities } from '../../core/config.js';
import { computePatterns } from '../../core/patterns.js';
import { computeAnalytics } from '../../core/analytics.js';
import { computeStats } from '../../core/stats.js';
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
  return process.env.MEMESH_DB_PATH
    ? path.dirname(process.env.MEMESH_DB_PATH)
    : path.join(homedir(), '.memesh');
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
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
    .catch((err: any) => res.status(400).json({ success: false, error: err?.message ?? String(err) }));
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Graph / Stats / Analytics ---
// All three pull pure read-only aggregations from the DB. Their query
// shapes used to be inlined here; they now live in src/core/{graph,stats,
// analytics}.ts so CLI/MCP can call the same logic without re-implementing
// the SQL.
app.get('/v1/graph', (_req, res) => {
  try { res.json({ success: true, data: computeGraph(getDatabase()) }); }
  catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/v1/stats', (_req, res) => {
  try { res.json({ success: true, data: computeStats(getDatabase()) }); }
  catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/v1/analytics', (_req, res) => {
  try { res.json({ success: true, data: computeAnalytics(getDatabase()) }); }
  catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
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
    const typeFilter = req.query.type as string | undefined;

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
  openDatabase();
  logCapabilities();
  const server = app.listen(port, host, () => {
    console.log(`MeMesh HTTP server running at http://${host}:${port}`);
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
