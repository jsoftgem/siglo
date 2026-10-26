import { LogEntry } from './Log';

export const logInfo = (
    createLog: (source: string, message?: string, error?: any) => LogEntry,
    chain: string,
    message?: any
): LogEntry => {
    return createLog(chain, message);
};
