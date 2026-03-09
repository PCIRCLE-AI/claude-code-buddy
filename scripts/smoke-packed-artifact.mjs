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
execFileSync('tar', ['-xf', tarballPath, '-C', extractDir], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const packageDir = path.join(extractDir, 'package');

const requiredFiles = [
  'package.json',
  'dist/index.js',
  'dist/mcp/server.js',
  'dist/cli/view.js',
  'dist/cli/assets/d3.v7.min.js',
  'scripts/hooks/session-start.js',
  'scripts/hooks/post-commit.js',
  'plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
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
