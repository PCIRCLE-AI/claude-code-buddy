import fs from 'fs';
import path from 'path';

const sourceDir = path.resolve('src/cli/assets');
const targetDir = path.resolve('dist/cli/assets');

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir)) {
  fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
}
