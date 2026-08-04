/**
 * Categorical entity-type colours. These map to NO design token — one accent
 * cannot encode ~14 categories — so they are literals on purpose and are the
 * sanctioned exception to the token-literal gate. See DESIGN.md "Entity-type
 * colours are a separate categorical palette".
 *
 * The types that coincide with a token are NOT here: decision/concept = accent,
 * pattern = info, lesson_learned = warning, session-insight = text-2. GraphTab
 * resolves those from the tokens at runtime (canvas cannot read `var()`), so a
 * palette change reaches them. Only genuinely category-only hues live here.
 */
export const CATEGORICAL_TYPE_COLORS: Record<string, string> = {
  commit: '#A78BFA',
  session_keypoint: '#4ADE80',
  session_identity: '#F472B6',
  workflow_checkpoint: '#38BDF8',
  feature: '#FB923C',
  bug_fix: '#F87171',
  tool: '#818CF8',
  person: '#E879F9',
  note: '#94A3B8',
};
