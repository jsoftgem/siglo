export class Validators {
    private field: string;
    private context: any;
    private specData: any;
    private SpecFailedException: any;

    constructor(field: string, context: any, specData: any, SpecFailedException: any) {
        this.field = field;
        this.context = context;
        this.specData = specData;
        this.SpecFailedException = SpecFailedException;
    }

    runRequireValidation(): Promise<void> {
        const { require, requireMessage } = this.specData;
        const isRequired = require instanceof Function ? require() : require;
        return new Promise<void>((resolve, reject) => {
            new this.SpecFailedException(
                () => {
                    const contextData = this.context.getData();
                    if (isRequired && (!contextData[this.field] || contextData[this.field]() === '')) {
                        reject({
                            field: this.field,
                            error: new Error(requireMessage || `Field ${this.field} is required.`),
                        });
                    } else {
                        resolve();
                    }
                },
                this.field,
                reject,
            );
        });
    }

    runValidation(): Promise<void> {
        const { validator } = this.specData;
        return new Promise<void>((resolve, reject) => {
            new this.SpecFailedException(
                () => {
                    const contextData = this.context.getData();
                    if (validator) {
                        validator(contextData[this.field] ? contextData[this.field]() : undefined)
                            .then(() => {
                                resolve();
                            })
                            .catch((error: any) => {
                                reject({
                                    field: this.field,
                                    error,
                                });
                            });
                    } else {
                        resolve();
                    }
                },
                this.field,
                reject,
            );
        });
    }
    /* c8 ignore next */
}
