import { z } from 'zod';
const sanitizeName = (s) => s.replace(/[\r\n\t]+/g, ' ').trim();
const nameField = z.string().min(1).max(255).transform(sanitizeName).refine(s => s.length > 0, {
    message: 'Name must not be blank after sanitization',
});
export const RememberSchema = z.object({
    name: nameField,
    type: z.string().min(1).max(100),
    observations: z.array(z.string().max(10000)).max(100).optional(),
    tags: z.array(z.string().max(255)).max(50).optional(),
    relations: z
        .array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) }))
        .max(50)
        .optional(),
    namespace: z.enum(['personal', 'team', 'global']).optional(),
});
export const RecallSchema = z.object({
    query: z.string().max(1000).optional(),
    tag: z.string().max(255).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    include_archived: z.boolean().optional(),
    namespace: z.enum(['personal', 'team', 'global']).optional(),
    cross_project: z.boolean().optional(),
});
export const ForgetSchema = z.object({
    name: nameField,
    observation: z.string().max(10000).optional(),
});
export const ExportSchema = z.object({
    tag: z.string().max(255).optional(),
    namespace: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(10000).optional(),
});
export const ExportResultSchema = z.object({
    version: z.string(),
    exported_at: z.string(),
    entity_count: z.number(),
    entities: z.array(z.object({
        name: nameField,
        type: z.string().min(1).max(100),
        namespace: z.string(),
        observations: z.array(z.string().max(10000)),
        tags: z.array(z.string().max(255)),
        relations: z.array(z.object({ to: z.string().min(1).max(255), type: z.string().min(1).max(100) })),
    })),
});
export const ImportSchema = z.object({
    data: ExportResultSchema,
    namespace: z.string().max(50).optional(),
    merge_strategy: z.enum(['skip', 'overwrite', 'append']),
});
export const LearnSchema = z.object({
    error: z.string().min(1).max(5000),
    fix: z.string().min(1).max(5000),
    root_cause: z.string().max(5000).optional(),
    prevention: z.string().max(5000).optional(),
    severity: z.enum(['critical', 'major', 'minor']).optional(),
});
export const UserPatternsSchema = z.object({
    categories: z.array(z.enum(['workSchedule', 'toolPreferences', 'focusAreas', 'workflow', 'strengths', 'learningAreas'])).optional()
        .describe('Specific categories to return. Omit for all.'),
});
const ExternalCheckSchema = z.object({
    pass: z.boolean(),
    summary: z.string().max(2000).optional(),
});
export const VerifyAgentWorkSchema = z.object({
    agent_id: z.string().min(1).max(255)
        .describe('Identifier for the agent whose work is being verified.'),
    workdir: z.string().min(1).max(1000)
        .describe('Absolute path to the git working tree the agent edited.'),
    base: z.string().max(255).optional()
        .describe('Git ref/sha to diff against. Defaults to merge-base with origin/main.'),
    claim: z.object({
        expected_files: z.number().int().min(0).max(1000).optional(),
    }).optional()
        .describe('Numbers the agent claimed in its summary, used for cross-checking.'),
    report: z.object({
        pass: z.boolean(),
        typecheck: ExternalCheckSchema.optional(),
        tests: ExternalCheckSchema.optional(),
        lint: ExternalCheckSchema.optional(),
        build: ExternalCheckSchema.optional(),
        summary: z.string().max(2000).optional(),
    }).optional()
        .describe('Pre-computed report from a verification gate hook. If omitted, only reality-check runs.'),
});
//# sourceMappingURL=schemas.js.map