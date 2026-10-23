export interface SpecFailedError {
    field: string;
    error: any;
}
export declare class SpecFailedException {
    constructor(procedure: () => void, field: string, reject?: (reason: SpecFailedError) => void);
}
//# sourceMappingURL=SpecFailedException.d.ts.map