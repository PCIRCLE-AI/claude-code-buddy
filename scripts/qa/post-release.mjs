#!/usr/bin/env node
/**
 * What a release gate cannot see: the machine.
 *
 * Every gate in this repository runs on a fresh checkout or a fresh install,
 * and every failure that reached a user lived in state that already existed:
 * v4.7.0 had a tag and a GitHub Release and npm never got the package;
 * v4.8.2's plugin cache was keyed by version and went on serving 4.8.1 code;
 * on 2026-09-02 a PATH CLI on 4.8.2 sat beside a plugin on 4.8.3. All three
 * shipped with every gate green.
 *
 * So this one runs AFTER the release, against the published version, and asks
 * the questions those incidents answer badly:
 *
 *   registry  — is the version actually on the registry, and is it `latest`?
 *   consumer  — does a fresh install FROM THE REGISTRY run that version?
 *   artifact  — does the released artifact's own doctor find its tree intact?
 *   machine   — is that version what this machine has installed?
 *
 * It is read-only with respect to owner state: the fresh install goes to a
 * throwaway prefix, every child process gets a throwaway MEMESH_DIR and
 * MEMESH_DB_PATH so nothing opens the real knowledge graph, and remediation
 * commands are printed rather than run. The installed state of this machine
 * belongs to its owner.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binTargets, hookCommands } from '../lib/executable-targets.mjs';
import { npmSync } from '../lib/npm-bin.mjs';
import { fetchPackument } from '../lib/upgrade-matrix.mjs';

const packageName = '@pcircle/memesh';
const npmTimeoutMs = 180_000;
const processTimeoutMs = 45_000;

/**
 * The doctor checks that speak about the integrity of the package tree they
 * run from. A `fail` in any of these means the published artifact itself is
 * broken, for whoever installs it.
 *
 * They are deliberately NOT described as machine checks. Measured, not
 * assumed: running the released doctor twice against the same install — once
 * with this machine's HOME, once with a throwaway one — returns identical
 * statuses for all seven. The only check whose answer changes is
 * `hook-wiring`, which reads the host's `installed_plugins.json`; it warns
 * rather than fails when a machine has no Claude Code at all, which is a
 * legitimate state and not a broken release, so it stays doctor's to report
 * and not this gate's to fail on. What this gate asks about the machine it
 * asks in `machine-surfaces`, from the installed versions themselves.
 *
 * Named explicitly, and required to be PRESENT: a check that has been renamed
 * or removed must make this gate red rather than silently shrink what it
 * covers. That is the exact shape of the defect this gate exists for —
 * `inspectMcpConfig` rewrote `${CLAUDE_PLUGIN_ROOT}` to its own package root,
 * so it always found the file, always passed, and hid a broken `.mcp.json`
 * for three and a half months.
 */
export const REQUIRED_DOCTOR_CHECKS = [
  'install-channel',
  'mcp-config',
  'hooks-config',
  'hook-scripts',
  'skills-manifest',
  'native-binding',
  'dashboard',
];

/**
 * Is the version on the registry, and is it what `npm install` would give?
 *
 * @param {object} packument abbreviated registry document
 * @param {string} version
 * @returns {{ok: boolean, detail: string, fix?: string}}
 */
export function evaluateRegistry(packument, version) {
  const published = Object.keys(packument?.versions ?? {});
  if (!published.includes(version)) {
    return {
      ok: false,
      detail: `${packageName}@${version} is not on the registry (${published.length} versions published, newest ${published[published.length - 1] ?? 'none'})`,
      fix: 'The tag and the GitHub Release exist without a publish — this is the v4.7.0 shape. Check the publish-npm workflow run for the release.',
    };
  }
  const latest = packument?.['dist-tags']?.latest;
  if (latest !== version) {
    return {
      ok: false,
      detail: `${packageName}@${version} is published but the latest dist-tag is ${latest ?? 'missing'}, so a plain \`npm install\` does not get it`,
      fix: `Move the tag deliberately: \`npm dist-tag add ${packageName}@${version} latest\`.`,
    };
  }
  return { ok: true, detail: `${packageName}@${version} is published and is the latest dist-tag` };
}

/**
 * Compare every install surface found on this machine against the release.
 *
 * A surface that is absent is reported as absent — never as a pass. "No
 * failure signal" is not a success signal, and the skew incident was two
 * surfaces disagreeing while each one looked fine on its own.
 *
 * @param {{name: string, version: string|null, location: string, fix: string}[]} surfaces
 * @param {string} version
 * @returns {{ok: boolean, detail: string, fix?: string}}
 */
export function evaluateSurfaces(surfaces, version) {
  if (surfaces.length === 0) {
    return {
      ok: false,
      detail: 'no memesh install was found on this machine, so nothing here can be confirmed to run the release',
      fix: `Install it: \`npm install -g ${packageName}@${version}\`.`,
    };
  }
  const stale = surfaces.filter((surface) => surface.version !== version);
  if (stale.length > 0) {
    return {
      ok: false,
      detail: stale
        .map((surface) => `${surface.name} is on ${surface.version ?? 'an unreadable version'} (${surface.location})`)
        .join('; '),
      fix: stale.map((surface) => surface.fix).join(' '),
    };
  }
  return {
    ok: true,
    detail: surfaces.map((surface) => `${surface.name}=${surface.version}`).join(', '),
  };
}

/**
 * @param {{id: string, status: string}[]} checks doctor's own JSON checks
 * @param {string[]} requiredIds
 * @returns {{ok: boolean, detail: string, fix?: string}}
 */
export function evaluateDoctor(checks, requiredIds = REQUIRED_DOCTOR_CHECKS) {
  const byId = new Map(checks.map((check) => [check.id, check.status]));
  const missing = requiredIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `doctor no longer reports ${missing.join(', ')} — this gate would be checking nothing`,
      fix: 'Update REQUIRED_DOCTOR_CHECKS in scripts/qa/post-release.mjs to the checks doctor actually ships.',
    };
  }
  const failed = requiredIds.filter((id) => byId.get(id) === 'fail');
  if (failed.length > 0) {
    return {
      ok: false,
      detail: `the released artifact's own doctor fails on its own package tree: ${failed.join(', ')}`,
      fix: 'Run `memesh doctor` and read the fix each failing check prints.',
    };
  }
  return { ok: true, detail: `${requiredIds.length} install-integrity checks pass under the released artifact` };
}

/**
 * The `checks` array out of a doctor `--json` run, or null when the output is
 * not readable as that.
 *
 * Separated from the call site so the unreadable branch has a test: a gate
 * that silently treats "doctor printed nothing I could parse" as "doctor is
 * fine" is the failure this whole script is against, and a `catch` inside
 * `main()` is a branch nothing can reach from a test.
 *
 * @param {string} stdout
 * @returns {{id: string, status: string}[] | null}
 */
export function parseDoctorChecks(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.checks) ? parsed.checks : null;
  } catch {
    return null;
  }
}

/** @param {{id: string, ok: boolean, detail: string, fix?: string}[]} results */
export function formatVerdict(results) {
  const lines = results.map((result) => `  ${result.ok ? 'PASS' : 'FAIL'}  ${result.id}: ${result.detail}`
    + (result.ok || !result.fix ? '' : `\n        fix: ${result.fix}`));
  return { ok: results.length > 0 && results.every((result) => result.ok), lines };
}

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    encoding: 'utf8',
    timeout: processTimeoutMs,
    killSignal: 'SIGTERM',
    ...options,
  });
}

/** A throwaway data directory, so no child process opens the real graph. */
function isolatedDataEnv(baseEnv, dataDir) {
  return {
    ...baseEnv,
    MEMESH_DIR: dataDir,
    MEMESH_DB_PATH: path.join(dataDir, 'knowledge-graph.db'),
    MEMESH_AUTO_CAPTURE: 'false',
    MEMESH_AUTO_DETECT_LLM: '0',
  };
}

/** The package root a `memesh` on PATH resolves into, or null. */
function shellSurface(version) {
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['memesh'], {
    encoding: 'utf8',
    timeout: processTimeoutMs,
  });
  const first = String(lookup.stdout ?? '').split('\n')[0].trim();
  if (lookup.status !== 0 || !first) return null;

  let entry = first;
  for (let hops = 0; hops < 10 && fs.existsSync(entry) && fs.lstatSync(entry).isSymbolicLink(); hops += 1) {
    entry = path.resolve(path.dirname(entry), fs.readlinkSync(entry));
  }
  let dir = path.dirname(entry);
  for (let hops = 0; hops < 10; hops += 1) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.name === packageName) {
        return {
          name: 'shell CLI on PATH',
          version: parsed.version ?? null,
          location: dir,
          fix: `Run \`npm install -g ${packageName}@${version}\`.`,
        };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: 'shell CLI on PATH', version: null, location: first, fix: `Run \`npm install -g ${packageName}@${version}\`.` };
}

function freshConsumerInstall(version, root) {
  const prefix = path.join(root, 'npm-prefix');
  const cache = path.join(root, 'npm-cache');
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  for (const dir of [prefix, cache, home, data]) fs.mkdirSync(dir, { recursive: true });

  const env = isolatedDataEnv({ ...process.env, HOME: home, USERPROFILE: home }, data);
  // A failing install is carried out as text, not swallowed: the caller puts
  // it in the `consumer` result, so the verdict says why rather than ending in
  // an npm stack trace with no verdict at all. Proven by fault injection — an
  // `npm` shim on PATH that fails only on `install` — which must still produce
  // a FAIL verdict and a non-zero exit.
  let installError = null;
  try {
    npmSync(['install', '--global', '--prefix', prefix, '--cache', cache, `${packageName}@${version}`], {
      stdio: 'inherit',
      env,
      timeout: npmTimeoutMs,
    });
  } catch (error) {
    installError = error instanceof Error ? error.message : String(error);
  }

  const packageRoot = path.join(prefix, 'lib', 'node_modules', '@pcircle', 'memesh');
  const windowsRoot = path.join(prefix, 'node_modules', '@pcircle', 'memesh');
  const resolved = fs.existsSync(packageRoot) ? packageRoot : windowsRoot;
  return { packageRoot: resolved, env, home, data, installError };
}

async function main() {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf('--version');
  const repoRoot = process.cwd();
  const version = flagIndex >= 0
    ? args[flagIndex + 1]
    : JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-post-release-'));
  const results = [];
  try {
    const registry = String(npmSync(['config', 'get', 'registry'], {
      cwd: repoRoot, encoding: 'utf8', timeout: processTimeoutMs,
    })).trim();
    console.log(`post-release check: version=${version} registry=${registry}\n`);

    const packument = await fetchPackument(packageName, registry);
    results.push({ id: 'registry', ...evaluateRegistry(packument, version) });

    // Everything below installs the version under test. There is nothing to
    // install when the registry does not have it, and running the rest would
    // report failures that all say the same thing.
    if (results[0].ok) {
      const install = freshConsumerInstall(version, root);
      const manifestPath = path.join(install.packageRoot, 'package.json');
      if (!fs.existsSync(manifestPath)) {
        results.push({
          id: 'consumer',
          ok: false,
          detail: `a fresh \`npm install -g ${packageName}@${version}\` produced no package at ${install.packageRoot}`
            + (install.installError ? `: ${install.installError.split('\n')[0]}` : ''),
        });
      } else {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const cliEntry = path.join(install.packageRoot, 'dist/transports/cli/cli.js');
        const reported = String(run(process.execPath, [cliEntry, '--version'], { cwd: install.packageRoot, env: install.env })).trim();
        const shippedEntries = [...binTargets(install.packageRoot), ...hookCommands(install.packageRoot)];
        const absent = shippedEntries.filter((entry) => !fs.existsSync(path.join(install.packageRoot, entry)));
        results.push({
          id: 'consumer',
          ok: manifest.version === version && reported === version && absent.length === 0,
          detail: absent.length > 0
            ? `the published tarball is missing ${absent.join(', ')}`
            : `a fresh registry install reports ${reported} from a package declaring ${manifest.version}, with all ${shippedEntries.length} shipped entry points present`,
          fix: 'The published tarball is not what this tree builds — compare `npm pack` output against the published files.',
        });

        // The released artifact's own doctor, over the tree just installed
        // from the registry, and never against the real database.
        const doctorRun = spawnSync(process.execPath, [cliEntry, 'doctor', '--json'], {
          cwd: install.packageRoot,
          encoding: 'utf8',
          timeout: npmTimeoutMs,
          env: isolatedDataEnv({ ...process.env }, path.join(root, 'doctor-data')),
        });
        const checks = parseDoctorChecks(doctorRun.stdout);
        results.push(checks
          ? { id: 'artifact-doctor', ...evaluateDoctor(checks) }
          : {
            id: 'artifact-doctor',
            ok: false,
            detail: `the released doctor did not produce readable JSON (exit=${doctorRun.status}): ${String(doctorRun.stderr).slice(0, 300)}`,
          });
      }

      const surfaces = [shellSurface(version)].filter(Boolean);
      results.push({ id: 'machine-surfaces', ...evaluateSurfaces(surfaces, version) });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const verdict = formatVerdict(results);
  console.log('\npost-release verdict');
  for (const line of verdict.lines) console.log(line);
  console.log('\nnot checked here:');
  console.log('  - Each host\'s plugin cache beyond what the doctor above reports — `memesh doctor` run on that host is the owner-side check.');
  console.log('  - Nothing on this machine was changed: every fix above is printed, never run.');
  console.log(`\n${verdict.ok ? 'PASS' : 'FAIL'} — post-release check for ${version}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
