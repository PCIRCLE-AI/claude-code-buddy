import type { StructuredLesson } from './failure-analyzer.js';
import type { LessonSeverity } from './types.js';
export declare function createLesson(lesson: StructuredLesson, projectName: string): {
    name: string;
    isNew: boolean;
};
export declare function createExplicitLesson(error: string, fix: string, projectName: string, opts?: {
    rootCause?: string;
    prevention?: string;
    severity?: LessonSeverity;
    errorPattern?: string;
    sourceHost?: string;
}): {
    name: string;
};
export declare const KNOWN_ERROR_PATTERNS: readonly ["null-reference", "type-error", "import-missing", "config-error", "test-failure", "build-error", "other"];
declare function lessonSlug(error: string): string;
declare function inferErrorPattern(error: string): string;
export { inferErrorPattern, lessonSlug };
//# sourceMappingURL=lesson-engine.d.ts.map