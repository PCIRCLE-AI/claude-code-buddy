import { z } from 'zod';
import type { ProjectMemoryManager } from '../../memory/ProjectMemoryManager.js';
import type { ResponseFormatter } from '../../ui/ResponseFormatter.js';
import type { KnowledgeGraph } from '../../knowledge-graph/index.js';
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';
export declare const BuddyRememberInputSchema: z.ZodObject<{
    query: z.ZodString;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        semantic: "semantic";
        keyword: "keyword";
        hybrid: "hybrid";
    }>>>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    matchThreshold: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    allProjects: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
export type ValidatedBuddyRememberInput = z.infer<typeof BuddyRememberInputSchema>;
export declare function executeBuddyRemember(input: ValidatedBuddyRememberInput, projectMemory: ProjectMemoryManager, formatter: ResponseFormatter, knowledgeGraph?: KnowledgeGraph): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
}>;
//# sourceMappingURL=buddy-remember.d.ts.map