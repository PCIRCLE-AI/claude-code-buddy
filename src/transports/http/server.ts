#!/usr/bin/env node

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'crypto';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities, type LLMConfig } from '../../core/config.js';
import { languageValueError } from '../../core/output-language.js';
import { computePatterns } from '../../core/patterns.js';
import { computeAnalytics, computePmAnalytics } from '../../core/analytics.js';
import { computeStats } from '../../core/stats.js';
import { computeProjects } from '../../core/projects.js';
import { computeGraph } from '../../core/graph.js';
import { verifyAgentWork } from '../../core/verifier.js';
import type { CountRow } from '../../core/types.js';
import {
  RememberSchema as RememberBody, RecallSchema as RecallBody,
  ForgetSchema as ForgetBody,
  ExportSchema as ExportBody, ImportSchema as ImportBody,
  LearnSchema as LearnBody, VerifyAgentWorkSchema as VerifyBody,
} from '../schemas.js';
import { checkForUpdate, getLastUpdateCheck, getUpdateCheck } from '../../core/version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from '../../core/install-channel.js';
import { getDbPath, getMemeshDirFromDbPath } from '../../core/paths.js';
import { RETIRED_ROUTES } from './retired-routes.js';

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

// --- Stable error codes -----------------------------------------------------
//
// Every `success: false` response carries an `errorCode` ALONGSIDE the human
// `error` string (never replacing it). The `error` text is English prose and
// may be reworded at any time; `errorCode` is the machine contract — the
// dashboard translates known codes into the user's locale, scripts branch on
// them without regex-matching English sentences. Documented in
// docs/api/API_REFERENCE.md → "Error Handling"; changing or removing a code
// is a breaking API change, adding one is not.
//
// (The pre-existing `code` fields — 'PAYLOAD_TOO_LARGE' on 413, 'NOT_FOUND'
// on the catch-all 404 — are kept for back-compat; `errorCode` is the one
// consistent field across all error classes.)
type ErrorCode =
  | 'auth.missing-bearer'   // 401 — no/blank Authorization: Bearer header
  | 'auth.invalid-token'    // 401 — bearer token did not match
  | 'auth.not-configured'   // 503 — remote listener up but no token provisioned
  | 'validation.bad-body'   // 400 — body missing, not JSON, or failed schema validation
  | 'validation.bad-param'  // 400 — path/query parameter invalid
  | 'route.retired'         // 410 — endpoint retired on purpose; body names the replacement
  | 'route.not-found'       // 404 — no such route
  | 'resource.not-found'    // 404 — route exists, the named entity/proposal does not
  | 'payload.too-large'     // 413 — body exceeds the 1 MB limit
  | 'operation.failed'      // 400 — valid request, but the operation itself rejected it
  | 'llm.not-configured'    // 400 — the endpoint needs Smart Mode and no LLM is configured
  | 'rate.limited'          // 429 — too many requests in the window (non-loopback only)
  | 'server.internal';      // 500/503 — unexpected server-side failure

// JSON body parsing is registered LATER, scoped to /v1/* and gated
// behind bearerAuth + apiLimiter. The earlier global registration was
// a pre-auth DoS primitive: an unauthenticated attacker could force up
// to 1 MB of JSON parsing per request before getting a 401.

// --- Rate limiting (CodeQL security requirement) ---
// Protects against DoS attacks and API abuse.
// IMPORTANT: registered AFTER bearerAuth below so that an unauthenticated
// attacker cannot drain the rate-limit budget for legitimate clients
// sharing an IP. Express runs middleware in registration order.
// A request whose source is the loopback interface — the only clients that
// reach a default (127.0.0.1-bound) server. `req.ip` is `::1`, `127.0.0.1`, or
// the IPv4-mapped `::ffff:127.0.0.1` depending on the stack.
// Exported for testing: this predicate is the security boundary that decides
// whether the rate limiter is skipped, so it is unit-tested directly.
export function isLoopbackRequest(req: { ip?: string }): boolean {
  const ip = req.ip ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Skip loopback. The dashboard runs on 127.0.0.1 and is chatty by design —
  // page load fans out to ~8 endpoints and every `dream accept` triggers a full
  // proposal refetch plus a `memesh:data-changed` reload of the other tabs, so a
  // normal human review session legitimately passes 100 requests / 15 min. On
  // loopback there is no auth to begin with (bearerAuth is only enforced
  // off-loopback — process-owner UNIX semantics are the trust boundary there),
  // so a per-IP request cap protects nothing a local process couldn't already do
  // by reading ~/.memesh directly. The limiter is an abuse control for EXPOSED
  // (--allow-remote / non-loopback) instances; it applies there, and only there.
  skip: (req) => isLoopbackRequest(req),
  // Answer over-limit with the SAME {success:false, errorCode} envelope the rest
  // of the API uses. The default is a bare string body; the dashboard could not
  // parse it as an envelope and fell back to its most generic guess — "the
  // dashboard and server are out of sync, run doctor" — which is doubly wrong: on
  // an exposed instance nothing is out of sync, and the fix is to slow down, not
  // to reload. A machine code lets the client say exactly that.
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      errorCode: 'rate.limited' satisfies ErrorCode,
      error: 'Too many requests in a short time. Wait a moment and try again.',
    });
  },
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
      errorCode: 'auth.not-configured' satisfies ErrorCode,
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
    res.status(401).json({ success: false, errorCode: 'auth.missing-bearer' satisfies ErrorCode, error: 'Missing Authorization: Bearer <token>' });
    return;
  }
  const tokenPart = trimmed.slice(wsIndex + 1).trim();
  if (!tokenPart) {
    res.status(401).json({ success: false, errorCode: 'auth.missing-bearer' satisfies ErrorCode, error: 'Missing Authorization: Bearer <token>' });
    return;
  }
  const presented = Buffer.from(tokenPart, 'utf8');
  if (!constantTimeEquals(presented, remoteToken)) {
    res.status(401).json({ success: false, errorCode: 'auth.invalid-token' satisfies ErrorCode, error: 'Invalid bearer token' });
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

// Convert express.json's PayloadTooLargeError into a clean 413 JSON
// response. Without this, clients receive Express's default HTML error
// page on oversize requests — hostile to programmatic API consumers,
// and inconsistent with the JSON-shaped errors every other handler
// emits. The 1MB limit is the documented contract (see
// docs/api/API_REFERENCE.md → "Request body limits"); this middleware
// surfaces it as data rather than markup.
//
// Implementation note: declared as a `function` expression (not an
// arrow) so that Express's 4-arg arity detection (used to distinguish
// error handlers from regular middleware) survives any downstream code
// transformation that might rename or drop unused parameters.
function payloadTooLargeHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!err || typeof err !== 'object') return next(err);
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
  // A body that is not valid JSON used to fall through to Express's default
  // error handler: an HTML page with a full stack trace and this machine's
  // absolute paths — served to remote callers under --allow-remote. Every
  // /v1 error is JSON; this one is no exception.
  if (e.type === 'entity.parse.failed' || (err instanceof SyntaxError && (e.status === 400 || e.statusCode === 400))) {
    res.status(400).json({
      success: false,
      errorCode: 'validation.bad-body' satisfies ErrorCode,
      error: 'Request body is not valid JSON.',
      hint: 'Send a JSON object with Content-Type: application/json.',
    });
    return;
  }
  const isTooLarge = e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
  if (!isTooLarge) return next(err);
  res.status(413).json({
    success: false,
    errorCode: 'payload.too-large' satisfies ErrorCode,
    error: 'Request body exceeds the 1MB limit',
    code: 'PAYLOAD_TOO_LARGE',
    limit: '1mb',
    hint: 'Split large exports/imports into smaller batches, or stream them via the CLI (`memesh export` / `memesh import`) which reads/writes files directly and is not subject to the per-request 1MB cap.',
  });
}
app.use('/v1/', payloadTooLargeHandler);

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
        errorCode: 'server.internal' satisfies ErrorCode,
        error: 'Database not initialized',
        details: 'MeMesh database failed to open at startup. Check server logs for details, or run "memesh doctor" to diagnose.',
      });
    } else {
      res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: message });
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
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

// DX: every POST endpoint used to repeat a 10-line safeParse + 400
// error mapping + try/catch + 200/400 block. handlePost factors that
// into one place. Async handlers are fine — Promise.resolve unifies
// sync (remember/forget) and async (consolidate) code paths.
/**
 * express.json() only parses Content-Type: application/json; anything else
 * leaves req.body undefined, and the Zod message for that ("expected object,
 * received undefined") sent users off to fix their BODY when the problem was
 * the header. One owner: the review of the first version found the guard in
 * handlePost while the three hand-rolled POST routes (recall, config,
 * config/test) still emitted the confusing message.
 */
function requireJsonBody(req: Request, res: Response): boolean {
  if (req.body !== undefined) return true;
  res.status(400).json({
    success: false,
    errorCode: 'validation.bad-body' satisfies ErrorCode,
    error: 'No JSON body was parsed from this request.',
    hint: 'Send the payload with Content-Type: application/json.',
  });
  return false;
}

function handlePost<T>(
  schema: z.ZodType<T>,
  req: Request,
  res: Response,
  handler: (data: T) => unknown | Promise<unknown>,
): void {
  if (!requireJsonBody(req, res)) return;
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      errorCode: 'validation.bad-body' satisfies ErrorCode,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  // `Promise.resolve().then(() => handler(...))`, not
  // `Promise.resolve(handler(...))`. The second form CALLS the handler before
  // the promise exists, so a SYNCHRONOUS throw escapes past the `.catch` below
  // and lands in Express's default error handler — which answers with an HTML
  // page. Measured: `POST /v1/verify` with a non-existent workdir returned
  // `500 text/html` carrying a stack trace and the absolute install path, to a
  // client that every other route has taught to expect JSON. `handleGet`
  // already uses this shape; this one did not.
  Promise.resolve()
    .then(() => handler(parsed.data))
    .then((data) => res.json({ success: true, data }))
    .catch((err: unknown) => res.status(400).json({ success: false, errorCode: 'operation.failed' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) }));
}

// DX: read-only GET endpoints that just compute-a-value-and-return used to
// each hand-roll the identical `try { res.json({success,data}) } catch { 500 }`
// block. handleGet factors that into one place so the server-error response
// shape (500 + `success:false`) can never drift between endpoints. Promise
// support unifies the sync (graph/stats) and async (dynamic-import) handlers.
function handleGet<T>(res: Response, produce: () => T | Promise<T>): void {
  Promise.resolve()
    .then(produce)
    .then((data) => res.json({ success: true, data }))
    .catch((err: unknown) => res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) }));
}

// --- Remember ---
app.post('/v1/remember', (req, res) => handlePost(RememberBody, req, res, remember));

// --- Recall ---
app.post('/v1/recall', async (req, res) => {
  if (!requireJsonBody(req, res)) return;
  const parsed = RecallBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errorCode: 'validation.bad-body' satisfies ErrorCode, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    // recallWithConflicts: FTS5 + sqlite-vec recall + conflict annotation,
    // owned by core so the transports can't drift on the wrapping rule.
    const { entities, conflicts } = await recallWithConflicts(parsed.data);
    res.json({ success: true, data: conflicts.length > 0 ? { entities, conflicts } : entities });
  } catch (err) {
    res.status(400).json({ success: false, errorCode: 'operation.failed' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Forget / Consolidate / Export / Import / Learn / Verify ---
// All 6 follow the same shape; handlePost above does the heavy lifting.
app.post('/v1/forget',      (req, res) => handlePost(ForgetBody, req, res, forget));
// `/v1/consolidate` is retired, and answers 410 rather than 404 because the two
// mean different things to a script: 404 reads as a typo or a bad base URL and
// invites a retry, 410 says the resource is gone on purpose and names what to
// do instead. The tool compressed an entity's observations by deleting them and
// writing an LLM summary back, with no proposal, no review and no way to
// recover the originals — see the CHANGELOG entry for what that cost. `dream`
// does the reviewed version of the same idea.
//
// Deletable at the next major, once no caller can plausibly still be pointing
// here. Until then this line is the only thing standing between a script and a
// silent 404.
app.post('/v1/consolidate', (_req, res) => {
  res.status(410).json({ success: false, errorCode: 'route.retired' satisfies ErrorCode, error: RETIRED_ROUTES['/v1/consolidate'] });
});
app.post('/v1/export',      (req, res) => handlePost(ExportBody, req, res, exportMemories));
app.post('/v1/import',      (req, res) => handlePost(ImportBody, req, res, importMemories));
app.post('/v1/learn',       (req, res) => handlePost(LearnBody, req, res, learn));
app.post('/v1/verify',      (req, res) => handlePost(VerifyBody, req, res, verifyAgentWork));

// --- Config ---
/**
 * Redact every apiKey in an `{ llm, llmFallbacks }`-shaped object before it
 * leaves the process over the wire. Masks the primary `llm.apiKey` AND every
 * entry in the `llmFallbacks` chain.
 *
 * Single owner for BOTH the GET and POST /v1/config responses: previously each
 * handler hand-rolled its own masking, and the POST copy masked only
 * `llm.apiKey` — so a saved fallback provider's key was echoed back to the
 * dashboard SPA in plaintext. Routing both surfaces through one helper makes
 * that drift impossible. Returns a shallow clone; the stored config is untouched.
 */
// The placeholder every masked key is rendered as. A write surface must treat
// an incoming value equal to this as "the user left the stored key untouched",
// NOT as a real key — otherwise a client that round-trips GET→POST verbatim
// (a second tab, a script) would overwrite the real key with the literal mask
// and the next provider call fails auth. One constant so the mask and the
// treat-as-omitted check can never drift apart.
const API_KEY_MASK = '***';

function maskLlmSecrets<T extends {
  llm?: { apiKey?: string } | null;
  llmFallbacks?: Array<{ apiKey?: string } | null> | null;
}>(obj: T): T {
  const masked: T = { ...obj };
  if (masked.llm?.apiKey) {
    masked.llm = { ...masked.llm, apiKey: API_KEY_MASK };
  }
  if (Array.isArray(masked.llmFallbacks) && masked.llmFallbacks.length > 0) {
    masked.llmFallbacks = masked.llmFallbacks.map(fb =>
      fb?.apiKey ? { ...fb, apiKey: API_KEY_MASK } : fb
    );
  }
  return masked;
}

// `keepKeyFrom` is a WIRE-ONLY field: the SPA sends it to say "reuse the key
// stored at this original index"; it is never persisted. Stripped in
// preserveFallbackApiKeys before the entry reaches updateConfig.
type IncomingFallback = { provider: 'anthropic' | 'openai' | 'ollama'; model?: string; apiKey?: string; keepKeyFrom?: number | null };
type FallbackEntry = { provider: 'anthropic' | 'openai' | 'ollama'; model?: string; apiKey?: string };

/**
 * Restore the stored apiKey on fallback entries the dashboard sent WITHOUT one.
 *
 * The GET response masks every fallback key as '***', and the SPA is built to
 * NOT re-send that mask — it omits the apiKey for a cloud entry whose key the
 * user never retyped (mirroring the primary provider's "leave it and it stays"
 * behaviour). But unlike the primary `llm`, which `updateConfig` deep-merges,
 * `llmFallbacks` is written wholesale (it rides the generic `{...partialRest}`
 * spread). So an omitted key would be DROPPED — a saved credential silently
 * lost while the response still says "saved". That is the exact fake-working
 * class this project guards against, so the write surface has to close it.
 *
 * Identity is EXPLICIT, never positional. Each keyless entry that wants to keep
 * a stored key carries `keepKeyFrom` = the index it originally loaded from; the
 * SPA moves that field with the entry across reorders and removals, and sets it
 * to null when the entry is new, had its key retyped, or had its provider
 * changed. We look the key up at exactly that index (guarded by a provider
 * match, so a stale/forged index can never graft one provider's key onto
 * another). Positional matching was wrong: with two same-provider entries it
 * swapped their keys on reorder, gave a survivor the deleted entry's key on
 * removal, and grafted an unrelated key onto a provider-changed row. An entry
 * that carries an apiKey is a freshly entered credential and wins outright.
 * `keepKeyFrom` itself is stripped from the returned entry — it is never stored.
 */
function preserveFallbackApiKeys(incoming: IncomingFallback[], stored: LLMConfig[] | undefined): FallbackEntry[] {
  return incoming.map((entry) => {
    const { keepKeyFrom, ...clean } = entry;
    // The mask is not a real key. Treat it as omitted so it is refilled from
    // storage (or dropped) — never persisted as the literal '***', which would
    // silently overwrite the real key and break the next call to that provider.
    if (clean.apiKey === API_KEY_MASK) delete clean.apiKey;
    if (clean.apiKey) return clean;
    if (typeof keepKeyFrom === 'number' && stored && keepKeyFrom >= 0 && keepKeyFrom < stored.length) {
      const src = stored[keepKeyFrom];
      if (src && src.provider === clean.provider && src.apiKey) {
        return { ...clean, apiKey: src.apiKey };
      }
    }
    return clean;
  });
}

app.get('/v1/config', (_req, res) => {
  try {
    const config = readConfig();
    const caps = detectCapabilities(config);
    // detectCapabilities returns the llm config with the raw key, so mask both
    // the config and the capabilities view before returning them.
    res.json({ success: true, data: { config: maskLlmSecrets(config), capabilities: maskLlmSecrets(caps) } });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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
    // Wire-only: "reuse the key stored at this original index". The nested
    // z.object() strips unknown keys, so without declaring it here the SPA's
    // keep-my-stored-key signal would be dropped before preserveFallbackApiKeys
    // ever saw it. Resolved and then stripped there — never persisted.
    keepKeyFrom: z.number().int().nonnegative().nullable().optional(),
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
  // Output language for LLM-generated content (dreamer digests, patterns,
  // lessons, validator reasons). Free-form — a locale code ('zh-TW') or a
  // language name ('繁體中文'); it becomes a prompt instruction, not a
  // parsed locale. The 60-char cap mirrors MAX_LANGUAGE_LENGTH in
  // src/core/output-language.ts. This is the write surface the dashboard
  // uses so its locale picker can ALSO localise generated content —
  // without this entry, ConfigBody.strip() silently drops the field.
  //
  // Control characters are rejected outright (mirrors the CLI validator,
  // both via core/output-language.ts languageValueError): the value lands
  // inside every content-generating LLM prompt, and a newline would let
  // it smuggle in a free-standing instruction line. sanitizeForPrompt
  // deliberately preserves \n, so the gate has to be here.
  language: z.string().trim().min(1).max(60)
    .refine((v) => languageValueError(v) === null, {
      message: 'language must not contain line breaks or other control characters',
    })
    .optional(),
  setupCompleted: z.boolean().optional(),
}).strip();

app.post('/v1/config', async (req, res) => {
  if (!requireJsonBody(req, res)) return;
  const parsed = ConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errorCode: 'validation.bad-body' satisfies ErrorCode, error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  try {
    // NOTE: the read-modify-write across `before`/`updateConfig` is non-atomic.
    // Acceptable for the single-user MeMesh dashboard; revisit if the HTTP API
    // ever serves multi-tenant config writes.
    const before = readConfig();
    // Backstop the PRIMARY llm key the same way as the fallbacks: a posted-back
    // mask means "keep the stored key", never "set the key to '***'". Refill
    // from the prior config when the provider matches; otherwise strip the
    // placeholder so the literal mask is never persisted as a real credential.
    if (parsed.data.llm && parsed.data.llm.apiKey === API_KEY_MASK) {
      if (before.llm && before.llm.provider === parsed.data.llm.provider && before.llm.apiKey) {
        parsed.data.llm.apiKey = before.llm.apiKey;
      } else {
        delete parsed.data.llm.apiKey;
      }
    }
    // Refill any fallback apiKey the SPA omitted because the user left a
    // stored (masked) key untouched — otherwise the wholesale llmFallbacks
    // write would drop it. See preserveFallbackApiKeys.
    if (parsed.data.llmFallbacks) {
      parsed.data.llmFallbacks = preserveFallbackApiKeys(parsed.data.llmFallbacks, before.llmFallbacks);
    }
    const updated = updateConfig(parsed.data);
    // The embedder holds no cached provider/pipeline state: every embedText()
    // reads config fresh, so a config change takes effect on the next call
    // with no reset needed and no "restart server to apply" footgun.
    // Mask every apiKey (primary + fallback chain) before returning — same
    // helper the GET handler uses, so the response can't leak a saved
    // llmFallbacks[].apiKey in plaintext.
    res.json({ success: true, data: maskLlmSecrets(updated) });
  } catch (err) {
    res.status(400).json({ success: false, errorCode: 'operation.failed' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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
  // Dashboard "Test" on a FALLBACK entry whose key is stored (masked) and
  // untouched: the SPA sends the entry's original index here instead of the
  // key. We resolve the key from llmFallbacks[fallbackIndex] so the probe
  // tests the ENTRY'S OWN credential — not the primary provider's key (a
  // false green on the wrong account) and not nothing (a false 401 that
  // contradicts the "a key is saved" hint shown next to the button).
  fallbackIndex: z.number().int().nonnegative().optional(),
});

app.post('/v1/config/test', async (req, res) => {
  if (!requireJsonBody(req, res)) return;
  const parsed = ConfigTestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      errorCode: 'validation.bad-body' satisfies ErrorCode,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }
  try {
    const { probeProvider } = await import('../../core/llm-validator.js');
    const { provider, host, fallbackIndex } = parsed.data;
    let { apiKey } = parsed.data;
    // If the caller omits apiKey, fall back to the one already saved — lets the
    // dashboard offer "Test with current settings" without forcing the user to
    // re-enter a key they previously saved. A `fallbackIndex` means the caller
    // is testing a specific fallback entry, so resolve THAT entry's stored key
    // (provider-guarded); otherwise resolve the primary provider's key. The two
    // are mutually exclusive on purpose — a fallback test must never silently
    // borrow the primary's credential.
    if (!apiKey && (provider === 'anthropic' || provider === 'openai')) {
      const existing = readConfig();
      if (typeof fallbackIndex === 'number') {
        const fb = existing.llmFallbacks?.[fallbackIndex];
        if (fb && fb.provider === provider && fb.apiKey) apiKey = fb.apiKey;
      } else if (existing.llm?.provider === provider && existing.llm.apiKey) {
        apiKey = existing.llm.apiKey;
      }
    }
    const result = await probeProvider(provider, apiKey, host);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Graph / Stats / Analytics ---
// All three pull pure read-only aggregations from the DB. Their query
// shapes used to be inlined here; they now live in src/core/{graph,stats,
// analytics}.ts so CLI/MCP can call the same logic without re-implementing
// the SQL.
app.get('/v1/graph', (_req, res) => handleGet(res, () => computeGraph(getDatabase())));
app.get('/v1/stats', (_req, res) => handleGet(res, () => computeStats(getDatabase())));
app.get('/v1/analytics', (_req, res) => handleGet(res, () => computeAnalytics(getDatabase())));
app.get('/v1/analytics/pm', (req, res) => {
  const raw = req.query.window;
  const window = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  const windowDays = Number.isFinite(window) && window > 0 ? window : 30;
  handleGet(res, () => computePmAnalytics(getDatabase(), windowDays));
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
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});
app.post('/v1/demo/reset', async (_req, res) => {
  try {
    const { seedDemo } = await import('../../core/demo.js');
    const data = seedDemo(getDatabase(), { reset: true });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Projects ---
//
// Lists distinct projects extracted from entity tags (`project:*`) and entity
// name prefixes. Used by the dashboard Browse / Lessons tabs to populate
// per-project filter chips so users can scope memory exploration to one
// codebase at a time.
app.get('/v1/projects', (_req, res) => handleGet(res, () => computeProjects(getDatabase())));

// --- Patterns ---
app.get('/v1/patterns', (_req, res) => handleGet(res, () => computePatterns(getDatabase())));

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
      res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: parsed.error.issues.map(i => i.message).join('; ') });
      return;
    }
    const { summariseTelemetry } = await import('../../core/llm-telemetry.js');
    const summaries = summariseTelemetry(parsed.data.window);
    res.json({ success: true, data: { window_days: parsed.data.window, summaries } });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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
      res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: parsed.error.issues.map(i => i.message).join('; ') });
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
    }).catch((err: unknown) => res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) }));
  } catch (err) { res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) }); }
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
    res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: 'invalid id' });
    return;
  }
  try {
    const row = getDatabase().prepare(
      'SELECT id, project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, status, reason, created_at, reviewed_at FROM dream_proposals WHERE id = ?'
    ).get(id) as { proposed_digest: string; source_ids: string; [k: string]: unknown } | undefined;
    if (!row) {
      res.status(404).json({ success: false, errorCode: 'resource.not-found' satisfies ErrorCode, error: `proposal #${id} not found` });
      return;
    }
    let digest: unknown = null;
    let sourceIds: number[] = [];
    try { digest = JSON.parse(row.proposed_digest); } catch { /* corrupt — surface as null */ }
    try { sourceIds = JSON.parse(row.source_ids); } catch { /* leave empty */ }
    res.json({ success: true, data: { ...row, proposed_digest: digest, source_ids: sourceIds } });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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
      errorCode: 'validation.bad-body' satisfies ErrorCode,
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
        errorCode: 'llm.not-configured' satisfies ErrorCode,
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
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/v1/dream/proposals/:id/accept', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: 'invalid id' });
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
      res.status(404).json({ success: false, errorCode: 'resource.not-found' satisfies ErrorCode, error: msg });
    } else {
      res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: msg });
    }
  }
});

const RejectBodySchema = z.object({
  reason: z.string().max(500).optional(),
});
app.post('/v1/dream/proposals/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: 'invalid id' });
    return;
  }
  const parsed = RejectBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, errorCode: 'validation.bad-body' satisfies ErrorCode, error: parsed.error.issues.map(i => i.message).join('; ') });
    return;
  }
  try {
    const { rejectProposal } = await import('../../core/dreamer.js');
    rejectProposal(getDatabase(), id, parsed.data.reason);
    res.json({ success: true, data: { id, status: 'rejected' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found or not pending/.test(msg)) {
      res.status(404).json({ success: false, errorCode: 'resource.not-found' satisfies ErrorCode, error: msg });
    } else {
      res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: msg });
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
      res.status(400).json({ success: false, errorCode: 'validation.bad-param' satisfies ErrorCode, error: `Invalid query: ${parsed.error.message}` });
      return;
    }
    const { type: typeFilter, limit, status } = parsed.data;
    const includeArchived = status === 'all';

    const db = getDatabase();
    const kg = new KnowledgeGraph(db);

    const entities = typeFilter
      ? kg.listByType(typeFilter, limit, includeArchived)
      : kg.listRecent(limit, includeArchived);
    res.json({ success: true, data: entities });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Get single entity ---
app.get('/v1/entities/:name', (req, res) => {
  try {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    const entity = kg.getEntity(req.params.name);
    if (!entity) {
      res.status(404).json({ success: false, errorCode: 'resource.not-found' satisfies ErrorCode, error: `Entity "${req.params.name}" not found` });
      return;
    }
    res.json({ success: true, data: entity });
  } catch (err) {
    res.status(500).json({ success: false, errorCode: 'server.internal' satisfies ErrorCode, error: err instanceof Error ? err.message : String(err) });
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

// JSON 404 catch-all — MUST be registered after every route + middleware.
// Without this, Express falls back to its default text/html 404 page,
// which breaks the JSON contract every other route honors: clients
// (CLI, dashboard, third-party) that pipe responses into `JSON.parse`
// choke on `<!DOCTYPE html>`. Loopback /v1/health, /favicon.ico, and
// /dashboard are matched above and never reach this layer.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    errorCode: 'route.not-found' satisfies ErrorCode,
    code: 'NOT_FOUND',
    error: `No route for ${req.method} ${req.path}`,
  });
});

export function startServer(
  host = HOST,
  port = PORT,
  opts?: {
    allowRemote?: boolean;
    /**
     * Opt-IN to the background update-cache fill. Only the CLI `serve`
     * command sets this — a user-launched, long-lived, online server.
     * Inference from VITEST/NODE_ENV was tried first and was wrong twice
     * over: `npm run build`'s smoke test and the packaged-dashboard e2e
     * both start real servers outside any test runner, and were making
     * live npm-registry calls (the local one writing into the
     * developer's real ~/.memesh) on every build.
     */
    autoUpdateCheck?: boolean;
    /** Test seams for the background update-cache fill. */
    updateCheckImpl?: typeof checkForUpdate;
    lastUpdateCheckImpl?: typeof getLastUpdateCheck;
  }
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
  // A running server IS online, so it fills the npm update-check cache
  // itself instead of asking the user to. The doctor used to WARN "no
  // cached npm update check yet — run `memesh status` once while online",
  // and the dashboard nagged it on every tab; the user's verdict on being
  // told to run a command whose only effect the server can produce itself:
  // 「脫褲子放屁」. Fire-and-forget: never delays listen, skips when the
  // cache is already fresh, and stays silent on failure — doctor and
  // `memesh status` keep reporting the cache state honestly, so a
  // swallowed error here hides nothing. Strictly opt-in (see the option
  // doc above) with an env kill-switch for automation that spawns the
  // real CLI, e.g. the packaged-dashboard e2e smoke.
  const injectedUpdateSeam = Boolean(opts?.updateCheckImpl || opts?.lastUpdateCheckImpl);
  const updateCheckWanted = opts?.autoUpdateCheck === true || injectedUpdateSeam;
  if (updateCheckWanted && !process.env.MEMESH_SKIP_UPDATE_CHECK) {
    void (async () => {
      const readLast = opts?.lastUpdateCheckImpl ?? getLastUpdateCheck;
      const refresh = opts?.updateCheckImpl ?? checkForUpdate;
      const cached = readLast(packageVersion);
      if (cached && (cached.freshness === 'fresh' || cached.freshness === 'cached')) return;
      await refresh(packageVersion);
    })().catch(() => { /* offline is fine */ });
  }

  const server = app.listen(port, host, () => {
    // F15: Show actual bound address, not the input parameter. When port=0
    // (random port), the input shows "http://127.0.0.1:0" which is confusing.
    //
    // There is no `else` branch any more, and its absence is the fix. It
    // printed the REQUESTED host:port whenever `server.address()` came back
    // null — which is exactly what happens when the bind failed. Measured: with
    // another process holding the port, `memesh serve` printed
    // "running at http://127.0.0.1:3972", printed the dashboard URL, and exited
    // 0. The user opens that URL and sees somebody else's knowledge graph, with
    // nothing anywhere saying why, and any supervisor or CI step records a
    // successful start. Announcing a server we did not bind is worse than
    // saying nothing.
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      console.log(`MeMesh HTTP server running at http://${addr.address}:${addr.port}`);
      console.log(`MeMesh dashboard: http://${addr.address}:${addr.port}/dashboard`);
    }
  });

  // And the reason the bind failed has to reach the user. Without this there
  // was no 'error' listener at all, so Node's default took over — the process
  // died (or, worse, the callback above had already claimed success).
  server.on('error', (err: NodeJS.ErrnoException) => {
    const where = `${host}:${port}`;
    if (err.code === 'EADDRINUSE') {
      console.error(`MeMesh: cannot start — ${where} is already in use.`);
      console.error(`MeMesh: stop whatever is listening there, or pick another port with --port <n>.`);
    } else if (err.code === 'EACCES') {
      console.error(`MeMesh: cannot start — not permitted to bind ${where}.`);
      console.error(`MeMesh: ports below 1024 need elevated privileges; pick a port above 1024 with --port <n>.`);
    } else {
      console.error(`MeMesh: cannot start on ${where} — ${err.message}`);
    }
    process.exit(1);
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
