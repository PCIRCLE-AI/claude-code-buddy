export declare const UNSAFE_OLLAMA_HOST_ERROR = "Ollama host must be loopback (localhost / 127.0.0.1 / ::1) and a bare origin such as http://localhost:11434 \u2014 no path, query, or credentials. For non-local Ollama, set the OLLAMA_HOST environment variable on the server.";
export declare class UnsafeOllamaHostError extends Error {
    constructor();
}
export declare function resolveOllamaHost(configuredHost?: string, operatorHost?: string | undefined): string;
//# sourceMappingURL=ollama-host.d.ts.map