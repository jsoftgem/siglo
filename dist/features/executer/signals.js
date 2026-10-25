"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.combineAbortSignals = combineAbortSignals;
function combineAbortSignals(signals) {
    const active = signals.filter((s) => !!s && typeof s.addEventListener === 'function');
    if (active.length === 0) {
        return { signal: undefined, cleanup: () => { } };
    }
    if (active.length === 1) {
        return { signal: active[0], cleanup: () => { } };
    }
    /* c8 ignore next 3 */
    if (typeof AbortSignal.any === 'function') {
        return { signal: AbortSignal.any(active), cleanup: () => { } };
    }
    /* c8 ignore start */
    const controller = new AbortController();
    const handlers = [];
    for (const sig of active) {
        if (sig.aborted) {
            controller.abort(sig.reason);
            return { signal: controller.signal, cleanup: () => { } };
        }
        const fn = () => controller.abort(sig.reason);
        sig.addEventListener('abort', fn, { once: true });
        handlers.push({ sig, fn });
    }
    const cleanup = () => {
        for (const { sig, fn } of handlers) {
            sig.removeEventListener('abort', fn);
        }
    };
    return { signal: controller.signal, cleanup };
    /* c8 ignore stop */
}
//# sourceMappingURL=signals.js.map