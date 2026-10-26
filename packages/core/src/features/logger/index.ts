import { createLog, LogEntry } from './Log';
import { logError as _logError } from './error';
import { logInfo as _logInfo } from './info';
import { getLogMonitor } from '../storage';

export const logError = (chain: string, error: any): void => {
    getLogMonitor()(_logError(createLog, chain, error));
};

export const logInfo = (chain: string, message?: any): void => {
    getLogMonitor()(_logInfo(createLog, chain, message));
};

export { createLog, LogEntry };
