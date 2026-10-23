export interface LogEntry {
    source: string;
    message?: string;
    error?: any;
}

export const createLog = (source: string, message?: string, error?: any): LogEntry => {
    return {
        source,
        message,
        error
    };
};
