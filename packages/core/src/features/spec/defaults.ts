export class Defaults {
    private field: string;
    private specData: any;
    private context: any;
    private SpecFailedException: any;

    constructor(field: string, specData: any, context: any, SpecFailedException: any) {
        this.field = field;
        this.specData = specData;
        this.context = context;
        this.SpecFailedException = SpecFailedException;
    }

    runDefault(): Promise<void> {
        const { defaultValue } = this.specData;
        return new Promise<void>((resolve, reject) => {
            new this.SpecFailedException(
                () => {
                    try {
                        const currentData = this.context.getData();
                        if (currentData[this.field] === undefined || currentData[this.field]() === undefined) {
                            this.context.set(this.field, defaultValue);
                        }
                        resolve();
                    } catch (err) {
                        reject({ error: err, field: this.field });
                    }
                },
                this.field,
                reject,
            );
        });
    }
    /* c8 ignore next */
}
