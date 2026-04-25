import fs from 'fs';
import path from 'path';

const targets = [
  'dist/mcp/server.js',
  'dist/cli/view.js',
  'scripts/hooks/session-start.js',
  'scripts/hooks/post-commit.js',
  'scripts/hooks/pre-compact.js',
  'scripts/hooks/pre-edit-recall.js',
  'scripts/hooks/session-summary.js',
];

for (const relativePath of targets) {
  const absolutePath = path.resolve(relativePath);
  if (!fs.existsSync(absolutePath)) continue;

  try {
    fs.chmodSync(absolutePath, 0o755);
  } catch {
    // Windows ignores POSIX executable bits; keep build portable.
  }
}
