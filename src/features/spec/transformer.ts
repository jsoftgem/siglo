export class Transformer {
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

    runTransform(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            new this.SpecFailedException(() => {
                const { transformer } = this.specData;
                if (transformer) {
                    const contextData = this.context.getData();
                    if (contextData[this.field]) {
                        transformer(contextData[this.field]())
                            .then((newValue: any) => {
                                this.context.set(this.field, newValue);
                                resolve();
                            })
                            .catch((error: any) => { reject({ field: this.field, error }); });
                    } else {
                        resolve();
                    }
                } else {
                    resolve();
                }
            }, this.field, reject);
        });
    }
/* c8 ignore next */
}
