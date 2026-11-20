import { isFunction } from './TypeGuards';

export type DynamicOption<T, TContext = any> = T | ((ctx: TContext) => T);

export type DurationInput = number | string;
export type DynamicDuration<TContext = any> = DynamicOption<DurationInput, TContext>;

export function resolveDynamic<T, TContext = any>(value: DynamicOption<T, TContext>, ctx: TContext): T {
    return isFunction(value) ? value(ctx) : value;
}

export function parseDuration(duration: DurationInput | null | undefined): number | undefined {
    if (duration === undefined || duration === null) {
        return undefined;
    }
    if (typeof duration === 'number') {
        return Number.isFinite(duration) ? duration : undefined;
    }
    const str = String(duration).trim().toLowerCase();
    if (!str) {
        return undefined;
    }
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
    if (!match) {
        const numeric = Number(str);
        return Number.isFinite(numeric) ? numeric : undefined;
    }
    const val = parseFloat(match[1]);
    const unit = match[2] || 'ms';
    switch (unit) {
        case 'd':
            return val * 24 * 60 * 60 * 1000;
        case 'h':
            return val * 60 * 60 * 1000;
        case 'm':
            return val * 60 * 1000;
        case 's':
            return val * 1000;
        case 'ms':
        default:
            return val;
    }
}
