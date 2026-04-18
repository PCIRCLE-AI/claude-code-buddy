import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  'plugin.json',
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
  'dist/core/embedder.js',
  // Dist — transports
  'dist/transports/schemas.js',
  'dist/mcp/server.js',
  'dist/transports/mcp/handlers.js',
  'dist/transports/http/server.js',
  'dist/transports/cli/cli.js',
  // Dist — dashboard assets
  'dist/cli/view.js',
  'dist/cli/assets/d3.v7.min.js',
  // Hooks (4)
  'scripts/hooks/session-start.js',
  'scripts/hooks/post-commit.js',
  'scripts/hooks/session-summary.js',
  'scripts/hooks/pre-compact.js',
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
