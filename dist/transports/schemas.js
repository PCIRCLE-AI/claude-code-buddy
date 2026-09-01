import { z } from 'zod';
import { NAMESPACES } from '../core/types.js';
import { TITLE_MAX_LENGTH } from '../core/title.js';
import { AGENT_MESSAGE_JSON_MAX_BYTES, AGENT_NATIVE_MESSAGE_MAX_BYTES } from '../core/agent-messaging.js';
const sanitizeName = (s) => s.replace(/[\r\n\t]+/g, ' ').trim();
const nameField = z.string().min(1).max(255).transform(sanitizeName).refine(s => s.length > 0, {
    message: 'Name must not be blank after sanitization',
});
const titleField = z
    .string()
    .max(TITLE_MAX_LENGTH)
    .transform(sanitizeName)
    .transform(s => (s.length > 0 ? s : undefined))
    .optional();
const observationField = z.string().max(10000).refine((s) => s.trim().length > 0, { message: 'an observation must not be empty or whitespace-only' });
export const RememberSchema = z.object({
    name: nameField,
    type: z.string().min(1).max(100),
    title: titleField,
    observations: z.array(observationField).max(100).optional(),
    tags: z.array(z.string().max(255)).max(50).optional(),
    relations: z
        .array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) }).strict())
        .max(50)
        .optional(),
    namespace: z.enum(NAMESPACES).optional(),
}).strict();
export const RecallSchema = z.object({
    query: z.string().max(1000).optional(),
    tag: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    include_archived: z.boolean().optional(),
    namespace: z.enum(NAMESPACES).optional(),
    cross_project: z.boolean().optional(),
}).strict();
export const ForgetSchema = z.object({
    name: nameField,
    observation: z.string().min(1).max(10000).optional(),
}).strict();
export const ExportSchema = z.object({
    tag: z.string().max(255).optional(),
    namespace: z.enum(NAMESPACES).optional(),
    limit: z.number().int().min(1).max(10000).optional(),
}).strict();
export const ExportResultSchema = z.object({
    version: z.string(),
    exported_at: z.string(),
    entity_count: z.number(),
    entities: z.array(z.object({
        name: nameField,
        type: z.string().min(1).max(100),
        title: z.string().max(TITLE_MAX_LENGTH).nullable().optional(),
        namespace: z.string(),
        observations: z.array(z.string().max(10000)),
        tags: z.array(z.string().max(255)),
        relations: z.array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) })),
    })),
});
export const ImportSchema = z.object({
    data: ExportResultSchema,
    namespace: z.enum(NAMESPACES).optional(),
    merge_strategy: z.enum(['skip', 'overwrite', 'append']),
}).strict();
export const LearnSchema = z.object({
    error: z.string().min(1).max(5000),
    fix: z.string().min(1).max(5000),
    root_cause: z.string().max(5000).optional(),
    prevention: z.string().max(5000).optional(),
    severity: z.enum(['critical', 'major', 'minor']).optional(),
}).strict();
export const TaskStateSchema = z.object({
    project: z.string().min(1).max(200).optional(),
    goal: z.string().max(1000).optional(),
    next: z.string().max(1000).optional(),
    blocked: z.string().max(1000).optional(),
    done: z.string().max(1000).optional(),
}).strict();
export const BriefingSchema = z.object({
    project: z.string().min(1).max(200).optional(),
    recipient: z.string().trim().min(1).max(200).optional(),
}).strict();
export const WhySchema = z.object({
    file: z.string().min(1).max(500),
    commits: z.array(z.string().regex(/^[a-f0-9]{7,40}$/)).max(50).optional(),
    project: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
}).strict();
export const UserPatternsSchema = z.object({
    categories: z.array(z.enum(['workSchedule', 'focusAreas', 'workflow', 'strengths', 'learningAreas'])).optional()
        .describe('Specific categories to return. Omit for all.'),
}).strict();
const nonBlankBounded = (max) => z.string().trim().min(1).max(max);
export const ImprovementSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('propose'),
        project: nonBlankBounded(200),
        source_names: z.array(nonBlankBounded(255)).min(1).max(20),
        title: nonBlankBounded(200),
        problem: nonBlankBounded(5000),
        proposed_change: nonBlankBounded(5000),
        verification_scenario: nonBlankBounded(5000),
        success_criteria: z.array(nonBlankBounded(1000)).min(1).max(20),
        priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
    }).strict(),
    z.object({
        action: z.literal('status'),
        proposal_id: z.number().int().positive(),
    }).strict(),
]);
const messageProject = nonBlankBounded(200);
const messageAgentId = nonBlankBounded(200);
const messageId = nonBlankBounded(255);
const messageCursor = nonBlankBounded(160);
const messageIdempotencyKey = nonBlankBounded(200);
const messageReceiptBase = {
    project: messageProject,
    recipient: messageAgentId,
    message_id: messageId,
    idempotency_key: messageIdempotencyKey,
};
export const MessageSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('send'),
        project: messageProject,
        sender: messageAgentId,
        recipient: messageAgentId,
        target_kind: z.enum(['principal', 'session']).default('principal'),
        idempotency_key: messageIdempotencyKey,
        payload: z.json().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_MESSAGE_JSON_MAX_BYTES, { message: `payload must be at most ${AGENT_MESSAGE_JSON_MAX_BYTES} UTF-8 bytes when encoded as JSON` }).describe(`Untrusted JSON value. The encoded payload is limited to ${AGENT_MESSAGE_JSON_MAX_BYTES} bytes (64 KiB); native delivery additionally requires the complete envelope to fit ${AGENT_NATIVE_MESSAGE_MAX_BYTES} bytes (16 KiB).`),
        content_type: z.enum(['text/plain', 'application/json']).default('text/plain'),
        privacy: z.enum(['private', 'team']).default('private'),
        correlation_id: nonBlankBounded(255).optional(),
        reply_to: messageId.optional(),
    }).strict(),
    z.object({
        action: z.literal('poll'),
        project: messageProject,
        recipient: messageAgentId,
        cursor: messageCursor.optional(),
        wait_ms: z.number().int().min(0).max(30_000).default(0),
        limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    z.object({
        action: z.literal('discover'),
        project: messageProject,
        limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    z.object({
        action: z.literal('fetch'),
        project: messageProject,
        recipient: messageAgentId,
        target_kind: z.enum(['principal', 'session']).default('principal'),
        message_id: messageId,
    }).strict(),
    z.object({
        action: z.literal('intake'),
        ...messageReceiptBase,
        intake_state: z.enum(['fetched', 'ingested']),
    }).strict(),
    z.object({
        action: z.literal('ack'),
        ...messageReceiptBase,
    }).strict(),
    z.object({
        action: z.literal('disposition'),
        ...messageReceiptBase,
        disposition: z.enum(['accepted', 'rejected', 'completed', 'cancelled', 'deferred']),
        detail: z.string().trim().max(1000).optional(),
    }).strict(),
    z.object({
        action: z.literal('activation'),
        ...messageReceiptBase,
        activation: z.enum(['woken', 'manual_resume_required', 'unsupported', 'failed']),
        detail: z.string().trim().max(1000).optional(),
    }).strict(),
    z.object({
        action: z.literal('receipts'),
        project: messageProject,
        recipient: messageAgentId,
        message_id: messageId,
    }).strict(),
]);
//# sourceMappingURL=schemas.js.map