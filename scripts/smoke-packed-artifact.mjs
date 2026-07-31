import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binTargets, hookCommands } from './lib/executable-targets.mjs';

const repoRoot = process.cwd();
const smokeDir = path.join(repoRoot, 'tmp', 'pack-smoke');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCacheDir = process.env.MEMESH_NPM_CACHE ?? path.join(os.tmpdir(), 'memesh-npm-cache');

fs.rmSync(smokeDir, { recursive: true, force: true });
fs.mkdirSync(smokeDir, { recursive: true });

const packJson = execFileSync(
  npmCommand,
  ['pack', '--json', '--pack-destination', smokeDir],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir,
    },
  }
);

const [{ filename }] = JSON.parse(packJson);
const tarballPath = path.join(smokeDir, filename);
const extractDir = path.join(smokeDir, 'extract');

fs.mkdirSync(extractDir, { recursive: true });

// Use platform-aware tar extraction.
// Windows 10+ (required by Node 20+) ships tar.exe, but locate it
// explicitly via ComSpec fallback to handle PATH edge cases.
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
try {
  execFileSync(tarCommand, ['-xf', tarballPath, '-C', extractDir], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(
      `Error: '${tarCommand}' not found. ` +
      'Install tar or upgrade to Windows 10 1803+ (which bundles tar.exe).'
    );
    process.exit(1);
  }
  throw err;
}

const packageDir = path.join(extractDir, 'package');

const requiredFiles = [
  // Core
  'package.json',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  // Dist — core engine
  'dist/index.js',
  'dist/db.js',
  'dist/knowledge-graph.js',
  'dist/core/operations.js',
  'dist/core/types.js',
  'dist/core/config.js',
  'dist/core/scoring.js',
  'dist/core/failure-analyzer.js',
  'dist/core/lesson-engine.js',
  'dist/core/consolidator.js',
  'dist/core/serializer.js',
  'dist/core/patterns.js',
  'dist/core/embedder.js',
  // Dist — transports
  'dist/transports/schemas.js',
  'dist/mcp/launcher.js',
  'dist/mcp/server.js',
  'dist/transports/mcp/handlers.js',
  'dist/transports/http/server.js',
  'dist/transports/cli/cli.js',
  // Dist — dashboard assets
  'dist/cli/view.js',
  'dist/cli/assets/d3.v7.min.js',
  // Hook support: hooks cannot import from dist/, so these are the whole of
  // their dependency surface. Missing, every hook throws on first require.
  // The hooks themselves are not listed here — they are derived from
  // hooks/hooks.json below, so adding one cannot silently go unchecked.
  'scripts/hooks/_shared.js',
  'scripts/hooks/_generated/core-paths.js',
  'scripts/hooks/_generated/fts-index.js',
  // Skills (2)
  'skills/memesh/SKILL.md',
  'skills/memesh-review/SKILL.md',
  // Dashboard build
  'dashboard/dist/index.html',
];

for (const relativePath of requiredFiles) {
  assert.ok(
    fs.existsSync(path.join(packageDir, relativePath)),
    `Missing packaged file: ${relativePath}`
  );
}

// Every hook the plugin manifest can invoke, and every command package.json
// declares, has to be in the tarball AND be runnable. Both lists are derived
// from their manifests (see scripts/lib/executable-targets.mjs) because both
// hand-written copies had drifted.
//
// Present-but-not-executable is the failure this checks for beyond existence:
// Claude Code exec()s hook commands directly, so a hook packed without its +x
// bit is a silent total dropout — the tarball looks complete and the hook
// never runs.
const declaredExecutables = [
  ...binTargets(packageDir).map((p) => ({ relativePath: p, kind: 'bin (package.json)' })),
  ...hookCommands(packageDir).map((p) => ({ relativePath: p, kind: 'hook (hooks/hooks.json)' })),
];

for (const { relativePath, kind } of declaredExecutables) {
  const full = path.join(packageDir, relativePath);
  assert.ok(fs.existsSync(full), `Missing packaged ${kind}: ${relativePath}`);

  if (process.platform !== 'win32') {
    assert.ok(
      fs.statSync(full).mode & 0o111,
      `Packaged ${kind} is not executable: ${relativePath} — it would be present but unrunnable`
    );
  }
}

const packagedJson = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);
assert.equal(packagedJson.name, '@pcircle/memesh');
assert.equal(packagedJson.version, JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version);

execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import * as pkg from ${JSON.stringify(path.join(packageDir, 'dist', 'index.js'))};
if (typeof pkg.openDatabase !== 'function') {
  throw new Error('Packaged module missing openDatabase export');
}
if (typeof pkg.KnowledgeGraph !== 'function') {
  throw new Error('Packaged module missing KnowledgeGraph export');
}
`,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  }
);

fs.rmSync(smokeDir, { recursive: true, force: true });

// Say something on success. A check that prints nothing when it passes is
// indistinguishable from one that did not run — the exact failure mode this
// repo has spent several releases removing from its own code.
console.log('✅ Packaged artifact smoke test passed — tarball packs, installs, and exports openDatabase + KnowledgeGraph');
