export function lessonSlug(error) {
    const words = error
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .slice(0, 8);
    const slug = words.join('-');
    return slug.length > 0 ? slug.slice(0, 80) : 'unspecified';
}
//# sourceMappingURL=lesson-slug.js.map