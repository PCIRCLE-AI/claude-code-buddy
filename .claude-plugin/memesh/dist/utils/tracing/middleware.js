import { extractTraceContext, createTraceContext, runWithTraceContext, injectTraceContext, } from './TraceContext.js';
export function tracingMiddleware(options = {}) {
    const { enabled = true, samplingRate = 1.0, injectResponseHeaders = true, } = options;
    return (req, res, next) => {
        if (!enabled) {
            next();
            return;
        }
        const shouldSample = Math.random() < samplingRate;
        const extracted = extractTraceContext(req.headers);
        const traceContext = createTraceContext(extracted ?? undefined, shouldSample);
        req.traceContext = traceContext;
        if (injectResponseHeaders && traceContext.sampled) {
            const headers = {};
            injectTraceContext(headers, traceContext);
            for (const [key, value] of Object.entries(headers)) {
                res.setHeader(key, value);
            }
        }
        runWithTraceContext(traceContext, () => {
            next();
        });
    };
}
export function getRequestTraceContext(req) {
    return req.traceContext;
}
export function spanMiddleware(spanName) {
    return (req, res, next) => {
        const parentContext = getRequestTraceContext(req);
        if (!parentContext) {
            next();
            return;
        }
        const childContext = createTraceContext({
            ...parentContext,
            spanId: parentContext.spanId,
        }, parentContext.sampled);
        childContext.baggage = {
            ...childContext.baggage,
            spanName,
        };
        req.traceContext = childContext;
        runWithTraceContext(childContext, () => {
            next();
        });
    };
}
//# sourceMappingURL=middleware.js.map