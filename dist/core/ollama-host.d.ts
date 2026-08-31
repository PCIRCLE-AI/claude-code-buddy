export declare const UNSAFE_OLLAMA_HOST_ERROR = "Ollama host must be loopback (localhost / 127.0.0.1 / ::1). For non-local Ollama, set the OLLAMA_HOST environment variable on the server.";
export declare class UnsafeOllamaHostError extends Error {
    constructor();
}
export declare function resolveOllamaHost(configuredHost?: string, operatorHost?: string | undefined): string;
//# sourceMappingURL=ollama-host.d.ts.map