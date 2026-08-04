// Minimal SVG icon set for entity-type signalling.
//
// The Visual review and DESIGN.md both pin the dashboard's design
// language as Precision Engineer — minimal, no decoration, color and
// border do all the work. The earlier emoji icons (🎯💡🐛🧩 etc.)
// imported a consumer-app aesthetic that contradicts that contract;
// they also rendered with platform-dependent emoji glow on a dark
// background. This module replaces them with a stroke-based SVG set.
//
// Each icon is 16×16 with a 1.5px stroke, uses `currentColor` so the
// caller controls hue (severity tinting on Lessons; per-cluster on
// Browse), and includes an accessible <title> derived from the type.

import { typeLabel } from '../../lib/entity-display';

interface IconProps {
  /** Entity type — determines which glyph renders. Unknown types fall
   *  back to a small dot so the row layout stays stable. */
  type: string;
  /** Pixel size; defaults to 16 to match the existing emoji-line
   *  height. Hero spots can pass a larger value. */
  size?: number;
  /** Optional override for the stroke / fill hue. Defaults to
   *  `currentColor` so the surrounding text colour controls it. */
  color?: string;
  /** Accessible label override. Most callers can let the type drive
   *  it. */
  ariaLabel?: string;
}

const STROKE = 1.5;

/** Map raw entity types to the visual cluster they belong to. Several
 *  types share an icon (e.g. lesson_learned + lesson + mistake all use
 *  the lightbulb). Anything not listed renders as a generic dot. */
function glyph(type: string): keyof typeof GLYPHS {
  switch (type) {
    case 'lesson_learned': case 'lesson': case 'mistake':
      return 'lesson';
    case 'decision': case 'architecture_decision': case 'design_decision':
      return 'decision';
    case 'pattern': case 'technical_pattern': case 'best_practice':
      return 'pattern';
    case 'bug_fix': case 'verification_result': case 'test_result':
      return 'bug';
    case 'architecture': case 'infrastructure':
      return 'architecture';
    case 'feature': case 'release': case 'refactoring':
      return 'feature';
    case 'commit':
      return 'commit';
    case 'session_keypoint': case 'session_identity':
    case 'session-insight': case 'session-summary': case 'session-identity':
      return 'session';
    case 'workflow_checkpoint':
      return 'milestone';
    case 'weekly-summary': case 'weekly_summary':
      return 'calendar';
    case 'note': case 'plan': case 'knowledge': case 'process':
      return 'note';
    default:
      return 'dot';
  }
}

/**
 * Glyph paths in a 16×16 viewBox. Each is composed of a small set of
 * primitives (stroke, fill) so the rendered file size stays tiny and
 * the visual weight is uniform across the set.
 */
const GLYPHS = {
  // Lightbulb — lessons / mistakes / insights.
  lesson: (
    <>
      <path d="M6 9.5 a4 4 0 1 1 4 0 v1 a1 1 0 0 1 -1 1 h-2 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <path d="M7 13 h2" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M7 14.5 h2" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Crosshair / target — decisions.
  decision: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M8 0.5 v3 M8 12.5 v3 M0.5 8 h3 M12.5 8 h3" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Puzzle piece — patterns.
  pattern: (
    <path
      d="M3 3 h4 v1.5 a1.5 1.5 0 0 0 3 0 V3 h3 v3 h-1.5 a1.5 1.5 0 0 0 0 3 H13 v4 h-4 v-1.5 a1.5 1.5 0 0 0 -3 0 V13 H3 v-4 h1.5 a1.5 1.5 0 0 0 0 -3 H3 z"
      fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round"
    />
  ),
  // Bug — bug_fix / verification.
  bug: (
    <>
      <ellipse cx="8" cy="9" rx="3.5" ry="4" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M8 5 v-1 M5.5 6.5 L4 5 M10.5 6.5 L12 5 M4.5 9 H2.5 M11.5 9 H13.5 M5 11.5 L3.5 13 M11 11.5 L12.5 13" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Stacked rectangles — architecture / infrastructure.
  architecture: (
    <>
      <rect x="2" y="9" width="5" height="5" rx="0.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <rect x="9" y="9" width="5" height="5" rx="0.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <rect x="5.5" y="2" width="5" height="5" rx="0.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
    </>
  ),
  // Sparkle — feature / release / refactoring.
  feature: (
    <>
      <path d="M8 2 L9.5 6.5 L14 8 L9.5 9.5 L8 14 L6.5 9.5 L2 8 L6.5 6.5 z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
    </>
  ),
  // Hash mark — commit.
  commit: (
    <>
      <path d="M5 2 L4 14 M11 2 L10 14 M2.5 6 H13.5 M2.5 10 H13.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Stopwatch — session.
  session: (
    <>
      <circle cx="8" cy="9" r="5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M8 9 V5.5 M8 9 L10.5 11" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M6.5 2 H9.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Flag pin — workflow milestone.
  milestone: (
    <>
      <path d="M4 2 V14" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M4 3 H12 L10 6 L12 9 H4 z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
    </>
  ),
  // Calendar grid — weekly summary.
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M2 6.5 H14 M5 1.5 V4.5 M11 1.5 V4.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Document — note / plan / knowledge.
  note: (
    <>
      <path d="M4 2 H10 L13 5 V14 H4 z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <path d="M10 2 V5 H13" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <path d="M6 8.5 H11 M6 11 H11" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Generic dot — unknown type fallback.
  dot: (
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  ),
};

export function EntityIcon({ type, size = 16, color, ariaLabel }: IconProps) {
  const key = glyph(type);
  // The accessible name is the localised label of the ACTUAL type, not the
  // glyph cluster it maps to — a zh-TW screen-reader user must not hear
  // hardcoded English. typeLabel falls back to the raw slug for types the
  // catalogue does not know, which is still more truthful than a generic
  // English cluster name was.
  const title = ariaLabel ?? typeLabel(type);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="img"
      aria-label={title}
      style={{ color: color ?? 'currentColor', flexShrink: 0, display: 'inline-block', verticalAlign: 'text-bottom' }}
    >
      <title>{title}</title>
      {GLYPHS[key]}
    </svg>
  );
}
