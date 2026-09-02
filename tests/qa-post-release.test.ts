/**
 * The post-release gate's three questions, pinned as pure decisions.
 *
 * Each case is one of the incidents this repository actually had, in the form
 * the gate has to recognise it:
 *   - a tag and a GitHub Release with nothing on npm (v4.7.0),
 *   - a machine whose installed surface is a version behind the release
 *     (2026-09-02: a 4.8.2 CLI on PATH beside a 4.8.3 plugin),
 *   - a check that has stopped existing, which must be red rather than
 *     silently narrowing what the gate covers.
 */
import { describe, it, expect } from 'vitest';
import {
  REQUIRED_DOCTOR_CHECKS,
  evaluateDoctor,
  evaluateRegistry,
  evaluateSurfaces,
  formatVerdict,
  parseDoctorChecks,
} from '../scripts/qa/post-release.mjs';

const published = {
  'dist-tags': { latest: '4.8.3' },
  versions: { '4.8.2': {}, '4.8.3': {} },
};

describe('registry acceptance', () => {
  it('passes when the version is published and is what npm install gives', () => {
    expect(evaluateRegistry(published, '4.8.3')).toMatchObject({ ok: true });
  });

  it('fails when the release was tagged but never published', () => {
    const result = evaluateRegistry(published, '4.7.0');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not on the registry/);
    expect(result.fix).toMatch(/publish-npm/);
  });

  it('fails when the version is published but latest points elsewhere', () => {
    const result = evaluateRegistry(published, '4.8.2');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/latest dist-tag is 4\.8\.3/);
  });
});

describe('installed surfaces on this machine', () => {
  const surface = (version: string | null) => ({
    name: 'shell CLI on PATH', version, location: '/usr/local/lib/node_modules/@pcircle/memesh', fix: 'Run `npm install -g @pcircle/memesh@4.8.3`.',
  });

  it('passes only when every surface found is the released version', () => {
    expect(evaluateSurfaces([surface('4.8.3')], '4.8.3')).toMatchObject({ ok: true });
  });

  it('fails on the skew that shipped on 2026-09-02', () => {
    const result = evaluateSurfaces([surface('4.8.2')], '4.8.3');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/is on 4\.8\.2/);
  });

  it('treats an unreadable version as a failure, not as agreement', () => {
    expect(evaluateSurfaces([surface(null)], '4.8.3').ok).toBe(false);
  });

  it('reports no surface at all as a failure — absence is not a pass', () => {
    const result = evaluateSurfaces([], '4.8.3');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no memesh install was found/);
  });
});

describe('the released artifact’s own doctor', () => {
  const allPassing = REQUIRED_DOCTOR_CHECKS.map((id) => ({ id, status: 'pass' }));

  it('passes when every install-integrity check passes', () => {
    expect(evaluateDoctor(allPassing)).toMatchObject({ ok: true });
  });

  it('ignores warnings, which are not broken installs', () => {
    const warned = allPassing.map((check, index) => (index === 0 ? { ...check, status: 'warn' } : check));
    expect(evaluateDoctor(warned).ok).toBe(true);
  });

  it('fails when an install-integrity check fails', () => {
    const failed = allPassing.map((check) => (check.id === 'mcp-config' ? { ...check, status: 'fail' } : check));
    expect(evaluateDoctor(failed)).toMatchObject({ ok: false });
    expect(evaluateDoctor(failed).detail).toMatch(/mcp-config/);
  });

  it('fails when a required check no longer exists, instead of checking nothing', () => {
    const renamed = allPassing.filter((check) => check.id !== 'skills-manifest');
    const result = evaluateDoctor(renamed);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no longer reports skills-manifest/);
  });
});

describe('reading doctor output', () => {
  it('returns the checks a real doctor run prints', () => {
    expect(parseDoctorChecks('{"status":"pass","checks":[{"id":"mcp-config","status":"pass"}]}'))
      .toEqual([{ id: 'mcp-config', status: 'pass' }]);
  });

  it('returns null — never an empty pass — for output it cannot read', () => {
    expect(parseDoctorChecks('')).toBeNull();
    expect(parseDoctorChecks('memesh: command not found')).toBeNull();
    expect(parseDoctorChecks('{"status":"pass"}')).toBeNull();
    expect(parseDoctorChecks('{"checks":"none"}')).toBeNull();
  });
});

describe('verdict', () => {
  it('is a pass only when every result passed, and never on an empty run', () => {
    expect(formatVerdict([{ id: 'a', ok: true, detail: 'd' }]).ok).toBe(true);
    expect(formatVerdict([{ id: 'a', ok: true, detail: 'd' }, { id: 'b', ok: false, detail: 'd' }]).ok).toBe(false);
    expect(formatVerdict([]).ok).toBe(false);
  });

  it('prints the fix for a failure and not for a pass', () => {
    const { lines } = formatVerdict([
      { id: 'a', ok: true, detail: 'fine', fix: 'unused' },
      { id: 'b', ok: false, detail: 'broken', fix: 'do this' },
    ]);
    expect(lines[0]).not.toMatch(/unused/);
    expect(lines[1]).toMatch(/fix: do this/);
  });
});
