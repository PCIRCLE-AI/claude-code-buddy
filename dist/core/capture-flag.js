export function autoCaptureDecision(envVal, configAutoCapture) {
    if (envVal === 'false')
        return { enabled: false, offSource: 'env' };
    if (envVal === 'true')
        return { enabled: true, offSource: null };
    if (configAutoCapture === false)
        return { enabled: false, offSource: 'config' };
    return { enabled: true, offSource: null };
}
//# sourceMappingURL=capture-flag.js.map