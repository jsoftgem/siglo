export const Status = {
    FULFILLED: 'fulfilled',
    REJECTED: 'rejected',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    RUNNING: 'running',
    WAITING: 'waiting',
    PENDING: 'pending',
    RESUMED: 'resumed',
    EXPIRED: 'expired',
    CLAIMED: 'claimed',
    IN_PROGRESS: 'in-progress',
} as const;

export type Status = (typeof Status)[keyof typeof Status];

export const FULFILLED = Status.FULFILLED;
export const REJECTED = Status.REJECTED;
export const COMPLETED = Status.COMPLETED;
export const FAILED = Status.FAILED;
export const CANCELLED = Status.CANCELLED;
export const RUNNING = Status.RUNNING;
export const WAITING = Status.WAITING;
export const PENDING = Status.PENDING;
export const RESUMED = Status.RESUMED;
export const EXPIRED = Status.EXPIRED;
export const CLAIMED = Status.CLAIMED;
export const IN_PROGRESS = Status.IN_PROGRESS;

const STATUS_SET = new Set<string>(Object.values(Status));

export const isStatus = (value: unknown): value is Status => {
    return typeof value === 'string' && STATUS_SET.has(value);
};
