import { readConfig } from './config.js';
import { sanitizeForPrompt } from './prompt-safety.js';
export const MAX_LANGUAGE_LENGTH = 60;
export function languageValueError(value) {
    if (/[\x00-\x1f\x7f]/.test(value)) {
        return 'must not contain line breaks or other control characters';
    }
    return null;
}
export function getOutputLanguage(config) {
    const cfg = config ?? readConfig();
    if (typeof cfg.language !== 'string')
        return null;
    const singleLine = cfg.language
        .replace(/[\x00-\x1f\x7f]+/g, ' ');
    const cleaned = sanitizeForPrompt(singleLine).trim().slice(0, MAX_LANGUAGE_LENGTH);
    return cleaned.length > 0 ? cleaned : null;
}
export function outputLanguageInstruction(config) {
    const lang = getOutputLanguage(config);
    if (!lang)
        return '';
    return `\nWrite all human-readable output text (names, observations, summaries, descriptions, reasons) in ${lang}. Keep JSON keys, category values, entity type slugs and tags in English exactly as specified.`;
}
//# sourceMappingURL=output-language.js.map