import fs from 'fs';
import path from 'path';
export const CITATION_RULE_MARKER = '<!-- managed-by: memesh -->';
export const CITATION_RULE_FILENAME = 'memesh-citations.md';
export const CITATION_RULE_BODY = `${CITATION_RULE_MARKER}
# MeMesh memory citations

MeMesh injects relevant memories at session start and before file edits. Every
injected line ends with a handle: \`[mem:42]\`.

When an injected memory genuinely informs your work — you used the fact, the
lesson changed what you did, the decision answered a question you were about to
re-ask — cite it inline once as \`[mem:42]\`, in the sentence it affected.

Do not cite a memory you only read past, and never invent an id. An uncited
memory is recorded as unused: that is how MeMesh learns which memories are
worth the tokens they cost you.
`;
export function citationRuleDir(scope, home, cwd) {
    const base = scope === 'user' ? home : cwd;
    return path.join(base, '.claude', 'rules');
}
export function citationRulePath(scope, home, cwd) {
    return path.join(citationRuleDir(scope, home, cwd), CITATION_RULE_FILENAME);
}
function readRule(filePath, fsImpl) {
    try {
        return { kind: 'read', text: String(fsImpl.readFileSync(filePath, 'utf8')) };
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return { kind: 'absent' };
        throw err;
    }
}
export function writeCitationRule(scope, home, cwd, fsImpl = fs) {
    const filePath = citationRulePath(scope, home, cwd);
    const existing = readRule(filePath, fsImpl);
    if (existing.kind === 'read') {
        if (!existing.text.includes(CITATION_RULE_MARKER)) {
            return { path: filePath, action: 'foreign-file' };
        }
        if (existing.text === CITATION_RULE_BODY)
            return { path: filePath, action: 'unchanged' };
        fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
        return { path: filePath, action: 'updated' };
    }
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, CITATION_RULE_BODY);
    return { path: filePath, action: 'created' };
}
export function removeCitationRule(scope, home, cwd, fsImpl = fs) {
    const filePath = citationRulePath(scope, home, cwd);
    const existing = readRule(filePath, fsImpl);
    if (existing.kind === 'absent')
        return { path: filePath, action: 'absent' };
    if (!existing.text.includes(CITATION_RULE_MARKER))
        return { path: filePath, action: 'foreign-file' };
    fsImpl.rmSync(filePath);
    return { path: filePath, action: 'removed' };
}
export function citationRuleState(scope, home, cwd, fsImpl = fs) {
    const filePath = citationRulePath(scope, home, cwd);
    const existing = readRule(filePath, fsImpl);
    if (existing.kind === 'absent')
        return { path: filePath, state: 'missing' };
    if (!existing.text.includes(CITATION_RULE_MARKER))
        return { path: filePath, state: 'foreign-file' };
    return { path: filePath, state: existing.text === CITATION_RULE_BODY ? 'current' : 'stale' };
}
//# sourceMappingURL=citation-rule.js.map