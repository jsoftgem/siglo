export class Translator {
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

    runTranslate(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            new this.SpecFailedException(
                () => {
                    const { translator } = this.specData;
                    if (translator) {
                        const contextData = this.context.getData();
                        if (contextData[this.field]) {
                            translator(contextData[this.field](), this.context)
                                .then(() => {
                                    resolve();
                                })
                                .catch((error: any) => {
                                    reject({ field: this.field, error });
                                });
                        } else {
                            resolve();
                        }
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
