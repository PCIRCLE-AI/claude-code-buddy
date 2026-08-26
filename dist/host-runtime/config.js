import fs from 'node:fs';
export function readHostConfig() {
    const flag = process.argv.indexOf('--config');
    const configuredPath = flag >= 0 ? process.argv[flag + 1] : process.env.MEMESH_HOST_CONFIG;
    if (!configuredPath)
        throw new Error('A host config file is required via --config or MEMESH_HOST_CONFIG.');
    const stat = fs.statSync(configuredPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new Error('The host config must be an owner-private regular file.');
    }
    const value = JSON.parse(fs.readFileSync(configuredPath, 'utf8'));
    if (!isRecord(value))
        throw new Error('The host config must contain one JSON object.');
    return value;
}
export function readTokenFile(tokenFile) {
    const file = requiredString(tokenFile, 'token_file');
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new Error('The router token file must be owner-private.');
    }
    return requiredString(fs.readFileSync(file, 'utf8').trim(), 'router token');
}
export function requiredString(value, field) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096) {
        throw new Error(`${field} must be a bounded non-empty string.`);
    }
    return value;
}
export function optionalStringArray(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${field} must be an array.`);
    return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map