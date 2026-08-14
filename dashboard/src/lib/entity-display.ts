// =============================================================================
// Shared display helpers for entity rows / cards
// =============================================================================
//
// Reused across BrowseTab, LessonsTab, and any future memory-listing surface
// so that a single Entity renders consistently regardless of where it shows up.

import type { Entity } from './api';
import { t, getLocale } from './i18n';

/* ---------- type clustering ---------- */

export type TypeCluster = 'knowledge' | 'activity' | 'reference' | 'session';

const TYPE_CLUSTER: Record<string, TypeCluster> = {
  // Knowledge: high-value insights, lessons, decisions, patterns
  lesson_learned: 'knowledge', lesson: 'knowledge', mistake: 'knowledge',
  decision: 'knowledge', architecture_decision: 'knowledge', design_decision: 'knowledge',
  pattern: 'knowledge', technical_pattern: 'knowledge', best_practice: 'knowledge',
  bug_fix: 'knowledge', verification_result: 'knowledge', test_result: 'knowledge',
  process: 'knowledge', architecture: 'knowledge', infrastructure: 'knowledge',
  feature: 'knowledge', release: 'knowledge', refactoring: 'knowledge',

  // Activity: work logs (commits, sessions)
  commit: 'activity',
  session_keypoint: 'session', session_identity: 'session',
  'session-insight': 'session', 'session-summary': 'session', 'session-identity': 'session',
  weekly_summary: 'activity', 'weekly-summary': 'activity',

  // Reference: notes, plans, knowledge bases
  note: 'reference', plan: 'reference', knowledge: 'reference',
  workflow_checkpoint: 'reference',
};

export function clusterOf(type: string): TypeCluster {
  return TYPE_CLUSTER[type] ?? 'reference';
}

/* ---------- icons ---------- */

const TYPE_ICON: Record<string, string> = {
  lesson_learned: '💡', lesson: '💡', mistake: '⚠️',
  decision: '🎯', architecture_decision: '🎯', design_decision: '🎯',
  pattern: '🧩', technical_pattern: '🧩', best_practice: '🧩',
  bug_fix: '🐛', verification_result: '✅', test_result: '✅',
  process: '⚙️', architecture: '🏗️', infrastructure: '🏗️',
  feature: '✨', release: '🚀', refactoring: '♻️',
  commit: '📝',
  session_keypoint: '⏱️', session_identity: '⏱️',
  'session-insight': '⏱️', 'session-summary': '⏱️', 'session-identity': '⏱️',
  weekly_summary: '📅', 'weekly-summary': '📅',
  note: '📓', plan: '🗺️', knowledge: '📚',
  workflow_checkpoint: '🔖',
};

export function iconFor(type: string): string {
  return TYPE_ICON[type] ?? '·';
}

/* ---------- localised type / relation labels ---------- */

/** Localised label for an entity type. Entity types are open-ended server
 *  data (any string can arrive), so this cannot be a closed switch: the
 *  catalogue covers every type this codebase produces (`type.*` keys, all
 *  11 locales, enforced by tests/dashboard-i18n.test.ts), and anything
 *  outside it falls back to the raw slug via the sanctioned
 *  `translated === key` miss detection — t() returns the key itself on a
 *  miss, never undefined, so `|| type` would be dead code. */
export function typeLabel(type: string): string {
  const key = `type.${type}`;
  const translated = t(key);
  return translated === key ? type : translated;
}

/** Localised label for a relation type (graph edge labels). Same open-set
 *  contract and miss detection as typeLabel — relations are free-form
 *  labels; only the ones this codebase emits are in the catalogue. */
export function relationLabel(type: string): string {
  const key = `relation.${type}`;
  const translated = t(key);
  return translated === key ? type : translated;
}

/* ---------- relative time ---------- */

/** Human-friendly relative date, localised via i18n. Falls back to a locale
 *  date for entries older than a year. */
export function relativeDate(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const ms = now.getTime() - then.getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 0) return then.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  if (days === 0) {
    const hours = Math.floor(ms / 3600000);
    if (hours < 1) return t('time.justNow');
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('time.today');
  }
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.daysAgo', { count: days });
  if (days < 14) return t('time.lastWeek');
  if (days < 30) return t('time.weeksAgo', { count: Math.floor(days / 7) });
  if (days < 60) return t('time.lastMonth');
  if (days < 365) return t('time.monthsAgo', { count: Math.floor(days / 30) });
  return then.toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ---------- time bucket ---------- */

export type TimeBucket = 'today' | 'week' | 'month' | 'older';

export function timeBucket(iso: string | null | undefined, now: Date = new Date()): TimeBucket {
  if (!iso) return 'older';
  const ms = now.getTime() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'today';
  if (days < 7) return 'week';
  if (days < 30) return 'month';
  return 'older';
}

/* ---------- project extraction ---------- */

const PROJECT_TAG_PREFIX = 'project:';

export function extractProject(entity: Entity): string | null {
  const tag = entity.tags?.find((t) => t.startsWith(PROJECT_TAG_PREFIX));
  if (tag) return tag.slice(PROJECT_TAG_PREFIX.length);
  return null;
}

/* ---------- best preview ---------- */

/** Pick the most informative observation for a one-line preview. The default
 *  `observations[0]` is often a structural marker (date, "Plan X completed").
 *  This skips short or obviously-non-content observations and prefers the
 *  longest meaningful one within the first few. */
export function pickBestObservation(observations: string[] | undefined): string {
  if (!observations || observations.length === 0) return '';
  // Filter out short metadata-style observations
  const nonTrivial = observations.filter(
    (o) => o.length > 30 && !/^(Steps|Commits|Plan ".+" completed)/.test(o.trim()),
  );
  const pool = nonTrivial.length > 0 ? nonTrivial : observations;
  // Prefer the longest of the first 3 (avoid scanning huge memory entries)
  return pool.slice(0, 3).reduce((best, cur) => (cur.length > best.length ? cur : best), pool[0]);
}

/* ---------- display title ---------- */

/** Human-readable headline for an entity row/card. Fallback chain:
 *  title → pickBestObservation → typeLabel + date. Deliberately NEVER
 *  falls back to `name` — name is a machine dedup key
 *  (`pre-compact-<sessionId>`, `commit-a1b2c3d`) and the whole point of
 *  `title` is that a human should not have to read those. An empty or
 *  whitespace title counts as absent, same as the write-side contract
 *  where blank collapses to undefined. */
export function displayTitle(entity: Entity): string {
  const title = entity.title?.trim();
  if (title) return title;
  const obs = pickBestObservation(entity.observations);
  if (obs) return obs;
  const date = entity.created_at
    ? new Date(entity.created_at).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  return date ? `${typeLabel(entity.type)} · ${date}` : typeLabel(entity.type);
}

/* ---------- access count signal ---------- */

export interface AccessSignal {
  count: number;
  label: string;
  tone: 'high' | 'medium' | 'low' | 'none';
}

/** Categorise access_count into a signal the UI can colour-code. */
export function accessSignal(count: number | undefined): AccessSignal {
  const n = count ?? 0;
  if (n === 0) return { count: n, label: t('memory.access.never'), tone: 'none' };
  if (n >= 20) return { count: n, label: t('memory.access.frequent', { count: n }), tone: 'high' };
  if (n >= 5) return { count: n, label: t('memory.access.recalls', { count: n }), tone: 'medium' };
  return { count: n, label: t('memory.access.recalls', { count: n }), tone: 'low' };
}

/* ---------- lesson categorisation ---------- */

export type LessonKind = 'failure' | 'plan-completion' | 'freeform';

/** Classify a `lesson_learned` entity into the three real-world shapes:
 *  failure-driven (Error/Root/Fix/Prevention structure), plan-completion
 *  (auto-generated from gstack), or freeform note. */
export function classifyLesson(entity: Entity): LessonKind {
  const tags = entity.tags ?? [];
  if (tags.some((t) => t === 'plan-completion' || t.startsWith('plan:'))) return 'plan-completion';
  const obs = entity.observations ?? [];
  const joined = obs.join(' ');
  const hasStructure =
    /(^|\s)Error:/.test(joined) &&
    (/(^|\s)Fix:/.test(joined) || /(^|\s)Root cause:/.test(joined));
  if (hasStructure) return 'failure';
  return 'freeform';
}
