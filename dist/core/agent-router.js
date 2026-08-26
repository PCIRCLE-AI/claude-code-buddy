import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fetchAgentMessage, } from './agent-messaging.js';
export const AGENT_ROUTER_PROTOCOL_VERSION = 1;
export const AGENT_ROUTER_MAX_FRAME_BYTES = 64 * 1024;
export const AGENT_ROUTER_MAX_HOPS = 4;
const DEFAULT_RATE_LIMIT = 120;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 5 * 60_000;
const DEFAULT_DRAIN_LIMIT = 200;
const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;
const STALE_SOCKET_PROBE_TIMEOUT_MS = 250;
const MAX_FIELD_LENGTH = 200;
const MAX_ADAPTER_RECEIPT_BYTES = 16 * 1024;
export class AgentRouterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class AgentRouterStaleGenerationError extends AgentRouterError {
    constructor() {
        super('stale_generation', 'The session connection generation is stale or inactive.');
    }
}
export class AgentRouterProtocolError extends AgentRouterError {
}
export class AgentRouter {
    router_instance_id;
    socket_path;
    db;
    adapters;
    limits;
    server = null;
    socketIdentity = null;
    sockets = new Set();
    externalConnections = new Map();
    inFlightDeliveries = new Map();
    pendingExternal = new Map();
    constructor(options) {
        this.db = options.db;
        this.socket_path = validateSocketPath(options.socket_path);
        this.router_instance_id = validateField('router_instance_id', options.router_instance_id ?? randomUUID());
        this.limits = normalizeLimits(options.limits);
        this.adapters = new Map();
        for (const adapter of options.adapters) {
            const kind = validateField('adapter kind', adapter.kind);
            if (this.adapters.has(kind))
                throw new AgentRouterError('duplicate_adapter', `Duplicate adapter ${kind}.`);
            this.adapters.set(kind, adapter);
        }
    }
    async start() {
        if (this.server)
            throw new AgentRouterError('already_started', 'The agent router is already started.');
        const directory = path.dirname(this.socket_path);
        if (!fs.existsSync(directory))
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const directoryMode = fs.statSync(directory).mode & 0o777;
        if ((directoryMode & 0o077) !== 0) {
            throw new AgentRouterError('insecure_socket_directory', 'Router socket directory must be private.');
        }
        const server = net.createServer((socket) => this.acceptSocket(socket));
        this.server = server;
        try {
            for (;;) {
                try {
                    await listenOnSocket(server, this.socket_path);
                    break;
                }
                catch (error) {
                    if (error.code !== 'EADDRINUSE')
                        throw error;
                    if (!await removeOrphanedSocket(this.socket_path)) {
                        throw new AgentRouterError('router_already_running', 'A live or indeterminate router already owns the socket.');
                    }
                }
            }
            fs.chmodSync(this.socket_path, 0o600);
            this.socketIdentity = readSocketIdentity(this.socket_path);
        }
        catch (error) {
            this.server = null;
            this.socketIdentity = null;
            try {
                server.close();
            }
            catch { }
            throw error;
        }
    }
    async stop() {
        const server = this.server;
        if (!server)
            return;
        this.server = null;
        const socketIdentity = this.socketIdentity;
        this.socketIdentity = null;
        for (const socket of [...this.sockets]) {
            this.disconnectSocket(socket);
            socket.destroy();
        }
        await new Promise((resolve) => server.close(() => resolve()));
        if (socketIdentity)
            unlinkSocketIfSame(this.socket_path, socketIdentity);
    }
    acceptSocket(socket) {
        this.sockets.add(socket);
        let pending = Buffer.alloc(0);
        let windowStartedAt = Date.now();
        let frameCount = 0;
        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > this.limits.max_frame_bytes && !pending.includes(0x0a)) {
                this.writeError(socket, '', 'frame_too_large', 'Router frame exceeds the byte limit.');
                socket.destroy();
                return;
            }
            for (;;) {
                const newline = pending.indexOf(0x0a);
                if (newline < 0)
                    break;
                const frame = pending.subarray(0, newline);
                pending = pending.subarray(newline + 1);
                if (frame.length === 0)
                    continue;
                if (frame.length > this.limits.max_frame_bytes) {
                    this.writeError(socket, '', 'frame_too_large', 'Router frame exceeds the byte limit.');
                    socket.destroy();
                    return;
                }
                const now = Date.now();
                if (now - windowStartedAt >= this.limits.rate_window_ms) {
                    windowStartedAt = now;
                    frameCount = 0;
                }
                frameCount += 1;
                if (frameCount > this.limits.max_frames_per_window) {
                    this.writeError(socket, '', 'rate_limited', 'Router frame rate exceeded.');
                    socket.destroy();
                    return;
                }
                void this.handleFrame(socket, frame);
            }
        });
        socket.on('error', () => undefined);
        socket.on('close', () => this.disconnectSocket(socket));
    }
    async handleFrame(socket, frame) {
        let requestId = '';
        try {
            const request = parseRequest(frame, this.limits.max_hops);
            requestId = request.request_id;
            const result = await this.handleRequest(request, socket);
            this.writeResponse(socket, { version: 1, request_id: requestId, ok: true, result });
        }
        catch (error) {
            const routerError = toRouterError(error);
            this.writeError(socket, requestId, routerError.code, routerError.message);
        }
    }
    async handleRequest(request, socket) {
        switch (request.type) {
            case 'register':
                return this.register(request, socket);
            case 'notify': {
                const delivered = await this.dispatchDelivery(request.delivery_id, request.project, request.hops + 1);
                return { delivered };
            }
            case 'heartbeat': {
                const connection = this.requireCurrentConnection(request);
                this.db.transaction(() => {
                    const expiresAt = Date.now() + this.limits.lease_ms;
                    this.db.prepare(`
            UPDATE agent_session_connections SET lease_expires_at_ms = ? WHERE connection_id = ?
          `).run(expiresAt, connection.connection_id);
                    this.insertPresenceFact(connection, 'heartbeat', {});
                }).immediate();
                return { generation: connection.generation, lease_ms: this.limits.lease_ms };
            }
            case 'disconnect': {
                const connection = this.requireCurrentConnection(request);
                this.db.transaction(() => {
                    this.db.prepare(`
            UPDATE agent_session_connections
            SET disconnected_at = CURRENT_TIMESTAMP, disconnect_reason = 'adapter_disconnect'
            WHERE connection_id = ?
          `).run(connection.connection_id);
                    this.insertPresenceFact(connection, 'disconnected', { reason: 'adapter_disconnect' });
                }).immediate();
                return { disconnected: true };
            }
            case 'host_accept':
            case 'host_reject':
                return this.handleHostOutcome(request, socket);
        }
    }
    async register(request, socket) {
        const adapter = this.adapters.get(request.adapter_kind);
        if (!adapter)
            throw new AgentRouterError('adapter_unavailable', 'The requested host adapter is unavailable.');
        const registration = {
            project: request.project,
            principal_id: request.principal_id,
            session_instance_id: request.session_instance_id,
            adapter_kind: request.adapter_kind,
            ...(request.auth_token === undefined ? {} : { auth_token: request.auth_token }),
        };
        if (!await adapter.authenticate(registration)) {
            throw new AgentRouterError('authentication_failed', 'The host adapter did not authenticate this session.');
        }
        const connection = this.registerConnection(registration);
        this.bindExternalConnection(connection, socket);
        setImmediate(() => { void this.drainConnection(connection, request.hops + 1).catch(() => undefined); });
        return {
            connection_id: connection.connection_id,
            generation: connection.generation,
            lease_ms: this.limits.lease_ms,
            drain_scheduled: true,
        };
    }
    bindExternalConnection(connection, socket) {
        for (const [connectionId, bound] of this.externalConnections) {
            if (bound === socket)
                this.externalConnections.delete(connectionId);
        }
        this.externalConnections.set(connection.connection_id, socket);
    }
    disconnectSocket(socket) {
        this.sockets.delete(socket);
        for (const [connectionId, bound] of this.externalConnections) {
            if (bound !== socket)
                continue;
            this.externalConnections.delete(connectionId);
            const row = this.db.prepare(`
        SELECT connection_id, project, principal_id, session_instance_id, generation,
               adapter_kind, router_instance_id, lease_expires_at_ms
        FROM agent_session_connections WHERE connection_id = ? AND disconnected_at IS NULL
      `).get(connectionId);
            if (row) {
                this.db.transaction(() => {
                    this.db.prepare(`UPDATE agent_session_connections
            SET disconnected_at = CURRENT_TIMESTAMP, disconnect_reason = 'socket_closed'
            WHERE connection_id = ? AND disconnected_at IS NULL`).run(connectionId);
                    this.insertPresenceFact(row, 'disconnected', { reason: 'socket_closed' });
                }).immediate();
            }
            for (const [attemptId, pending] of this.pendingExternal) {
                if (pending.connection.connection_id !== connectionId)
                    continue;
                clearTimeout(pending.timer);
                this.pendingExternal.delete(attemptId);
                pending.resolve({ accepted: false, receipt: { failure_code: 'adapter_disconnected' } });
            }
        }
    }
    handleHostOutcome(request, socket) {
        const pending = this.pendingExternal.get(request.attempt_id);
        if (!pending) {
            const duplicate = this.db.prepare(`SELECT 1 FROM agent_host_accepts
        WHERE delivery_id = ? AND attempt_id = ?`).get(request.delivery_id, request.attempt_id);
            return { duplicate: Boolean(duplicate) };
        }
        if (this.externalConnections.get(request.connection_id) !== socket
            || pending.connection.connection_id !== request.connection_id
            || pending.connection.generation !== request.generation
            || pending.delivery_id !== request.delivery_id) {
            throw new AgentRouterError('outcome_scope_mismatch', 'Host outcome does not match its delivery attempt.');
        }
        clearTimeout(pending.timer);
        this.pendingExternal.delete(request.attempt_id);
        pending.resolve(request.type === 'host_accept'
            ? { accepted: true, receipt: validateReceipt(request.receipt) }
            : { accepted: false, receipt: { failure_code: request.failure_code } });
        return { correlated: true };
    }
    registerConnection(registration) {
        return this.db.transaction(() => {
            const existingPrincipal = this.db.prepare(`
        SELECT activation_event_sequence FROM agent_principals
        WHERE project = ? AND principal_id = ?
      `).get(registration.project, registration.principal_id);
            if (!existingPrincipal) {
                const checkpoint = this.db.prepare(`
          SELECT COALESCE(MAX(event_sequence), 0) AS sequence
          FROM agent_message_events WHERE project = ?
        `).get(registration.project).sequence;
                this.db.prepare(`
          INSERT INTO agent_principals (project, principal_id, activation_event_sequence)
          VALUES (?, ?, ?)
        `).run(registration.project, registration.principal_id, checkpoint);
            }
            const session = this.db.prepare(`
        SELECT principal_id, adapter_kind, last_generation
        FROM agent_session_instances WHERE project = ? AND session_instance_id = ?
      `).get(registration.project, registration.session_instance_id);
            if (session && (session.principal_id !== registration.principal_id || session.adapter_kind !== registration.adapter_kind)) {
                throw new AgentRouterError('session_identity_conflict', 'The session instance is already bound to another principal or adapter.');
            }
            if (!session) {
                this.db.prepare(`
          INSERT INTO agent_session_instances (
            project, session_instance_id, principal_id, adapter_kind, last_generation
          ) VALUES (?, ?, ?, ?, 0)
        `).run(registration.project, registration.session_instance_id, registration.principal_id, registration.adapter_kind);
            }
            const active = this.db.prepare(`
        SELECT connection_id, project, principal_id, session_instance_id, generation,
               adapter_kind, router_instance_id, lease_expires_at_ms
        FROM agent_session_connections
        WHERE project = ? AND session_instance_id = ? AND disconnected_at IS NULL
      `).all(registration.project, registration.session_instance_id);
            for (const previous of active) {
                this.externalConnections.delete(previous.connection_id);
                for (const [attemptId, pending] of this.pendingExternal) {
                    if (pending.connection.connection_id !== previous.connection_id)
                        continue;
                    clearTimeout(pending.timer);
                    this.pendingExternal.delete(attemptId);
                    pending.resolve({ accepted: false, receipt: { failure_code: 'stale_generation' } });
                }
                this.db.prepare(`
          UPDATE agent_session_connections
          SET disconnected_at = CURRENT_TIMESTAMP, disconnect_reason = 'superseded'
          WHERE connection_id = ?
        `).run(previous.connection_id);
                this.insertPresenceFact(previous, 'superseded', { replacement_router: this.router_instance_id });
            }
            const generation = (session?.last_generation ?? 0) + 1;
            this.db.prepare(`
        UPDATE agent_session_instances SET last_generation = ?
        WHERE project = ? AND session_instance_id = ?
      `).run(generation, registration.project, registration.session_instance_id);
            const connection = {
                connection_id: randomUUID(),
                project: registration.project,
                principal_id: registration.principal_id,
                session_instance_id: registration.session_instance_id,
                generation,
                adapter_kind: registration.adapter_kind,
                router_instance_id: this.router_instance_id,
                lease_expires_at_ms: Date.now() + this.limits.lease_ms,
            };
            this.db.prepare(`
        INSERT INTO agent_session_connections (
          connection_id, project, principal_id, session_instance_id, generation,
          adapter_kind, router_instance_id, lease_expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(connection.connection_id, connection.project, connection.principal_id, connection.session_instance_id, connection.generation, connection.adapter_kind, connection.router_instance_id, connection.lease_expires_at_ms);
            this.insertPresenceFact(connection, 'connected', {});
            return connection;
        }).immediate();
    }
    requireCurrentConnection(request) {
        const row = this.db.prepare(`
      SELECT connection_id, project, principal_id, session_instance_id, generation,
             adapter_kind, router_instance_id, lease_expires_at_ms
      FROM agent_session_connections
      WHERE project = ? AND session_instance_id = ? AND connection_id = ? AND generation = ?
        AND router_instance_id = ? AND disconnected_at IS NULL AND lease_expires_at_ms > ?
    `).get(request.project, request.session_instance_id, request.connection_id, request.generation, this.router_instance_id, Date.now());
        if (!row)
            throw new AgentRouterStaleGenerationError();
        return row;
    }
    insertPresenceFact(connection, kind, detail) {
        this.db.prepare(`
      INSERT INTO agent_presence_facts (
        presence_fact_id, project, principal_id, session_instance_id,
        connection_id, generation, presence_kind, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), connection.project, connection.principal_id, connection.session_instance_id, connection.connection_id, connection.generation, kind, JSON.stringify(detail));
    }
    async drainConnection(connection, hops) {
        if (hops > this.limits.max_hops)
            throw new AgentRouterError('hop_limit', 'Router hop limit exceeded.');
        const checkpoint = this.db.prepare(`
      SELECT activation_event_sequence FROM agent_principals
      WHERE project = ? AND principal_id = ?
    `).get(connection.project, connection.principal_id);
        const rows = this.db.prepare(`
      SELECT d.delivery_id
      FROM agent_message_deliveries d
      JOIN agent_message_events e ON e.delivery_id = d.delivery_id
      LEFT JOIN agent_host_accepts h ON h.delivery_id = d.delivery_id
      WHERE d.project = ? AND h.delivery_id IS NULL AND (
        (d.target_kind = 'principal' AND d.recipient = ? AND e.event_sequence > ?)
        OR (d.target_kind = 'session' AND d.recipient = ?)
      )
      ORDER BY e.event_sequence ASC
      LIMIT ?
    `).all(connection.project, connection.principal_id, checkpoint.activation_event_sequence, connection.session_instance_id, this.limits.drain_limit);
        let drained = 0;
        for (const row of rows) {
            if (await this.dispatchDelivery(row.delivery_id, connection.project, hops, connection))
                drained += 1;
        }
        return drained;
    }
    async dispatchDelivery(deliveryId, project, hops, preferred) {
        const inFlight = this.inFlightDeliveries.get(deliveryId);
        if (inFlight)
            return inFlight;
        const operation = this.dispatchDeliveryOnce(deliveryId, project, hops, preferred);
        this.inFlightDeliveries.set(deliveryId, operation);
        try {
            return await operation;
        }
        finally {
            if (this.inFlightDeliveries.get(deliveryId) === operation) {
                this.inFlightDeliveries.delete(deliveryId);
            }
        }
    }
    async dispatchDeliveryOnce(deliveryId, project, hops, preferred) {
        if (hops > this.limits.max_hops)
            throw new AgentRouterError('hop_limit', 'Router hop limit exceeded.');
        if (this.db.prepare('SELECT 1 FROM agent_host_accepts WHERE delivery_id = ?').get(deliveryId))
            return false;
        const delivery = this.loadDelivery(deliveryId, project);
        const connection = this.resolveConnection(delivery, preferred);
        if (!connection)
            return false;
        const adapter = this.adapters.get(connection.adapter_kind);
        const externalSocket = this.externalConnections.get(connection.connection_id);
        if (!externalSocket && !adapter?.dispatch)
            return false;
        const attempt = this.beginDispatchAttempt(delivery, connection);
        const envelope = fetchAgentMessage(this.db, {
            project: delivery.project,
            recipient: delivery.recipient,
            target_kind: parseTargetKind(delivery.target_kind),
            message_id: delivery.message_id,
        });
        let result;
        try {
            const input = {
                dispatch_id: delivery.delivery_id,
                attempt_id: attempt.attempt_id,
                project: delivery.project,
                principal_id: connection.principal_id,
                session_instance_id: connection.session_instance_id,
                connection_id: connection.connection_id,
                generation: connection.generation,
                hops,
                untrusted_payload: true,
                envelope,
            };
            result = externalSocket
                ? await this.dispatchExternal(externalSocket, connection, attempt.attempt_id, input)
                : await adapter.dispatch(input);
        }
        catch {
            this.finishAttempt(attempt.attempt_id, 'adapter_failed', 'adapter_error');
            return false;
        }
        if (!result.accepted) {
            this.finishAttempt(attempt.attempt_id, 'adapter_rejected', 'adapter_rejected');
            return false;
        }
        const receipt = validateReceipt(result.receipt ?? {});
        try {
            this.requireCurrentConnection(connection);
        }
        catch {
            this.finishAttempt(attempt.attempt_id, 'stale_generation', 'stale_generation');
            return false;
        }
        return this.db.transaction(() => {
            const existing = this.db.prepare(`
        SELECT 1 FROM agent_host_accepts WHERE delivery_id = ?
      `).get(delivery.delivery_id);
            if (existing)
                return false;
            this.db.prepare(`
        INSERT INTO agent_host_accepts (
          host_accept_id, attempt_id, delivery_id, adapter_kind, receipt_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), attempt.attempt_id, delivery.delivery_id, connection.adapter_kind, JSON.stringify(receipt));
            this.finishAttempt(attempt.attempt_id, 'adapter_returned', null);
            return true;
        }).immediate();
    }
    dispatchExternal(socket, connection, attemptId, input) {
        const frame = Buffer.from(`${JSON.stringify({
            version: 1,
            type: 'deliver',
            request_id: randomUUID(),
            attempt_id: attemptId,
            delivery_id: input.dispatch_id,
            project: input.project,
            principal_id: input.principal_id,
            session_instance_id: input.session_instance_id,
            connection_id: input.connection_id,
            generation: input.generation,
            hops: input.hops,
            untrusted_payload: true,
            envelope: input.envelope,
        })}\n`, 'utf8');
        if (frame.length > this.limits.max_frame_bytes) {
            return Promise.resolve({ accepted: false, receipt: { failure_code: 'frame_too_large' } });
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingExternal.delete(attemptId);
                resolve({ accepted: false, receipt: { failure_code: 'host_outcome_timeout' } });
            }, this.limits.delivery_timeout_ms);
            timer.unref();
            this.pendingExternal.set(attemptId, {
                connection,
                delivery_id: input.dispatch_id,
                resolve,
                timer,
            });
            if (socket.destroyed) {
                clearTimeout(timer);
                this.pendingExternal.delete(attemptId);
                resolve({ accepted: false, receipt: { failure_code: 'adapter_disconnected' } });
                return;
            }
            socket.write(frame);
        });
    }
    loadDelivery(deliveryId, project) {
        const row = this.db.prepare(`
      SELECT d.delivery_id, d.message_id, d.project, d.recipient, d.target_kind, e.event_sequence
      FROM agent_message_deliveries d
      JOIN agent_message_events e ON e.delivery_id = d.delivery_id
      WHERE d.delivery_id = ? AND d.project = ?
    `).get(validateField('delivery_id', deliveryId), validateField('project', project));
        if (!row)
            throw new AgentRouterError('delivery_not_found', 'The delivery does not exist in this project.');
        parseTargetKind(row.target_kind);
        return row;
    }
    resolveConnection(delivery, preferred) {
        const targetKind = parseTargetKind(delivery.target_kind);
        if (preferred && this.connectionMatchesDelivery(preferred, delivery, targetKind)) {
            try {
                return this.requireCurrentConnection(preferred);
            }
            catch {
                return undefined;
            }
        }
        if (targetKind === 'principal') {
            const principal = this.db.prepare(`
        SELECT activation_event_sequence FROM agent_principals
        WHERE project = ? AND principal_id = ?
      `).get(delivery.project, delivery.recipient);
            if (!principal || delivery.event_sequence <= principal.activation_event_sequence)
                return undefined;
            return this.db.prepare(`
        SELECT connection_id, project, principal_id, session_instance_id, generation,
               adapter_kind, router_instance_id, lease_expires_at_ms
        FROM agent_session_connections
        WHERE project = ? AND principal_id = ? AND router_instance_id = ?
          AND disconnected_at IS NULL AND lease_expires_at_ms > ?
        ORDER BY connected_at DESC, rowid DESC
        LIMIT 1
      `).get(delivery.project, delivery.recipient, this.router_instance_id, Date.now());
        }
        return this.db.prepare(`
      SELECT connection_id, project, principal_id, session_instance_id, generation,
             adapter_kind, router_instance_id, lease_expires_at_ms
      FROM agent_session_connections
      WHERE project = ? AND session_instance_id = ? AND router_instance_id = ?
        AND disconnected_at IS NULL AND lease_expires_at_ms > ?
      ORDER BY generation DESC
      LIMIT 1
    `).get(delivery.project, delivery.recipient, this.router_instance_id, Date.now());
    }
    connectionMatchesDelivery(connection, delivery, targetKind) {
        if (connection.project !== delivery.project)
            return false;
        return targetKind === 'principal'
            ? connection.principal_id === delivery.recipient
            : connection.session_instance_id === delivery.recipient;
    }
    beginDispatchAttempt(delivery, connection) {
        return this.db.transaction(() => {
            this.requireCurrentConnection(connection);
            if (this.db.prepare('SELECT 1 FROM agent_host_accepts WHERE delivery_id = ?').get(delivery.delivery_id)) {
                throw new AgentRouterError('already_accepted', 'The delivery already has a host acceptance.');
            }
            const attemptNumber = this.db.prepare(`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
        FROM agent_dispatch_attempts WHERE delivery_id = ?
      `).get(delivery.delivery_id).next;
            const attemptId = randomUUID();
            this.db.prepare(`
        INSERT INTO agent_dispatch_attempts (
          attempt_id, delivery_id, project, principal_id, session_instance_id,
          connection_id, generation, router_instance_id, attempt_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(attemptId, delivery.delivery_id, delivery.project, connection.principal_id, connection.session_instance_id, connection.connection_id, connection.generation, connection.router_instance_id, attemptNumber);
            return { attempt_id: attemptId, attempt_number: attemptNumber };
        }).immediate();
    }
    finishAttempt(attemptId, result, failureCode) {
        this.db.prepare(`
      UPDATE agent_dispatch_attempts
      SET result = ?, failure_code = ?, completed_at = CURRENT_TIMESTAMP
      WHERE attempt_id = ?
    `).run(result, failureCode, attemptId);
    }
    writeError(socket, requestId, code, message) {
        this.writeResponse(socket, {
            version: 1,
            request_id: requestId,
            ok: false,
            error: { code, message },
        });
    }
    writeResponse(socket, response) {
        if (!socket.destroyed)
            socket.write(`${JSON.stringify(response)}\n`);
    }
}
export function createAgentRouterNotifier(socketPath) {
    const validatedPath = validateSocketPath(socketPath);
    return {
        async notify(hint) {
            await sendAgentRouterRequest(validatedPath, {
                version: 1,
                type: 'notify',
                request_id: randomUUID(),
                project: hint.project,
                delivery_id: hint.delivery_id,
                hops: 0,
            });
        },
    };
}
export async function sendAgentRouterRequest(socketPath, request, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS) {
    const frame = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
    if (frame.length > AGENT_ROUTER_MAX_FRAME_BYTES) {
        throw new AgentRouterProtocolError('frame_too_large', 'Router request exceeds the byte limit.');
    }
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(validateSocketPath(socketPath));
        let pending = Buffer.alloc(0);
        let settled = false;
        const timer = setTimeout(() => finish(new AgentRouterProtocolError('timeout', 'Router request timed out.')), timeoutMs);
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) {
                reject(error);
            }
            else if (value === undefined) {
                reject(new AgentRouterProtocolError('invalid_response', 'Router response omitted its result object.'));
            }
            else {
                resolve(value);
            }
        };
        socket.on('connect', () => socket.write(frame));
        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > AGENT_ROUTER_MAX_FRAME_BYTES) {
                finish(new AgentRouterProtocolError('frame_too_large', 'Router response exceeds the byte limit.'));
                return;
            }
            const newline = pending.indexOf(0x0a);
            if (newline < 0)
                return;
            try {
                const response = JSON.parse(pending.subarray(0, newline).toString('utf8'));
                if (response.version !== 1 || response.request_id !== request.request_id) {
                    throw new AgentRouterProtocolError('invalid_response', 'Router response identity does not match.');
                }
                if (!response.ok)
                    throw new AgentRouterProtocolError(response.error.code, response.error.message);
                finish(undefined, validateRouterSuccessResult(request, response.result));
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.on('error', (error) => finish(error));
        socket.on('end', () => {
            if (!settled)
                finish(new AgentRouterProtocolError('connection_closed', 'Router closed without a response.'));
        });
    });
}
function validateRouterSuccessResult(request, value) {
    if (!isPlainObject(value)) {
        throw new AgentRouterProtocolError('invalid_response', 'Router response result must be an object.');
    }
    const requireResultString = (field) => {
        const candidate = value[field];
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_FIELD_LENGTH) {
            throw new AgentRouterProtocolError('invalid_response', `Router response omitted a valid ${field}.`);
        }
        return candidate;
    };
    const requireResultInteger = (field, minimum = 1) => {
        const candidate = value[field];
        if (!Number.isSafeInteger(candidate) || candidate < minimum) {
            throw new AgentRouterProtocolError('invalid_response', `Router response omitted a valid ${field}.`);
        }
        return candidate;
    };
    const requireResultBoolean = (field) => {
        const candidate = value[field];
        if (typeof candidate !== 'boolean') {
            throw new AgentRouterProtocolError('invalid_response', `Router response omitted a valid ${field}.`);
        }
        return candidate;
    };
    switch (request.type) {
        case 'register':
            requireResultString('connection_id');
            requireResultInteger('generation');
            requireResultInteger('lease_ms');
            requireResultBoolean('drain_scheduled');
            break;
        case 'notify':
            requireResultBoolean('delivered');
            break;
        case 'heartbeat':
            requireResultInteger('generation');
            requireResultInteger('lease_ms');
            break;
        case 'disconnect':
            if (value.disconnected !== true) {
                throw new AgentRouterProtocolError('invalid_response', 'Router response did not confirm disconnect.');
            }
            break;
        case 'host_accept':
        case 'host_reject':
            if (value.correlated !== true && typeof value.duplicate !== 'boolean') {
                throw new AgentRouterProtocolError('invalid_response', 'Router response omitted its host-outcome correlation.');
            }
            break;
    }
    return value;
}
function parseRequest(frame, maxHops) {
    let value;
    try {
        value = JSON.parse(frame.toString('utf8'));
    }
    catch {
        throw new AgentRouterProtocolError('invalid_json', 'Router frames must contain one JSON object.');
    }
    if (!isPlainObject(value))
        throw new AgentRouterProtocolError('invalid_frame', 'Router frame must be an object.');
    if (value.version !== 1)
        throw new AgentRouterProtocolError('unsupported_version', 'Unsupported router protocol version.');
    const type = value.type;
    const common = ['version', 'type', 'request_id', 'hops'];
    const requestId = validateField('request_id', value.request_id);
    const hops = validateInteger('hops', value.hops, 0, maxHops);
    switch (type) {
        case 'register':
            assertAllowedKeys(value, [
                ...common, 'project', 'principal_id', 'session_instance_id', 'adapter_kind', 'auth_token',
            ]);
            return {
                version: 1,
                type,
                request_id: requestId,
                project: validateField('project', value.project),
                principal_id: validateField('principal_id', value.principal_id),
                session_instance_id: validateField('session_instance_id', value.session_instance_id),
                adapter_kind: validateField('adapter_kind', value.adapter_kind),
                ...(value.auth_token === undefined ? {} : { auth_token: validateField('auth_token', value.auth_token) }),
                hops,
            };
        case 'notify':
            assertAllowedKeys(value, [...common, 'project', 'delivery_id']);
            return {
                version: 1,
                type,
                request_id: requestId,
                project: validateField('project', value.project),
                delivery_id: validateField('delivery_id', value.delivery_id),
                hops,
            };
        case 'heartbeat':
        case 'disconnect':
            assertAllowedKeys(value, [
                ...common, 'project', 'session_instance_id', 'connection_id', 'generation',
            ]);
            return {
                version: 1,
                type,
                request_id: requestId,
                project: validateField('project', value.project),
                session_instance_id: validateField('session_instance_id', value.session_instance_id),
                connection_id: validateField('connection_id', value.connection_id),
                generation: validateInteger('generation', value.generation, 1, Number.MAX_SAFE_INTEGER),
                hops,
            };
        case 'host_accept':
            assertAllowedKeys(value, [
                ...common, 'attempt_id', 'delivery_id', 'connection_id', 'generation', 'receipt',
            ]);
            if (!isPlainObject(value.receipt)) {
                throw new AgentRouterProtocolError('invalid_field', 'receipt must be an object.');
            }
            return {
                version: 1,
                type,
                request_id: requestId,
                attempt_id: validateField('attempt_id', value.attempt_id),
                delivery_id: validateField('delivery_id', value.delivery_id),
                connection_id: validateField('connection_id', value.connection_id),
                generation: validateInteger('generation', value.generation, 1, Number.MAX_SAFE_INTEGER),
                receipt: validateReceipt(value.receipt),
                hops,
            };
        case 'host_reject':
            assertAllowedKeys(value, [
                ...common, 'attempt_id', 'delivery_id', 'connection_id', 'generation', 'failure_code',
            ]);
            return {
                version: 1,
                type,
                request_id: requestId,
                attempt_id: validateField('attempt_id', value.attempt_id),
                delivery_id: validateField('delivery_id', value.delivery_id),
                connection_id: validateField('connection_id', value.connection_id),
                generation: validateInteger('generation', value.generation, 1, Number.MAX_SAFE_INTEGER),
                failure_code: validateField('failure_code', value.failure_code),
                hops,
            };
        default:
            throw new AgentRouterProtocolError('unsupported_type', 'Unsupported router frame type.');
    }
}
function assertAllowedKeys(value, allowed) {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
    if (unexpected) {
        throw new AgentRouterProtocolError('unexpected_field', `Router frame contains unsupported field ${unexpected}.`);
    }
}
function validateField(label, value) {
    if (typeof value !== 'string')
        throw new AgentRouterProtocolError('invalid_field', `${label} must be a string.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_FIELD_LENGTH) {
        throw new AgentRouterProtocolError('invalid_field', `${label} must contain 1-${MAX_FIELD_LENGTH} characters.`);
    }
    return normalized;
}
function validateInteger(label, value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new AgentRouterProtocolError('invalid_field', `${label} is outside the allowed integer range.`);
    }
    return value;
}
function listenOnSocket(server, socketPath) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
    });
}
async function removeOrphanedSocket(socketPath) {
    const initial = lstatIfPresent(socketPath);
    if (!initial)
        return true;
    assertSafeStaleSocketCandidate(initial);
    if (await probeSocket(socketPath) !== 'refused')
        return false;
    const afterProbe = lstatIfPresent(socketPath);
    if (!afterProbe || !sameSocketIdentity(initial, afterProbe))
        return true;
    if (await probeSocket(socketPath) !== 'refused')
        return false;
    const beforeUnlink = lstatIfPresent(socketPath);
    if (!beforeUnlink || !sameSocketIdentity(initial, beforeUnlink))
        return true;
    fs.unlinkSync(socketPath);
    return true;
}
function probeSocket(socketPath) {
    return new Promise((resolve) => {
        const socket = net.createConnection(socketPath);
        let settled = false;
        const timer = setTimeout(() => finish('indeterminate'), STALE_SOCKET_PROBE_TIMEOUT_MS);
        timer.unref();
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        socket.once('connect', () => finish('connected'));
        socket.once('error', (error) => {
            if (error.code === 'ECONNREFUSED')
                finish('refused');
            else if (error.code === 'ENOENT')
                finish('missing');
            else
                finish('indeterminate');
        });
    });
}
function assertSafeStaleSocketCandidate(stat) {
    if (!stat.isSocket()) {
        throw new AgentRouterError('socket_path_occupied', 'Router socket path is occupied by a non-socket file.');
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new AgentRouterError('insecure_existing_socket', 'Existing router socket is not owner-private.');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new AgentRouterError('foreign_existing_socket', 'Existing router socket is owned by another user.');
    }
}
function lstatIfPresent(socketPath) {
    try {
        return fs.lstatSync(socketPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function readSocketIdentity(socketPath) {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket())
        throw new AgentRouterError('invalid_socket', 'Router did not create a Unix socket.');
    return { dev: stat.dev, ino: stat.ino };
}
function sameSocketIdentity(expected, actual) {
    return expected.dev === actual.dev && expected.ino === actual.ino;
}
function unlinkSocketIfSame(socketPath, expected) {
    const current = lstatIfPresent(socketPath);
    if (!current || !current.isSocket() || !sameSocketIdentity(expected, current))
        return;
    fs.unlinkSync(socketPath);
}
function validateSocketPath(socketPath) {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) {
        throw new AgentRouterProtocolError('invalid_socket_path', 'Router socket path must be absolute and at most 103 bytes.');
    }
    return socketPath;
}
function normalizeLimits(limits = {}) {
    return {
        max_frame_bytes: validateInteger('max_frame_bytes', limits.max_frame_bytes ?? AGENT_ROUTER_MAX_FRAME_BYTES, 256, AGENT_ROUTER_MAX_FRAME_BYTES),
        max_hops: validateInteger('max_hops', limits.max_hops ?? AGENT_ROUTER_MAX_HOPS, 1, 16),
        max_frames_per_window: validateInteger('max_frames_per_window', limits.max_frames_per_window ?? DEFAULT_RATE_LIMIT, 1, 10_000),
        rate_window_ms: validateInteger('rate_window_ms', limits.rate_window_ms ?? DEFAULT_RATE_WINDOW_MS, 10, 60 * 60_000),
        lease_ms: validateInteger('lease_ms', limits.lease_ms ?? DEFAULT_LEASE_MS, 100, MAX_LEASE_MS),
        drain_limit: validateInteger('drain_limit', limits.drain_limit ?? DEFAULT_DRAIN_LIMIT, 1, 10_000),
        delivery_timeout_ms: validateInteger('delivery_timeout_ms', limits.delivery_timeout_ms ?? 10_000, 100, 10 * 60_000),
    };
}
function validateReceipt(value) {
    if (!isPlainObject(value))
        throw new AgentRouterError('invalid_adapter_receipt', 'Adapter receipt must be an object.');
    let json;
    try {
        json = JSON.stringify(value);
    }
    catch {
        throw new AgentRouterError('invalid_adapter_receipt', 'Adapter receipt must be JSON serializable.');
    }
    if (Buffer.byteLength(json, 'utf8') > MAX_ADAPTER_RECEIPT_BYTES) {
        throw new AgentRouterError('invalid_adapter_receipt', 'Adapter receipt exceeds the byte limit.');
    }
    return value;
}
function parseTargetKind(value) {
    if (value === 'principal' || value === 'session')
        return value;
    throw new AgentRouterError('invalid_target_kind', 'Stored delivery target kind is invalid.');
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function toRouterError(error) {
    if (error instanceof AgentRouterError)
        return error;
    return new AgentRouterError('internal_error', 'The router could not process the request.');
}
//# sourceMappingURL=agent-router.js.map