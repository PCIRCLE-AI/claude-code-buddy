#!/usr/bin/env node
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'crypto';
import { openDatabase, closeDatabase, getDatabase } from '../../db.js';
import { remember, recallWithConflicts, forget, exportMemories, importMemories, learn } from '../../core/operations.js';
import { KnowledgeGraph } from '../../knowledge-graph.js';
import { logCapabilities, readConfig, updateConfig, detectCapabilities } from '../../core/config.js';
import { languageValueError } from '../../core/output-language.js';
import { computePatterns } from '../../core/patterns.js';
import { computeAnalytics, computePmAnalytics } from '../../core/analytics.js';
import { computeStats } from '../../core/stats.js';
import { computeProjects } from '../../core/projects.js';
import { computeGraph } from '../../core/graph.js';
import { verifyAgentWork } from '../../core/verifier.js';
import { RememberSchema as RememberBody, RecallSchema as RecallBody, ForgetSchema as ForgetBody, ExportSchema as ExportBody, ImportSchema as ImportBody, LearnSchema as LearnBody, VerifyAgentWorkSchema as VerifyBody, } from '../schemas.js';
import { checkForUpdate, getLastUpdateCheck, getUpdateCheck } from '../../core/version-check.js';
import { getCurrentInstallChannel, getInstallChannelSupport } from '../../core/install-channel.js';
import { getDbPath, getMemeshDirFromDbPath, redactSecrets, redactUserPaths } from '../../core/paths.js';
import { RETIRED_ROUTES } from './retired-routes.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json');
const packageRoot = path.dirname(packageJsonPath);
const packageVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version ?? '0.0.0';
const app = express();
export function isLoopbackRequest(req) {
    const ip = req.ip ?? '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => isLoopbackRequest(req),
    handler: (_req, res) => {
        res.status(429).json({
            success: false,
            errorCode: 'rate.limited',
            error: 'Too many requests in a short time. Wait a moment and try again.',
        });
    },
});
let remoteToken = null;
const serverAuthRequired = new WeakMap();
function memeshDir() {
    return getMemeshDirFromDbPath();
}
function loadOrCreateRemoteToken() {
    const fromEnv = process.env.MEMESH_REMOTE_TOKEN;
    if (fromEnv && fromEnv.length >= 16) {
        return { token: Buffer.from(fromEnv, 'utf8'), freshlyCreated: false };
    }
    const dir = memeshDir();
    const tokenPath = path.join(dir, 'remote-token');
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch { }
    const generated = randomBytes(32).toString('hex');
    try {
        const fd = fs.openSync(tokenPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        try {
            fs.writeFileSync(fd, generated + '\n');
        }
        finally {
            fs.closeSync(fd);
        }
        try {
            fs.chmodSync(tokenPath, 0o600);
        }
        catch { }
        return { token: Buffer.from(generated, 'utf8'), freshlyCreated: true };
    }
    catch (err) {
        if (err?.code !== 'EEXIST')
            throw err;
    }
    const value = fs.readFileSync(tokenPath, 'utf8').trim();
    if (value.length < 16) {
        throw new Error(`Existing ${tokenPath} is too short (<16 chars). Delete it and restart memesh-http to regenerate.`);
    }
    try {
        fs.chmodSync(tokenPath, 0o600);
    }
    catch { }
    return { token: Buffer.from(value, 'utf8'), freshlyCreated: false };
}
function constantTimeEquals(a, b) {
    const max = Math.max(a.length, b.length);
    const aPad = Buffer.alloc(max);
    const bPad = Buffer.alloc(max);
    a.copy(aPad);
    b.copy(bPad);
    const eq = timingSafeEqual(aPad, bPad);
    return eq && a.length === b.length;
}
function bearerAuth(req, res, next) {
    const ownerServer = req.socket.server;
    const requiresAuth = ownerServer ? (serverAuthRequired.get(ownerServer) ?? false) : false;
    if (!requiresAuth) {
        next();
        return;
    }
    if (!remoteToken) {
        res.status(503).json({
            success: false,
            errorCode: 'auth.not-configured',
            error: 'remote bearer auth not configured on this server',
        });
        return;
    }
    const header = req.header('authorization') || req.header('Authorization') || '';
    const trimmed = header.trim();
    const wsIndex = trimmed.search(/\s/);
    if (wsIndex < 0 || trimmed.slice(0, wsIndex).toLowerCase() !== 'bearer') {
        res.status(401).json({ success: false, errorCode: 'auth.missing-bearer', error: 'Missing Authorization: Bearer <token>' });
        return;
    }
    const tokenPart = trimmed.slice(wsIndex + 1).trim();
    if (!tokenPart) {
        res.status(401).json({ success: false, errorCode: 'auth.missing-bearer', error: 'Missing Authorization: Bearer <token>' });
        return;
    }
    const presented = Buffer.from(tokenPart, 'utf8');
    if (!constantTimeEquals(presented, remoteToken)) {
        res.status(401).json({ success: false, errorCode: 'auth.invalid-token', error: 'Invalid bearer token' });
        return;
    }
    next();
}
app.use('/v1/', bearerAuth);
app.use('/v1/', apiLimiter);
app.use('/v1/', express.json({ limit: '1mb' }));
function payloadTooLargeHandler(err, _req, res, next) {
    if (!err || typeof err !== 'object')
        return next(err);
    const e = err;
    if (e.type === 'entity.parse.failed' || (err instanceof SyntaxError && (e.status === 400 || e.statusCode === 400))) {
        res.status(400).json({
            success: false,
            errorCode: 'validation.bad-body',
            error: 'Request body is not valid JSON.',
            hint: 'Send a JSON object with Content-Type: application/json.',
        });
        return;
    }
    const isTooLarge = e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
    if (!isTooLarge)
        return next(err);
    res.status(413).json({
        success: false,
        errorCode: 'payload.too-large',
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
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
app.get('/dashboard', (_req, res) => {
    const dashboardPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dashboard/dist/index.html');
    if (fs.existsSync(dashboardPath)) {
        res.type('html').sendFile(dashboardPath, { dotfiles: 'allow' });
    }
    else {
        import('../../cli/view-live.js')
            .then(m => res.type('html').send(m.generateLiveDashboardHtml()))
            .catch(() => res.status(500).send('Dashboard unavailable'));
    }
});
app.get('/v1/health', (_req, res) => {
    try {
        const db = getDatabase();
        const count = db.prepare('SELECT COUNT(*) as c FROM entities').get();
        res.json({ success: true, data: { status: 'ok', version: packageVersion, entity_count: count.c } });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'Database not opened') {
            res.status(503).json({
                success: false,
                errorCode: 'server.internal',
                error: 'Database not initialized',
                details: 'MeMesh database failed to open at startup. Check server logs for details, or run "memesh doctor" to diagnose.',
            });
        }
        else {
            res.status(500).json({ success: false, errorCode: 'server.internal', error: message });
        }
    }
});
app.get('/v1/doctor', async (_req, res) => {
    try {
        const { runDoctor } = await import('../../core/doctor.js');
        const result = await runDoctor({
            packageRoot,
            packageVersion,
        });
        const safe = JSON.parse(redactUserPaths(redactSecrets(JSON.stringify(result))));
        res.json({ success: true, data: safe });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
function requireJsonBody(req, res) {
    if (req.body !== undefined)
        return true;
    res.status(400).json({
        success: false,
        errorCode: 'validation.bad-body',
        error: 'No JSON body was parsed from this request.',
        hint: 'Send the payload with Content-Type: application/json.',
    });
    return false;
}
function handlePost(schema, req, res, handler) {
    if (!requireJsonBody(req, res))
        return;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            errorCode: 'validation.bad-body',
            error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
    }
    Promise.resolve()
        .then(() => handler(parsed.data))
        .then((data) => res.json({ success: true, data }))
        .catch((err) => res.status(400).json({ success: false, errorCode: 'operation.failed', error: err instanceof Error ? err.message : String(err) }));
}
function handleGet(res, produce) {
    Promise.resolve()
        .then(produce)
        .then((data) => res.json({ success: true, data }))
        .catch((err) => res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) }));
}
app.post('/v1/remember', (req, res) => handlePost(RememberBody, req, res, (data) => remember({ ...data, sourceHost: 'http' })));
app.post('/v1/recall', async (req, res) => {
    if (!requireJsonBody(req, res))
        return;
    const parsed = RecallBody.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-body', error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
    }
    try {
        const { entities, conflicts } = await recallWithConflicts(parsed.data);
        res.json({ success: true, data: conflicts.length > 0 ? { entities, conflicts } : entities });
    }
    catch (err) {
        res.status(400).json({ success: false, errorCode: 'operation.failed', error: err instanceof Error ? err.message : String(err) });
    }
});
app.post('/v1/forget', (req, res) => handlePost(ForgetBody, req, res, forget));
app.post('/v1/consolidate', (_req, res) => {
    res.status(410).json({ success: false, errorCode: 'route.retired', error: RETIRED_ROUTES['/v1/consolidate'] });
});
app.post('/v1/export', (req, res) => handlePost(ExportBody, req, res, exportMemories));
app.post('/v1/import', (req, res) => handlePost(ImportBody, req, res, importMemories));
app.post('/v1/learn', (req, res) => handlePost(LearnBody, req, res, (data) => learn({ ...data, sourceHost: 'http' })));
app.post('/v1/verify', (req, res) => handlePost(VerifyBody, req, res, verifyAgentWork));
const API_KEY_MASK = '***';
function maskLlmSecrets(obj) {
    const masked = { ...obj };
    if (masked.llm?.apiKey) {
        masked.llm = { ...masked.llm, apiKey: API_KEY_MASK };
    }
    if (Array.isArray(masked.llmFallbacks) && masked.llmFallbacks.length > 0) {
        masked.llmFallbacks = masked.llmFallbacks.map(fb => fb?.apiKey ? { ...fb, apiKey: API_KEY_MASK } : fb);
    }
    return masked;
}
function preserveFallbackApiKeys(incoming, stored) {
    return incoming.map((entry) => {
        const { keepKeyFrom, ...clean } = entry;
        if (clean.apiKey === API_KEY_MASK)
            delete clean.apiKey;
        if (clean.apiKey)
            return clean;
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
        res.json({ success: true, data: { config: maskLlmSecrets(config), capabilities: maskLlmSecrets(caps) } });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
const ConfigBody = z.object({
    llm: z.union([
        z.object({
            provider: z.enum(['anthropic', 'openai', 'ollama']),
            model: z.string().optional(),
            apiKey: z.string().optional(),
        }),
        z.null(),
    ]).optional(),
    llmFallbacks: z.array(z.object({
        provider: z.enum(['anthropic', 'openai', 'ollama']),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        keepKeyFrom: z.number().int().nonnegative().nullable().optional(),
    })).optional(),
    autoCapture: z.boolean().optional(),
    sessionLimit: z.number().int().min(1).max(100).optional(),
    enableAgenticOrchestration: z.boolean().optional(),
    autoUpdate: z.enum(['off', 'patch', 'minor', 'major']).optional(),
    language: z.string().trim().min(1).max(60)
        .refine((v) => languageValueError(v) === null, {
        message: 'language must not contain line breaks or other control characters',
    })
        .optional(),
    setupCompleted: z.boolean().optional(),
}).strip();
app.post('/v1/config', async (req, res) => {
    if (!requireJsonBody(req, res))
        return;
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-body', error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
    }
    try {
        const before = readConfig();
        if (parsed.data.llm && parsed.data.llm.apiKey === API_KEY_MASK) {
            if (before.llm && before.llm.provider === parsed.data.llm.provider && before.llm.apiKey) {
                parsed.data.llm.apiKey = before.llm.apiKey;
            }
            else {
                delete parsed.data.llm.apiKey;
            }
        }
        if (parsed.data.llmFallbacks) {
            parsed.data.llmFallbacks = preserveFallbackApiKeys(parsed.data.llmFallbacks, before.llmFallbacks);
        }
        const updated = updateConfig(parsed.data);
        res.json({ success: true, data: maskLlmSecrets(updated) });
    }
    catch (err) {
        res.status(400).json({ success: false, errorCode: 'operation.failed', error: err instanceof Error ? err.message : String(err) });
    }
});
const ConfigTestBody = z.object({
    provider: z.enum(['anthropic', 'openai', 'ollama']),
    apiKey: z.string().max(500).optional(),
    host: z.string().max(500).optional(),
    fallbackIndex: z.number().int().nonnegative().optional(),
});
app.post('/v1/config/test', async (req, res) => {
    if (!requireJsonBody(req, res))
        return;
    const parsed = ConfigTestBody.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            errorCode: 'validation.bad-body',
            error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
    }
    try {
        const { probeProvider } = await import('../../core/llm-validator.js');
        const { provider, host, fallbackIndex } = parsed.data;
        let { apiKey } = parsed.data;
        if (!apiKey && (provider === 'anthropic' || provider === 'openai')) {
            const existing = readConfig();
            if (typeof fallbackIndex === 'number') {
                const fb = existing.llmFallbacks?.[fallbackIndex];
                if (fb && fb.provider === provider && fb.apiKey)
                    apiKey = fb.apiKey;
            }
            else if (existing.llm?.provider === provider && existing.llm.apiKey) {
                apiKey = existing.llm.apiKey;
            }
        }
        const result = await probeProvider(provider, apiKey, host);
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
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
                recommendedCommand: (update?.currentVersionDeprecated
                    && update.latestVersion
                    && update.latestVersion === update.currentVersion
                    && update.freshness === 'fresh') ? null : installSupport.recommendedCommand,
                currentVersionDeprecated: update?.currentVersionDeprecated ?? false,
                deprecationMessage: update?.deprecationMessage ?? null,
            },
        });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/v1/graph', (_req, res) => handleGet(res, () => computeGraph(getDatabase())));
app.get('/v1/stats', (_req, res) => handleGet(res, () => computeStats(getDatabase())));
app.get('/v1/analytics', (_req, res) => handleGet(res, () => computeAnalytics(getDatabase())));
app.get('/v1/analytics/pm', (req, res) => {
    const raw = req.query.window;
    const window = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    const windowDays = Number.isFinite(window) && window > 0 ? window : 30;
    handleGet(res, () => computePmAnalytics(getDatabase(), windowDays));
});
app.post('/v1/demo/seed', async (_req, res) => {
    try {
        const { seedDemo } = await import('../../core/demo.js');
        const data = seedDemo(getDatabase());
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.post('/v1/demo/reset', async (_req, res) => {
    try {
        const { seedDemo } = await import('../../core/demo.js');
        const data = seedDemo(getDatabase(), { reset: true });
        res.json({ success: true, data });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/v1/projects', (_req, res) => handleGet(res, () => computeProjects(getDatabase())));
app.get('/v1/patterns', (_req, res) => handleGet(res, () => computePatterns(getDatabase())));
const TelemetryQuerySchema = z.object({
    window: z.coerce.number().int().min(1).max(365).default(30),
});
app.get('/v1/telemetry', async (req, res) => {
    try {
        const parsed = TelemetryQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: parsed.error.issues.map(i => i.message).join('; ') });
            return;
        }
        const { summariseTelemetry } = await import('../../core/llm-telemetry.js');
        const summaries = summariseTelemetry(parsed.data.window);
        res.json({ success: true, data: { window_days: parsed.data.window, summaries } });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
const DreamProposalsQuerySchema = z.object({
    status: z.enum(['pending', 'applied', 'rejected', 'all']).default('pending'),
});
app.get('/v1/dream/proposals', (req, res) => {
    try {
        const parsed = DreamProposalsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: parsed.error.issues.map(i => i.message).join('; ') });
            return;
        }
        const status = parsed.data.status;
        import('../../core/dreamer.js').then(({ listProposals }) => {
            const db = getDatabase();
            const rows = status === 'all'
                ? [...listProposals(db, 'pending'), ...listProposals(db, 'applied'), ...listProposals(db, 'rejected')]
                : listProposals(db, status);
            res.json({ success: true, data: rows });
        }).catch((err) => res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) }));
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/v1/dream/proposals/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: 'invalid id' });
        return;
    }
    try {
        const row = getDatabase().prepare('SELECT id, project, cluster_key, source_ids, proposed_digest, llm_model, prompt_version, status, reason, created_at, reviewed_at FROM dream_proposals WHERE id = ?').get(id);
        if (!row) {
            res.status(404).json({ success: false, errorCode: 'resource.not-found', error: `proposal #${id} not found` });
            return;
        }
        let digest = null;
        let sourceIds = [];
        try {
            digest = JSON.parse(row.proposed_digest);
        }
        catch { }
        try {
            sourceIds = JSON.parse(row.source_ids);
        }
        catch { }
        res.json({ success: true, data: { ...row, proposed_digest: digest, source_ids: sourceIds } });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
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
            errorCode: 'validation.bad-body',
            error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
    }
    try {
        const { runDreamer } = await import('../../core/dreamer.js');
        const caps = detectCapabilities();
        const llm = caps.llm;
        if (!llm) {
            res.status(400).json({
                success: false,
                errorCode: 'llm.not-configured',
                error: 'No LLM configured — dream run requires Smart Mode. Configure a provider in Settings.',
            });
            return;
        }
        const result = await runDreamer(getDatabase(), llm, {
            project: parsed.data.project,
            windowDays: parsed.data.windowDays,
            maxLlmCalls: parsed.data.maxLlmCalls,
            fallbacks: caps.llmFallbacks,
            validateBeforeStage: parsed.data.validate,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.post('/v1/dream/proposals/:id/accept', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: 'invalid id' });
        return;
    }
    let NothingToClaim;
    try {
        const dreamer = await import('../../core/dreamer.js');
        NothingToClaim = dreamer.NothingToClaimError;
        const kg = new KnowledgeGraph(getDatabase());
        const result = dreamer.applyProposal(getDatabase(), id, kg);
        res.json({ success: true, data: result });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (NothingToClaim && err instanceof NothingToClaim) {
            res.status(400).json({ success: false, errorCode: 'operation.failed', error: msg });
        }
        else if (/not found or not pending/.test(msg)) {
            res.status(404).json({ success: false, errorCode: 'resource.not-found', error: msg });
        }
        else {
            res.status(500).json({ success: false, errorCode: 'server.internal', error: msg });
        }
    }
});
const RejectBodySchema = z.object({
    reason: z.string().max(500).optional(),
});
app.post('/v1/dream/proposals/:id/reject', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: 'invalid id' });
        return;
    }
    const parsed = RejectBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ success: false, errorCode: 'validation.bad-body', error: parsed.error.issues.map(i => i.message).join('; ') });
        return;
    }
    try {
        const { rejectProposal } = await import('../../core/dreamer.js');
        rejectProposal(getDatabase(), id, parsed.data.reason);
        res.json({ success: true, data: { id, status: 'rejected' } });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found or not pending/.test(msg)) {
            res.status(404).json({ success: false, errorCode: 'resource.not-found', error: msg });
        }
        else {
            res.status(500).json({ success: false, errorCode: 'server.internal', error: msg });
        }
    }
});
const EntitiesQuerySchema = z.object({
    type: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(20),
    status: z.enum(['all', 'active']).optional(),
});
app.get('/v1/entities', (req, res) => {
    try {
        const parsed = EntitiesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ success: false, errorCode: 'validation.bad-param', error: `Invalid query: ${parsed.error.message}` });
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
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/v1/entities/:name', (req, res) => {
    try {
        const db = getDatabase();
        const kg = new KnowledgeGraph(db);
        const entity = kg.getEntity(req.params.name);
        if (!entity) {
            res.status(404).json({ success: false, errorCode: 'resource.not-found', error: `Entity "${req.params.name}" not found` });
            return;
        }
        res.json({ success: true, data: entity });
    }
    catch (err) {
        res.status(500).json({ success: false, errorCode: 'server.internal', error: err instanceof Error ? err.message : String(err) });
    }
});
const HOST = process.env.MEMESH_HTTP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MEMESH_HTTP_PORT || '3737');
const ALLOW_REMOTE_BY_ENV = /^(1|true|yes)$/i.test(process.env.MEMESH_HTTP_ALLOW_REMOTE || '');
function normalizeHost(host) {
    return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}
function isLoopbackHost(host) {
    const normalized = normalizeHost(host);
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized === '127.0.0.1'
        || normalized.startsWith('127.')
        || normalized.startsWith('::ffff:127.');
}
app.use((req, res) => {
    res.status(404).json({
        success: false,
        errorCode: 'route.not-found',
        code: 'NOT_FOUND',
        error: `No route for ${req.method} ${req.path}`,
    });
});
export function startServer(host = HOST, port = PORT, opts) {
    const allowRemote = opts?.allowRemote ?? ALLOW_REMOTE_BY_ENV;
    const isRemote = !isLoopbackHost(host);
    if (!allowRemote && isRemote) {
        throw new Error(`Refusing to bind MeMesh HTTP server to non-loopback host "${host}" without explicit remote access opt-in. Use --allow-remote or MEMESH_HTTP_ALLOW_REMOTE=true.`);
    }
    if (allowRemote && !isRemote) {
        process.stderr.write(`MeMesh HTTP: --allow-remote has no effect on loopback host "${host}" — the server stays local ` +
            'and no bearer token is generated. Add --host <address> to bind somewhere reachable.\n');
    }
    if (isRemote) {
        const { token, freshlyCreated } = loadOrCreateRemoteToken();
        remoteToken = token;
        if (freshlyCreated) {
            const dir = memeshDir();
            const tokenPath = path.join(dir, 'remote-token');
            process.stderr.write(`\nMeMesh HTTP: bearer token generated for remote access.\n` +
                `  Token file: ${tokenPath} (mode 600)\n` +
                `  Use header: Authorization: Bearer <token>\n` +
                `  Rotate by deleting ${tokenPath} and restarting.\n` +
                `  Override: set MEMESH_REMOTE_TOKEN.\n\n`);
        }
        else {
            process.stderr.write(`MeMesh HTTP: remote bind requires Authorization: Bearer <token>. ` +
                `Token loaded from ${process.env.MEMESH_REMOTE_TOKEN ? 'MEMESH_REMOTE_TOKEN' : path.join(memeshDir(), 'remote-token')}.\n`);
        }
    }
    try {
        openDatabase();
        const db = getDatabase();
        db.prepare('SELECT COUNT(*) FROM entities').get();
    }
    catch (err) {
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
    const injectedUpdateSeam = Boolean(opts?.updateCheckImpl || opts?.lastUpdateCheckImpl);
    const updateCheckWanted = opts?.autoUpdateCheck === true || injectedUpdateSeam;
    if (updateCheckWanted && !process.env.MEMESH_SKIP_UPDATE_CHECK) {
        void (async () => {
            const readLast = opts?.lastUpdateCheckImpl ?? getLastUpdateCheck;
            const refresh = opts?.updateCheckImpl ?? checkForUpdate;
            const cached = readLast(packageVersion);
            if (cached && (cached.freshness === 'fresh' || cached.freshness === 'cached'))
                return;
            await refresh(packageVersion);
        })().catch(() => { });
    }
    const server = app.listen(port, host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
            console.log(`MeMesh HTTP server running at http://${addr.address}:${addr.port}`);
            console.log(`MeMesh dashboard: http://${addr.address}:${addr.port}/dashboard`);
        }
    });
    server.on('error', (err) => {
        const where = `${host}:${port}`;
        if (err.code === 'EADDRINUSE') {
            console.error(`MeMesh: cannot start — ${where} is already in use.`);
            console.error(`MeMesh: stop whatever is listening there, or pick another port with --port <n>.`);
        }
        else if (err.code === 'EACCES') {
            console.error(`MeMesh: cannot start — not permitted to bind ${where}.`);
            console.error(`MeMesh: ports below 1024 need elevated privileges; pick a port above 1024 with --port <n>.`);
        }
        else {
            console.error(`MeMesh: cannot start on ${where} — ${err.message}`);
        }
        process.exit(1);
    });
    serverAuthRequired.set(server, isRemote);
    return server;
}
export function __setRemoteTokenForTest(value) {
    remoteToken = value;
}
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.endsWith('memesh-http')) {
    let server;
    try {
        server = startServer();
    }
    catch (err) {
        console.error(`MeMesh: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    function shutdown() {
        server.close();
        try {
            closeDatabase();
        }
        catch { }
        process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
export { app };
//# sourceMappingURL=server.js.map