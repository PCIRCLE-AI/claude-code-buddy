export function sanitizeForPrompt(value) {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/<\s*\/\s*[a-z][a-z0-9_]*\s*>/gi, '[CLOSING-TAG-STRIPPED]')
        .replace(/<\s*\/?\s*(system|assistant|user)\s*>/gi, '[ROLE-TAG-STRIPPED]')
        .replace(/<\s*[a-z][a-z0-9_]*\s*>/gi, '[OPEN-TAG-STRIPPED]')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
export function sanitizeListForPrompt(items) {
    return items.map(sanitizeForPrompt).join('\n');
}
export function wrapUntrusted(tag, text) {
    if (!/^[a-z][a-z0-9_]*$/.test(tag)) {
        throw new Error(`wrapUntrusted: invalid tag name ${JSON.stringify(tag)} — lowercase identifiers only`);
    }
    const body = Array.isArray(text) ? sanitizeListForPrompt(text) : sanitizeForPrompt(text);
    return `<${tag}>\n${body}\n</${tag}>`;
}
//# sourceMappingURL=prompt-safety.js.map