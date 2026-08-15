import { z } from 'zod';
export declare const RememberSchema: z.ZodObject<{
    name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    type: z.ZodString;
    title: z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodTransform<string | undefined, string>>>;
    observations: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    relations: z.ZodOptional<z.ZodArray<z.ZodObject<{
        to: z.ZodString;
        type: z.ZodString;
    }, z.core.$strip>>>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
}, z.core.$strip>;
export declare const RecallSchema: z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    tag: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    include_archived: z.ZodOptional<z.ZodBoolean>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
    cross_project: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const ForgetSchema: z.ZodObject<{
    name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    observation: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const ExportSchema: z.ZodObject<{
    tag: z.ZodOptional<z.ZodString>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const ExportResultSchema: z.ZodObject<{
    version: z.ZodString;
    exported_at: z.ZodString;
    entity_count: z.ZodNumber;
    entities: z.ZodArray<z.ZodObject<{
        name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        type: z.ZodString;
        namespace: z.ZodString;
        observations: z.ZodArray<z.ZodString>;
        tags: z.ZodArray<z.ZodString>;
        relations: z.ZodArray<z.ZodObject<{
            to: z.ZodString;
            type: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ImportSchema: z.ZodObject<{
    data: z.ZodObject<{
        version: z.ZodString;
        exported_at: z.ZodString;
        entity_count: z.ZodNumber;
        entities: z.ZodArray<z.ZodObject<{
            name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            type: z.ZodString;
            namespace: z.ZodString;
            observations: z.ZodArray<z.ZodString>;
            tags: z.ZodArray<z.ZodString>;
            relations: z.ZodArray<z.ZodObject<{
                to: z.ZodString;
                type: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
    merge_strategy: z.ZodEnum<{
        skip: "skip";
        overwrite: "overwrite";
        append: "append";
    }>;
}, z.core.$strip>;
export declare const LearnSchema: z.ZodObject<{
    error: z.ZodString;
    fix: z.ZodString;
    root_cause: z.ZodOptional<z.ZodString>;
    prevention: z.ZodOptional<z.ZodString>;
    severity: z.ZodOptional<z.ZodEnum<{
        critical: "critical";
        major: "major";
        minor: "minor";
    }>>;
}, z.core.$strip>;
export declare const UserPatternsSchema: z.ZodObject<{
    categories: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        workSchedule: "workSchedule";
        toolPreferences: "toolPreferences";
        focusAreas: "focusAreas";
        workflow: "workflow";
        strengths: "strengths";
        learningAreas: "learningAreas";
    }>>>;
}, z.core.$strip>;
//# sourceMappingURL=schemas.d.ts.map