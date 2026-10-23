export function combineAbortSignals(signals: (AbortSignal | undefined)[]): { signal?: AbortSignal; cleanup: () => void } {
    const active = signals.filter((s): s is AbortSignal => !!s);
    if (active.length === 0) {
        return { signal: undefined, cleanup: () => {} };
    }
    if (active.length === 1) {
        return { signal: active[0], cleanup: () => {} };
    }
    /* c8 ignore next 3 */
    if (typeof (AbortSignal as any).any === 'function') {
        return { signal: (AbortSignal as any).any(active), cleanup: () => {} };
    }
    /* c8 ignore start */
    const controller = new AbortController();
    const handlers: { sig: AbortSignal; fn: () => void }[] = [];
    for (const sig of active) {
        if (sig.aborted) {
            controller.abort(sig.reason);
            return { signal: controller.signal, cleanup: () => {} };
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
