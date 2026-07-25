export function extractJsonBlock(text, kind) {
    if (!text)
        return null;
    const open = kind === 'object' ? '{' : '[';
    const close = kind === 'object' ? '}' : ']';
    const start = text.indexOf(open);
    if (start === -1)
        return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        }
        else if (ch === open) {
            depth++;
        }
        else if (ch === close) {
            depth--;
            if (depth === 0)
                return text.slice(start, i + 1);
        }
    }
    return null;
}
//# sourceMappingURL=json-utils.js.map