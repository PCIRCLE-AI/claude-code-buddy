import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { memeshDir } from './paths.js';
const SCHEMA_VERSION = 1;
function installFilePath() {
    return path.join(memeshDir(), 'install.json');
}
export function getInstallRecord() {
    const filePath = installFilePath();
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed.install_id === 'string' && parsed.install_id.length > 0) {
                return {
                    install_id: parsed.install_id,
                    created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
                    schema_version: SCHEMA_VERSION,
                };
            }
        }
    }
    catch {
    }
    const record = {
        install_id: randomUUID(),
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
    };
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        try {
            fs.chmodSync(path.dirname(filePath), 0o700);
        }
        catch { }
        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
        try {
            fs.chmodSync(filePath, 0o600);
        }
        catch { }
    }
    catch {
    }
    return record;
}
export function getInstallId() {
    return getInstallRecord().install_id;
}
//# sourceMappingURL=install-id.js.map