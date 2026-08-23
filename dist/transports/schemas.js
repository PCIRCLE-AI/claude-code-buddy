import { z } from 'zod';
import { NAMESPACES } from '../core/types.js';
import { TITLE_MAX_LENGTH } from '../core/title.js';
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
export const RememberSchema = z.object({
    name: nameField,
    type: z.string().min(1).max(100),
    title: titleField,
    observations: z.array(z.string().max(10000)).max(100).optional(),
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
}).strict();
export const WhySchema = z.object({
    file: z.string().min(1).max(500),
    commits: z.array(z.string().regex(/^[a-f0-9]{7,40}$/)).max(50).optional(),
    project: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
}).strict();
export const UserPatternsSchema = z.object({
    categories: z.array(z.enum(['workSchedule', 'toolPreferences', 'focusAreas', 'workflow', 'strengths', 'learningAreas'])).optional()
        .describe('Specific categories to return. Omit for all.'),
}).strict();
//# sourceMappingURL=schemas.js.map