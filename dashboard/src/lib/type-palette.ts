/**
 * Categorical entity-type colours — the species palette. These map to NO
 * design token, so they are literals on purpose and are the sanctioned
 * exception to the token-literal gate. See DESIGN.md "Species palette".
 *
 * Every value is the output of ONE formula, not a hand-picked hue:
 *
 *     oklch(0.78 0.12 H)  →  sRGB hex
 *
 * Equal lightness and chroma across species means no type shouts over
 * another — the luminance channel is reserved for vitality (recency), per
 * DESIGN.md "Hue encodes species; luminance encodes vitality". The H per
 * type is recorded beside each entry; anchored hues (lesson 85, concept
 * 200, pattern 230) come from DESIGN.md, the rest are spaced ≥25° apart
 * with the life band (~135°) left to `--life` itself. The values are
 * written down (rather than computed at runtime) because
 * `tests/dashboard-i18n.test.ts` parses this block as the type vocabulary.
 *
 * The two types that coincide with a token are NOT here: `decision` =
 * `--life` (decisions are this brain's main produce) and `session-insight`
 * = `--text-2` (weak signal stays grey). GraphTab resolves those from the
 * tokens at runtime (canvas cannot read `var()`), so a palette change
 * reaches them.
 */
export const CATEGORICAL_TYPE_COLORS: Record<string, string> = {
  lesson_learned: '#DBB155',      // H=85 (anchor — earthy; amber differs by chroma)
  concept: '#3ACED6',             // H=200 (anchor)
  pattern: '#59C5F5',             // H=230 (anchor)
  technical_pattern: '#59C5F5',   // H=230 (same family as pattern)
  commit: '#A8AFFF',              // H=280
  session_keypoint: '#52D0B3',    // H=175
  session_identity: '#E39BDC',    // H=330
  workflow_checkpoint: '#82BAFF', // H=255
  feature: '#EFA464',             // H=60
  bug_fix: '#FB9890',             // H=25
  tool: '#C9A3F5',                // H=305
  person: '#F496BB',              // H=355
  note: '#BCBE5E',                // H=110
};
