export interface SpecFailedError {
    field: string;
    error: any;
}

export class SpecFailedException {
    constructor(procedure: () => void, field: string, reject?: (reason: SpecFailedError) => void) {
        try {
            procedure();
        } catch (error: any) {
            if (reject) {
                reject({
                    field,
                    error,
                });
            } else {
                throw new Error('SpecFailedException: ' + error?.message);
            }
        }
    }
    /* c8 ignore next */
}
