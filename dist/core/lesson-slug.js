import { createHash } from 'node:crypto';
export function lessonSlug(error) {
    const normalized = error.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const words = normalized
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .slice(0, 8);
    const readable = words.join('-') || 'unspecified';
    const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
    return `${readable.slice(0, 71)}-${digest}`;
}
//# sourceMappingURL=lesson-slug.js.map