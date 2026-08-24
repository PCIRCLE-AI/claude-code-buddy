/**
 * Both session-start banners must handle every install channel.
 *
 * The defect this pins: `buildUpdateAvailableBanner` learned that a
 * plugin-marketplace install needs a plugin command (and later, that Codex
 * needs a different one from Claude Code) while `buildDeprecationBanner` never
 * got a `plugin-marketplace` branch at all. So plugin users fell to the generic
 * "fetch the latest from npm" line — and they fell to it in the ONE case that
 * matters most, because the deprecation banner fires on a maintainer security
 * advisory and takes precedence over the update-available one. The highest
 * stakes message carried the least actionable instruction, for both hosts.
 *
 * This is a structural assertion, and deliberately so. The behavioural path
 * needs the hook to resolve its own location inside a plugin cache, which means
 * copying the tree into `<tmp>/.claude/plugins/cache/.../scripts/hooks/` — a
 * lot of machinery to prove a branch exists. What actually went wrong was
 * coverage drift between two copies of one decision, and that is what this
 * reads. `tests/hooks/session-start.test.ts` already drives the real hook and
 * asserts a remediation line is emitted.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');
const CHANNEL_SRC = path.join(__dirname, '..', '..', 'src', 'core', 'install-channel.ts');

/** The channels `detectInstallChannel` can actually return, read from its type. */
function installChannels(): string[] {
  const src = fs.readFileSync(CHANNEL_SRC, 'utf8');
  const m = src.match(/export type InstallChannel =([^;]+);/);
  if (!m) throw new Error('InstallChannel type not found — this test stopped looking at anything');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map(g => g[1]);
}

/** The channel names a given banner function branches on. */
function channelsHandledBy(fnName: string): string[] {
  const src = fs.readFileSync(HOOK, 'utf8');
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`${fnName} not found in session-start.js`);
  // Each banner ends at the next top-level `function ` declaration.
  const next = src.indexOf('\nfunction ', start + 1);
  const body = src.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/channel === '([a-z-]+)'/g)].map(g => g[1]);
}

describe('session-start banners cover every install channel', () => {
  const channels = installChannels();

  it('the channel list itself is non-empty and includes the plugin case', () => {
    // Guard the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(channels.length).toBeGreaterThan(2);
    expect(channels).toContain('plugin-marketplace');
  });

  it.each(['buildDeprecationBanner', 'buildUpdateAvailableBanner'])(
    '%s handles plugin-marketplace explicitly, not via the generic fallback',
    (fn) => {
      expect(
        channelsHandledBy(fn),
        `${fn} has no plugin-marketplace branch, so plugin installs get generic npm advice`,
      ).toContain('plugin-marketplace');
    },
  );

  it('the two banners branch on the same set of channels', () => {
    // Drift between them is the defect, not the absolute coverage. `unknown`
    // is deliberately absent from both — it is the `else` fallback.
    const dep = [...channelsHandledBy('buildDeprecationBanner')].sort();
    const upd = [...channelsHandledBy('buildUpdateAvailableBanner')].sort();
    expect(dep, 'the deprecation and update banners disagree on which channels they handle').toEqual(upd);
  });

  it('both route the plugin case through ONE helper, not two copies', () => {
    // The drift happened because the decision was written down twice. A single
    // owner is what stops it recurring; two call sites of the same helper is
    // the shape that proves it.
    const src = fs.readFileSync(HOOK, 'utf8');
    const callSites = [...src.matchAll(/lines\.push\(pluginUpgradeLine\(/g)].length;
    expect(callSites, 'expected both banners to call pluginUpgradeLine').toBe(2);
  });

  it('the plugin helper distinguishes the two hosts', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    const start = src.indexOf('function pluginUpgradeLine(');
    expect(start, 'pluginUpgradeLine not found').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    expect(body, 'the helper does not consult the plugin host').toMatch(/pluginHostOf\(/);
    expect(body, 'no Codex-specific command').toMatch(/codex plugin marketplace upgrade/);
    expect(body, 'no Claude Code command').toMatch(/memesh upgrade-plugin/);
  });
});
