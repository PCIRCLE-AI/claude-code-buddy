import { createHash } from 'crypto';
export class ContentHasher {
    static hashEmbeddingSource(entityName, observations = []) {
        const text = [entityName, ...observations].join(' ');
        return createHash('sha256').update(text).digest('hex').substring(0, 16);
    }
}
//# sourceMappingURL=ContentHasher.js.map