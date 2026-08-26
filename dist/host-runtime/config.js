import fs from 'node:fs';
const MAX_HOST_CONFIG_FILE_BYTES = 64 * 1024;
const MAX_ROUTER_TOKEN_FILE_BYTES = 8 * 1024;
export function readHostConfig() {
    const flag = process.argv.indexOf('--config');
    const configuredPath = flag >= 0 ? process.argv[flag + 1] : process.env.MEMESH_HOST_CONFIG;
    if (!configuredPath)
        throw new Error('A host config file is required via --config or MEMESH_HOST_CONFIG.');
    const value = JSON.parse(readOwnerPrivateFile(configuredPath, 'host config', MAX_HOST_CONFIG_FILE_BYTES));
    if (!isRecord(value))
        throw new Error('The host config must contain one JSON object.');
    return value;
}
export function readTokenFile(tokenFile) {
    const file = requiredString(tokenFile, 'token_file');
    return requiredString(readOwnerPrivateFile(file, 'router token file', MAX_ROUTER_TOKEN_FILE_BYTES).trim(), 'router token');
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
function readOwnerPrivateFile(file, label, maxBytes) {
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error(`This platform cannot safely reject a symlink ${label}.`);
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile())
            throw new Error(`The ${label} must be an owner-private regular file.`);
        assertOwnerPrivate(stat, label);
        if (stat.size > maxBytes)
            throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);
        const content = Buffer.allocUnsafe(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < content.length) {
            const chunkBytes = fs.readSync(descriptor, content, bytesRead, content.length - bytesRead, null);
            if (chunkBytes === 0)
                break;
            bytesRead += chunkBytes;
        }
        if (bytesRead > maxBytes)
            throw new Error(`The ${label} exceeds its ${maxBytes}-byte limit.`);
        return content.subarray(0, bytesRead).toString('utf8');
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function assertOwnerPrivate(stat, label) {
    if ((stat.mode & 0o077) !== 0)
        throw new Error(`The ${label} must be owner-private.`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`The ${label} must be owned by the current user.`);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map