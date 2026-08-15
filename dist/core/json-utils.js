export function extractJsonBlock(text, kind) {
    return jsonBlocks(text, kind, 1)[0] ?? null;
}
export function jsonBlocks(text, kind, max = Infinity) {
    const out = [];
    if (!text)
        return out;
    const open = kind === 'object' ? '{' : '[';
    const close = kind === 'object' ? '}' : ']';
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
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
            if (depth > 0)
                inString = true;
        }
        else if (ch === open) {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (ch === close && depth > 0) {
            depth--;
            if (depth === 0 && start !== -1) {
                out.push(text.slice(start, i + 1));
                start = -1;
                if (out.length >= max)
                    return out;
            }
        }
    }
    return out;
}
//# sourceMappingURL=json-utils.js.map