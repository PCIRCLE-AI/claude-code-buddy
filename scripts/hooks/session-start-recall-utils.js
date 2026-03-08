/**
 * Session-Start Recall Utilities
 *
 * Utility functions for proactive memory recall during session start.
 * Builds search queries from project context and formats recall results.
 */

/**
 * Build FTS5 search query from project name and recent commits.
 * Strips conventional commit prefixes (fix:, feat(scope):, etc.)
 * @param {string} projectName
 * @param {string[]} recentCommits
 * @returns {string}
 */
export function buildSessionRecallQuery(projectName, recentCommits = []) {
  const parts = [projectName];
  if (recentCommits.length > 0) {
    const cleaned = recentCommits
      .map(msg => msg.replace(/^(fix|feat|chore|refactor|perf|docs|test|style|ci)\(?[^)]*\)?:\s*/i, '').trim())
      .filter(msg => msg.length > 0);
    parts.push(...cleaned);
  }
  return parts.join(' ').trim();
}

/**
 * Format recall results for hook output display.
 * Shows max 2 observations per entity.
 * @param {Array<{name: string, observations: string[], similarity: number}>} results
 * @returns {string} Formatted output (empty string if no results)
 */
export function formatRecallOutput(results) {
  if (!results || results.length === 0) return '';
  const lines = results.map(r => {
    const pct = Math.round(r.similarity * 100);
    const obs = r.observations.slice(0, 2).join('; ');
    return `  - ${r.name} (${pct}%): ${obs}`;
  });
  return lines.join('\n');
}
