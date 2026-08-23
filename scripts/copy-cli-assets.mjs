import fs from 'fs';
import path from 'path';

const sourceDir = path.resolve('src/cli/assets');
const targetDir = path.resolve('dist/cli/assets');

fs.mkdirSync(targetDir, { recursive: true });

const entries = fs.readdirSync(sourceDir);
// A build step that copies nothing and exits 0 is indistinguishable from one
// that worked. `src/cli/assets` is not optional — the CLI reads what lands in
// `dist/cli/assets` at runtime — so an empty source directory means a rename
// or a bad path, and the packaged CLI would ship without its assets and say
// nothing until a user hit the missing file.
if (entries.length === 0) {
  throw new Error(`copy-cli-assets: ${sourceDir} is empty — nothing to copy`);
}

for (const entry of entries) {
  fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
}
console.log(`  Copied ${entries.length} CLI asset(s) to dist/cli/assets`);
