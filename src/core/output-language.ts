// =============================================================================
// output-language — one owner for "what language does the LLM write in?"
// =============================================================================
//
// Every LLM prompt in this codebase is written in English, and a model
// answering an English prompt answers in English. For a Chinese (or any
// non-English) user that meant the Insights tab, lessons and digests were
// permanently English regardless of the dashboard locale — the dashboard
// translates the chrome around the content, never the content itself.
//
// The fix is a config key (`language` in ~/.memesh/config.json, settable via
// `memesh config set language <value>` or POST /v1/config) and this module,
// which turns it into one shared prompt instruction. Call sites append
// `outputLanguageInstruction()` to their prompt; when the key is unset the
// function returns '' and the prompt is byte-identical to the pre-feature
// prompt, so English-default behaviour is unchanged.
//
// What localises and what does not:
//   - PROSE localises: digest observations/names, pattern descriptions,
//     lesson error/rootCause/fix/prevention, validator reasons.
//   - IDENTIFIERS do not: entity type slugs ('digest', 'pattern_emergent'),
//     tags ('project:x'), category enums (errorPattern/fixPattern/severity),
//     JSON keys. These are machine-matched downstream (whitelists, tag
//     routing, i18n keys) and a translated enum would silently fall back to
//     'other'/'minor' in every parser.
//
// auto-tagger.ts deliberately does NOT use this module: its entire output is
// prefixed identifier tags, which stay machine-English.
//
// The config value is user-controlled text that lands inside a prompt, so it
// goes through sanitizeForPrompt (the F7 helper) and a hard length cap —
// self-injection is a low-severity path, but a config file is also writable
// by other tooling, and 60 chars is enough for any language name.

import { readConfig, type MeMeshConfig } from './config.js';
import { sanitizeForPrompt } from './prompt-safety.js';

/** Longest accepted language value — CLI and HTTP validators mirror this. */
export const MAX_LANGUAGE_LENGTH = 60;

/**
 * The configured output language, sanitised for prompt interpolation.
 * `null` when unset / blank / not a string — callers add no instruction.
 */
export function getOutputLanguage(config?: MeMeshConfig): string | null {
  const cfg = config ?? readConfig();
  if (typeof cfg.language !== 'string') return null;
  const cleaned = sanitizeForPrompt(cfg.language).trim().slice(0, MAX_LANGUAGE_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The shared prompt instruction. Empty string when no language is
 * configured, so `prompt + outputLanguageInstruction()` is a no-op by
 * default. One sentence for the prose, one for the identifiers — every
 * call site gets both halves or neither.
 */
export function outputLanguageInstruction(config?: MeMeshConfig): string {
  const lang = getOutputLanguage(config);
  if (!lang) return '';
  return `\nWrite all human-readable output text (names, observations, summaries, descriptions, reasons) in ${lang}. Keep JSON keys, category values, entity type slugs and tags in English exactly as specified.`;
}
