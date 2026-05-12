#!/usr/bin/env node
declare const app: import("express-serve-static-core").Express;
export declare function startServer(host?: string, port?: number, opts?: {
    allowRemote?: boolean;
}): ReturnType<typeof app.listen>;
export declare function __setRemoteTokenForTest(value: Buffer | null): void;
export { app };
//# sourceMappingURL=server.d.ts.map