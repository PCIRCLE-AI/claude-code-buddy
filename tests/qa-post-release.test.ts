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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REQUIRED_DOCTOR_CHECKS,
  evaluateDoctor,
  evaluateRegistry,
  evaluateSurfaces,
  formatVerdict,
  packageRootOf,
  parseDoctorChecks,
  shellSurfaces,
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

describe('every memesh a shell would resolve', () => {
  /** An npm-global layout: bin symlinked into lib/node_modules. */
  function posixInstall(root: string, version: string) {
    const packageRoot = path.join(root, 'lib', 'node_modules', '@pcircle', 'memesh');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@pcircle/memesh', version }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const bin = path.join(root, 'bin', 'memesh');
    fs.symlinkSync(path.join(packageRoot, 'dist', 'cli.js'), bin);
    return bin;
  }

  /** The Windows layout: a .cmd shim with the package BELOW its directory. */
  function windowsInstall(root: string, version: string) {
    const packageRoot = path.join(root, 'node_modules', '@pcircle', 'memesh');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@pcircle/memesh', version }));
    const shim = path.join(root, 'memesh.cmd');
    fs.writeFileSync(shim, '@echo off');
    return shim;
  }

  it('reports the second install on PATH, which is the whole incident', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-'));
    try {
      const current = posixInstall(path.join(root, 'nvm'), '4.8.3');
      const stale = posixInstall(path.join(root, 'homebrew'), '4.7.3');
      const surfaces = shellSurfaces('4.8.3', () => [current, stale]);
      expect(surfaces.map((surface) => surface.version)).toEqual(['4.8.3', '4.7.3']);
      const verdict = evaluateSurfaces(surfaces, '4.8.3');
      expect(verdict.ok).toBe(false);
      expect(verdict.detail).toMatch(/4\.7\.3/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the Windows shim layout, where the package sits below the bin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-win-'));
    try {
      const shim = windowsInstall(path.join(root, 'npm'), '4.8.3');
      expect(packageRootOf(shim)).toBe(path.join(root, 'npm', 'node_modules', '@pcircle', 'memesh'));
      expect(shellSurfaces('4.8.3', () => [shim])[0].version).toBe('4.8.3');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not attribute a wrapper script to a stray package further up the tree', () => {
    // The reviewer's scenario: `~/bin/memesh` is a wrapper that execs some
    // other install, and an accidental `npm install` once left
    // `~/node_modules/@pcircle/memesh` behind. Searching for the "package
    // below the bin" layout at every ancestor reported the wrapper as that
    // stray version — a stale surface reading as a PASS.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-wrapper-'));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
      const strayRoot = path.join(home, 'node_modules', '@pcircle', 'memesh');
      fs.mkdirSync(strayRoot, { recursive: true });
      fs.writeFileSync(path.join(strayRoot, 'package.json'),
        JSON.stringify({ name: '@pcircle/memesh', version: '4.8.3' }));
      const wrapper = path.join(home, 'bin', 'memesh');
      fs.writeFileSync(wrapper, '#!/bin/sh\nexec /somewhere/else/memesh "$@"\n', { mode: 0o755 });

      expect(packageRootOf(wrapper)).toBeNull();
      const surfaces = shellSurfaces('4.8.3', () => [wrapper]);
      expect(surfaces[0].version).toBeNull();
      expect(evaluateSurfaces(surfaces, '4.8.3').ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts one install once, however many PATH entries reach it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-dup-'));
    try {
      const bin = posixInstall(path.join(root, 'one'), '4.8.3');
      expect(shellSurfaces('4.8.3', () => [bin, bin])).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an executable that belongs to no package as an unreadable version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-orphan-'));
    try {
      const orphan = path.join(root, 'memesh');
      fs.writeFileSync(orphan, '');
      const surfaces = shellSurfaces('4.8.3', () => [orphan]);
      expect(surfaces[0].version).toBeNull();
      expect(evaluateSurfaces(surfaces, '4.8.3').ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no surface at all when nothing resolves', () => {
    expect(evaluateSurfaces(shellSurfaces('4.8.3', () => []), '4.8.3').ok).toBe(false);
  });

  // Every test above injects the resolver, so the line that actually does the
  // work — `which -a` rather than `which` — was unguarded: changing it back to
  // the single-hit form left all of them green. This one runs the real
  // resolver against a PATH built for it. POSIX only: `where` on Windows
  // already lists every hit, and there is no `.cmd` shim to build here.
  it.skipIf(process.platform === 'win32')('finds BOTH installs with the real resolver, not just the first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-surfaces-path-'));
    try {
      const current = posixInstall(path.join(root, 'first'), '4.8.3');
      const stale = posixInstall(path.join(root, 'second'), '4.7.3');
      const previousPath = process.env.PATH;
      // `which` itself is resolved through this PATH, so the system
      // directories stay on it; the fixtures go first.
      process.env.PATH = [path.dirname(current), path.dirname(stale), '/usr/bin', '/bin']
        .join(path.delimiter);
      try {
        const surfaces = shellSurfaces('4.8.3');
        expect(surfaces.map((surface) => surface.version)).toEqual(['4.8.3', '4.7.3']);
        expect(evaluateSurfaces(surfaces, '4.8.3').ok).toBe(false);
      } finally {
        process.env.PATH = previousPath;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
