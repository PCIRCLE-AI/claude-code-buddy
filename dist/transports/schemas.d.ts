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
    }, z.core.$strict>>>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
}, z.core.$strict>;
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
}, z.core.$strict>;
export declare const ForgetSchema: z.ZodObject<{
    name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    observation: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const ExportSchema: z.ZodObject<{
    tag: z.ZodOptional<z.ZodString>;
    namespace: z.ZodOptional<z.ZodEnum<{
        personal: "personal";
        team: "team";
        global: "global";
    }>>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ExportResultSchema: z.ZodObject<{
    version: z.ZodString;
    exported_at: z.ZodString;
    entity_count: z.ZodNumber;
    entities: z.ZodArray<z.ZodObject<{
        name: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        type: z.ZodString;
        title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
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
            title: z.ZodOptional<z.ZodNullable<z.ZodString>>;
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
}, z.core.$strict>;
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
}, z.core.$strict>;
export declare const TaskStateSchema: z.ZodObject<{
    project: z.ZodOptional<z.ZodString>;
    goal: z.ZodOptional<z.ZodString>;
    next: z.ZodOptional<z.ZodString>;
    blocked: z.ZodOptional<z.ZodString>;
    done: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const BriefingSchema: z.ZodObject<{
    project: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const WhySchema: z.ZodObject<{
    file: z.ZodString;
    commits: z.ZodOptional<z.ZodArray<z.ZodString>>;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const UserPatternsSchema: z.ZodObject<{
    categories: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        workflow: "workflow";
        workSchedule: "workSchedule";
        focusAreas: "focusAreas";
        strengths: "strengths";
        learningAreas: "learningAreas";
    }>>>;
}, z.core.$strict>;
export declare const ImprovementSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"propose">;
    project: z.ZodString;
    source_names: z.ZodArray<z.ZodString>;
    title: z.ZodString;
    problem: z.ZodString;
    proposed_change: z.ZodString;
    verification_scenario: z.ZodString;
    success_criteria: z.ZodArray<z.ZodString>;
    priority: z.ZodOptional<z.ZodEnum<{
        p0: "p0";
        p1: "p1";
        p2: "p2";
        p3: "p3";
    }>>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"status">;
    proposal_id: z.ZodNumber;
}, z.core.$strict>], "action">;
export declare const MessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    action: z.ZodLiteral<"send">;
    project: z.ZodString;
    sender: z.ZodString;
    recipient: z.ZodString;
    target_kind: z.ZodDefault<z.ZodEnum<{
        principal: "principal";
        session: "session";
    }>>;
    idempotency_key: z.ZodString;
    payload: z.ZodJSONSchema;
    content_type: z.ZodDefault<z.ZodEnum<{
        "text/plain": "text/plain";
        "application/json": "application/json";
    }>>;
    privacy: z.ZodDefault<z.ZodEnum<{
        team: "team";
        private: "private";
    }>>;
    correlation_id: z.ZodOptional<z.ZodString>;
    reply_to: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"poll">;
    project: z.ZodString;
    recipient: z.ZodString;
    cursor: z.ZodOptional<z.ZodString>;
    wait_ms: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"fetch">;
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    intake_state: z.ZodEnum<{
        fetched: "fetched";
        ingested: "ingested";
    }>;
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
    idempotency_key: z.ZodString;
    action: z.ZodLiteral<"intake">;
}, z.core.$strict>, z.ZodObject<{
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
    idempotency_key: z.ZodString;
    action: z.ZodLiteral<"ack">;
}, z.core.$strict>, z.ZodObject<{
    disposition: z.ZodEnum<{
        completed: "completed";
        cancelled: "cancelled";
        rejected: "rejected";
        accepted: "accepted";
        deferred: "deferred";
    }>;
    detail: z.ZodOptional<z.ZodString>;
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
    idempotency_key: z.ZodString;
    action: z.ZodLiteral<"disposition">;
}, z.core.$strict>, z.ZodObject<{
    activation: z.ZodEnum<{
        woken: "woken";
        manual_resume_required: "manual_resume_required";
        unsupported: "unsupported";
        failed: "failed";
    }>;
    detail: z.ZodOptional<z.ZodString>;
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
    idempotency_key: z.ZodString;
    action: z.ZodLiteral<"activation">;
}, z.core.$strict>, z.ZodObject<{
    action: z.ZodLiteral<"receipts">;
    project: z.ZodString;
    recipient: z.ZodString;
    message_id: z.ZodString;
}, z.core.$strict>], "action">;
//# sourceMappingURL=schemas.d.ts.map