import { remember, recall } from './operations.js';
import { getDatabase } from '../db.js';
export function createLesson(lesson, projectName) {
    const name = `lesson-${projectName}-${lesson.errorPattern}`;
    const existing = recall({ query: name, limit: 1 });
    const isNew = existing.length === 0 || existing[0].name !== name;
    remember({
        name,
        type: 'lesson_learned',
        observations: [
            `Error: ${lesson.error}`,
            `Root cause: ${lesson.rootCause}`,
            `Fix: ${lesson.fix}`,
            `Prevention: ${lesson.prevention}`,
        ],
        tags: [
            `project:${projectName}`,
            `error-pattern:${lesson.errorPattern}`,
            `fix-pattern:${lesson.fixPattern}`,
            `severity:${lesson.severity}`,
            'source:auto-learned',
        ],
        trustOverride: 'untrusted',
        provenanceOverride: { source: 'auto-learned' },
    });
    return { name, isNew };
}
export function createExplicitLesson(error, fix, projectName, opts) {
    const errorPattern = opts?.errorPattern || inferErrorPattern(error);
    const name = `lesson-${projectName}-${errorPattern}`;
    remember({
        name,
        type: 'lesson_learned',
        observations: [
            `Error: ${error}`,
            `Root cause: ${opts?.rootCause || 'Not specified'}`,
            `Fix: ${fix}`,
            `Prevention: ${opts?.prevention || 'Review similar code paths'}`,
        ],
        tags: [
            `project:${projectName}`,
            `error-pattern:${errorPattern}`,
            `severity:${opts?.severity || 'minor'}`,
            'source:explicit',
        ],
    });
    getDatabase()
        .prepare('UPDATE entities SET confidence = 1.0 WHERE name = ?')
        .run(name);
    return { name };
}
export const KNOWN_ERROR_PATTERNS = [
    'null-reference',
    'type-error',
    'import-missing',
    'config-error',
    'test-failure',
    'build-error',
    'other',
];
function inferErrorPattern(error) {
    const lower = error.toLowerCase();
    if (lower.includes('null') || lower.includes('undefined') || lower.includes('cannot read prop'))
        return 'null-reference';
    if (lower.includes('type') && (lower.includes('error') || lower.includes('mismatch')))
        return 'type-error';
    if (lower.includes('import') || lower.includes('module not found') || lower.includes('cannot find'))
        return 'import-missing';
    if (lower.includes('config') || lower.includes('env') || lower.includes('environment'))
        return 'config-error';
    if (lower.includes('test') && (lower.includes('fail') || lower.includes('assert')))
        return 'test-failure';
    if (lower.includes('build') || lower.includes('compile') || lower.includes('tsc'))
        return 'build-error';
    return 'other';
}
export { inferErrorPattern };
//# sourceMappingURL=lesson-engine.js.map