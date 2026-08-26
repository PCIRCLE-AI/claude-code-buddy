#!/usr/bin/env node
import { type AcpSessionUpdate } from '../host-adapters/acp-client.js';
export declare const ACP_SESSION_UPDATE_MAX_RECORD_BYTES: number;
export declare const ACP_SESSION_UPDATE_MAX_FILE_BYTES: number;
export declare const ACP_SESSION_UPDATE_MAX_RECORDS = 1024;
export interface AcpSessionUpdateSink {
    write: (update: AcpSessionUpdate) => void;
    close: () => void;
}
export declare function createAcpSessionUpdateSink(configuredPath: unknown): AcpSessionUpdateSink | undefined;
//# sourceMappingURL=acp.d.ts.map