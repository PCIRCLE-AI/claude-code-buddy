import type { Request, Response, NextFunction } from 'express';
import { type TraceContext } from './TraceContext.js';
export interface TracedRequest extends Request {
    traceContext?: TraceContext;
}
export interface TracingMiddlewareOptions {
    enabled?: boolean;
    samplingRate?: number;
    headerName?: string;
    injectResponseHeaders?: boolean;
}
export declare function tracingMiddleware(options?: TracingMiddlewareOptions): (req: Request, res: Response, next: NextFunction) => void;
export declare function getRequestTraceContext(req: Request): TraceContext | undefined;
export declare function spanMiddleware(spanName: string): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=middleware.d.ts.map