/** Shared snapshot/live reducer. An explicit step ID must never update sibling waits. */
export function applyWaitEvent<T extends { status: string; stepName?: string }>(
    steps: Record<string, T>,
    event: { type: string; stepId?: string; expiresAt?: unknown; resumeReason?: unknown; timestamp?: number },
): Record<string, T> {
    if (event.type !== 'flow:suspended' && event.type !== 'flow:resumed') return steps;
    const suspended = event.type === 'flow:suspended';
    const next = { ...steps };
    for (const [id, step] of Object.entries(steps)) {
        const matches = event.stepId
            ? id === event.stepId
            : suspended
              ? step.status === 'RUNNING' && /wait/i.test(step.stepName || '')
              : step.status === 'SUSPENDED';
        if (!matches) continue;
        const expiresAt = event.expiresAt;
        next[id] = {
            ...step,
            status: suspended ? 'SUSPENDED' : 'COMPLETED',
            waitState: suspended ? 'waiting' : event.resumeReason === 'timer-expired' ? 'expired' : 'resumed',
            ...(suspended
                ? {
                      waitExpiresAt:
                          typeof expiresAt === 'number' &&
                          Number.isSafeInteger(expiresAt) &&
                          expiresAt >= 0 &&
                          expiresAt <= 8640000000000000
                              ? expiresAt
                              : undefined,
                  }
                : { endTime: event.timestamp }),
        };
    }
    return next;
}
