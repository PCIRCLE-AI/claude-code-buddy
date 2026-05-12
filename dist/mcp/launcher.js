#!/usr/bin/env node
import { createRequire } from 'module';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const _require = createRequire(import.meta.url);
const _dir = dirname(fileURLToPath(import.meta.url));
function hasBinary() {
    try {
        const Db = _require('better-sqlite3');
        new Db(':memory:').close();
        return true;
    }
    catch {
        return false;
    }
}
if (!hasBinary() && !process.env.MEMESH_REBUILD_ATTEMPTED) {
    const cwd = join(_dir, '../..');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
        process.stderr.write('[memesh-mcp] better-sqlite3 binding missing — rebuilding native addon...\n');
        execFileSync(npm, ['rebuild', 'better-sqlite3'], { cwd, stdio: 'pipe' });
        process.stderr.write('[memesh-mcp] Rebuild complete — restarting server.\n');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[memesh-mcp] Rebuild failed (${msg}). Server will likely fail to start.\n`);
    }
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        stdio: 'inherit',
        env: { ...process.env, MEMESH_REBUILD_ATTEMPTED: '1' },
    });
    process.exit(result.status ?? 1);
}
await import('./server.js');
//# sourceMappingURL=launcher.js.map