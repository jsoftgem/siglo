export interface LogEntry {
    source: string;
    message?: string;
    error?: any;
}
export declare const createLog: (source: string, message?: string, error?: any) => LogEntry;
//# sourceMappingURL=Log.d.ts.map