/**
 * What an agent is handed at session start, and the four ways that block
 * used to waste the tokens it spends.
 *
 * Measured against a real graph before the rewrite (ten sessions, the
 * baseline in scripts/audit/): of the memories injected under the old
 * name-first format, the number the session went on to mention was ZERO. The
 * block was carrying a machine dedup key, a near-duplicate of the title, and
 * a provenance-shaped heading that told the model nothing about what it was
 * reading.
 *
 * Each test here pins one of those, plus the two properties that keep the
 * block honest: it must never claim another project's memory belongs to this
 * one, and it must never come back empty on a graph that only has mechanical
 * capture in it (which is every graph on day one).
 */
import { describe, it, expect } from 'vitest';
import {
  WORK_LAYER_TYPES,
  layerOf,
  topologyLine,
  groupTopology,
  buildTopologyLines,
  type TopologyEntity,
} from '../../src/core/work-topology.js';

const entity = (over: Partial<TopologyEntity> & { type: string }): TopologyEntity => ({
  name: 'machine-key-name',
  ...over,
});

describe('work-topology', () => {
  it('never puts the machine name in front of the model', () => {
    // `name` is a dedup key (`commit-a1b2c3d`, `session-<pid>-<ts>-files`).
    // The whole point of UX-1's title was that a human — or a model — should
    // not have to read those.
    const line = topologyLine(
      entity({ type: 'decision', name: 'llm_optionality_messaging', title: 'Ship FTS5 as the baseline' }),
      150,
    );
    expect(line).toContain('Ship FTS5 as the baseline');
    expect(line).not.toContain('llm_optionality_messaging');
  });

  it('falls back title → snippet → type, never to the name', () => {
    const withSnippet = topologyLine(entity({ type: 'fact', name: 'x_y_z', snippet: 'Observed thing' }), 150);
    expect(withSnippet).toBe('- [fact] Observed thing');

    // Nothing to say about it at all: still no machine key.
    const bare = topologyLine(entity({ type: 'note', name: 'commit-a1b2c3d' }), 150);
    expect(bare).not.toContain('commit-a1b2c3d');
    expect(bare).toBe('- [note] note memory');
  });

  it('truncates on a word boundary instead of mid-word', () => {
    const full = 'The client omits the correct Content-Type header entirely';
    const line = topologyLine(entity({ type: 'fact', title: full }), 40);
    expect(line.endsWith('…')).toBe(true);

    // The real property, not a shape guess: whatever survived must be a
    // prefix of the original that ENDS where a word ends — the next
    // character in the source is a space (or the string ran out). The old
    // format cut at a fixed offset and shipped fragments like
    // "…Led user throug"; the reader pays for the clause and cannot use it.
    const shown = line.replace(/^- \[fact\] /, '').replace(/…$/, '');
    expect(full.startsWith(shown)).toBe(true);
    const next = full.charAt(shown.length);
    expect(next === '' || next === ' ').toBe(true);
  });

  it('orders by signal, keeping unscored rows rather than dropping them', () => {
    // Hook-captured rows have no signal_score by design (hooks are cheap
    // always-on capture). "Unscored" must mean "ranks last", never "absent" —
    // on a fresh install those rows are the only memories that exist.
    const sections = groupTopology([
      entity({ type: 'fact', title: 'unscored', signalScore: null }),
      entity({ type: 'fact', title: 'high', signalScore: 0.9 }),
      entity({ type: 'fact', title: 'low', signalScore: 0.2 }),
    ], 'demo');
    const titles = sections[0].entities.map((e) => e.title);
    expect(titles).toEqual(['high', 'low', 'unscored']);
  });

  it('files another project\'s memory under its own heading, never this project\'s', () => {
    const sections = groupTopology([
      entity({ type: 'decision', title: 'ours' }),
      entity({ type: 'decision', title: 'theirs', foreign: true }),
    ], 'memesh');

    const ourSection = sections.find((s) => s.heading.includes('"memesh"'))!;
    expect(ourSection.entities.map((e) => e.title)).toEqual(['ours']);

    const foreignSection = sections.find((s) => s.heading.includes('other projects'))!;
    expect(foreignSection.entities.map((e) => e.title)).toEqual(['theirs']);
    expect(foreignSection.heading).not.toContain('memesh');
  });

  it('still produces a block when the graph holds only mechanical capture', () => {
    // Day one for every user, and the state both plan reviews flagged as the
    // NORM rather than the edge case: no curated memories yet. An empty
    // injection here would read as "memesh has nothing", which is false.
    const lines = buildTopologyLines(
      [entity({ type: 'commit', title: 'fix: repair the parser' }), entity({ type: 'session-insight', title: 'edited 3 files' })],
      'fresh-project',
      { maxChars: 4000 },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('fix: repair the parser');
  });

  it('respects the character budget and emits whole lines only', () => {
    // The caller wraps these in a fence; a line cut in half by the budget
    // could leave that fence danglable, which is the trust boundary.
    const many = Array.from({ length: 200 }, (_, i) =>
      entity({ type: 'fact', title: `fact number ${i} with a reasonable amount of text on it` }));
    const lines = buildTopologyLines(many, 'p', { maxChars: 500 });
    const joined = lines.join('\n');
    expect(joined.length).toBeLessThanOrEqual(500);
    for (const line of lines) {
      if (line === '' || line.endsWith(':')) continue;
      expect(line.startsWith('- [')).toBe(true);
    }
  });

  it('does not emit a heading it has no room to fill', () => {
    const lines = buildTopologyLines(
      [entity({ type: 'decision', title: 'a'.repeat(300) })],
      'p',
      { maxChars: 40 },
    );
    // Either nothing, or a heading WITH content under it — never a bare
    // heading promising memories that got budgeted away.
    if (lines.length > 0) expect(lines.some((l) => l.startsWith('- ['))).toBe(true);
  });

  it('keeps one whitelist for the work layer', () => {
    // Both the CEO and the design review landed independently on this: the
    // graph, the memory list and the injection must not each define their own
    // idea of "work". UX-4 consumes this constant.
    expect(WORK_LAYER_TYPES.has('decision')).toBe(true);
    expect(WORK_LAYER_TYPES.has('lesson_learned')).toBe(true);
    // Declared before anything writes them, so the layer line does not move
    // when A1b starts producing them.
    expect(WORK_LAYER_TYPES.has('task-state')).toBe(true);
    expect(WORK_LAYER_TYPES.has('goal')).toBe(true);
    // Mechanical capture is the evidence layer, not the work layer.
    expect(WORK_LAYER_TYPES.has('commit')).toBe(false);
    expect(layerOf('commit')).toBe('evidence');
    expect(layerOf('decision')).toBe('work');
    expect(layerOf('fact')).toBe('knowledge');
  });
});
