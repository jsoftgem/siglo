import { LogEntry } from './Log';

export const logError = (
    createLog: (source: string, message?: string, error?: any) => LogEntry,
    chain: string,
    error: any
): LogEntry => {
    return createLog(chain, error?.message, error);
};
