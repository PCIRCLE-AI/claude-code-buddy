export const TITLE_MAX_LENGTH = 200;
export function truncateTitle(text) {
    if (!text)
        return text;
    const trimmed = text.trim();
    return trimmed.length > TITLE_MAX_LENGTH
        ? trimmed.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + '…'
        : trimmed;
}
export const BOILERPLATE_OBSERVATION_PATTERN = /^(Steps|Commits|Branch|Diff stats|Compaction reason|Tool calls|Plan ".+" completed)[:\s]/;
export function isBoilerplateObservation(text) {
    return BOILERPLATE_OBSERVATION_PATTERN.test(text.trim());
}
//# sourceMappingURL=title.js.map