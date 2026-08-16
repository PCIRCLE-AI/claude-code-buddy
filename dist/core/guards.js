export const GUARD_TOOLS = new Set(['Bash', 'Edit', 'Write']);
export const GUARD_BENIGN_PROBES = [
    'ls',
    'git status',
    'git diff',
    'npm test',
    'echo ok',
    'cd ..',
    'src/index.ts',
];
const PATTERN_MIN = 6;
const PATTERN_MAX = 200;
const MESSAGE_MAX = 280;
export function validateGuardSpec(spec) {
    const errors = [];
    const s = spec;
    if (!s || typeof s !== 'object')
        return ['guard spec is not an object'];
    if (typeof s.tool !== 'string' || !GUARD_TOOLS.has(s.tool)) {
        errors.push(`tool must be one of ${[...GUARD_TOOLS].join('/')}`);
    }
    if (typeof s.pattern !== 'string' || s.pattern.length < PATTERN_MIN || s.pattern.length > PATTERN_MAX) {
        errors.push(`pattern must be a string of ${PATTERN_MIN}–${PATTERN_MAX} chars`);
        return errors;
    }
    let re;
    try {
        re = new RegExp(s.pattern, 'i');
    }
    catch (err) {
        return [...errors, `pattern does not compile: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (re.test(''))
        errors.push('pattern matches the empty string — it would fire on everything');
    for (const probe of GUARD_BENIGN_PROBES) {
        if (re.test(probe))
            errors.push(`pattern matches the benign input "${probe}" — too broad to be a guard`);
    }
    if (typeof s.message !== 'string' || s.message.trim().length === 0 || s.message.length > MESSAGE_MAX) {
        errors.push(`message must be a non-empty string of at most ${MESSAGE_MAX} chars`);
    }
    const matches = Array.isArray(s.should_match) ? s.should_match.filter((x) => typeof x === 'string') : [];
    const nonMatches = Array.isArray(s.should_not_match) ? s.should_not_match.filter((x) => typeof x === 'string') : [];
    if (matches.length < 2) {
        errors.push('should_match needs at least 2 example inputs');
    }
    if (nonMatches.length < 2) {
        errors.push('should_not_match needs at least 2 example inputs');
    }
    for (const ex of matches) {
        if (!re.test(ex))
            errors.push(`should_match example does not match: "${ex.slice(0, 80)}"`);
    }
    for (const ex of nonMatches) {
        if (re.test(ex))
            errors.push(`should_not_match example matches: "${ex.slice(0, 80)}"`);
    }
    return errors;
}
export function matchingGuards(guards, tool, haystack) {
    const out = [];
    if (typeof haystack !== 'string' || haystack.length === 0)
        return out;
    for (const g of guards) {
        if (g.tool !== tool)
            continue;
        if (g.action !== 'warn' && g.action !== 'block')
            continue;
        let re;
        try {
            re = new RegExp(g.pattern, 'i');
        }
        catch {
            continue;
        }
        if (re.test(haystack))
            out.push(g);
    }
    return out;
}
export function guardFromMetadata(lessonId, metadata) {
    if (!metadata)
        return null;
    try {
        const meta = JSON.parse(metadata);
        const g = meta?.guard;
        if (!g || g.enabled !== true)
            return null;
        if (typeof g.tool !== 'string' || typeof g.pattern !== 'string' || typeof g.message !== 'string')
            return null;
        return {
            lessonId,
            tool: g.tool,
            pattern: g.pattern,
            message: g.message,
            action: typeof g.action === 'string' ? g.action : 'warn',
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=guards.js.map