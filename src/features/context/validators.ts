const VALIDATORS = '$$$validators';

export class Validators {
    private readonly chainId: string;
    private readonly getChainContext: (chainId: string, field: string) => any;
    private CollectPromiseResult: any;

    constructor(
        chainId: string,
        getChainContext: (chainId: string, field: string) => any,
        CollectPromiseResult?: any
    ) {
        this.chainId = chainId;
        this.getChainContext = getChainContext;
        this.CollectPromiseResult = CollectPromiseResult;
    }

    addSpec(fieldSpec: any, setChainContextValue: (name: string, value: any) => void): void {
        const oldValidators = this.getChainContext(this.chainId, VALIDATORS);
        const validators = Object.assign([], [...(oldValidators ? oldValidators() : []), fieldSpec]);
        setChainContextValue(VALIDATORS, validators);
    }

    runValidations(context: any): Promise<void> {
        const rawValidators = this.getChainContext(this.chainId, VALIDATORS);
        const _validators = rawValidators ? rawValidators() : [];
        const validators = _validators.map((validator: any) => {
            if (validator.actions && validator.actions.includes('schema')) {
                return validator.runSchema(context);
            }
            return validator.runValidation(context);
        });
        return new Promise<void>((resolve, reject) => {
            new this.CollectPromiseResult(validators).collect((result: any) => {
                if (result.error && result.error.length > 0) {
                    reject(result.error);
                } else {
                    resolve();
                }
            });
        });
    }

    runSpecs(context: any): Promise<void> {
        const rawValidators = this.getChainContext(this.chainId, VALIDATORS);
        const _validators = rawValidators ? rawValidators() : [];
        const validators = _validators.map((validator: any) => {
            const promises = validator.actions.map((action: string) => {
                switch (action) {
                    case 'require':
                        return validator.runRequireValidation(context);
                    case 'validate':
                        return validator.runValidation(context);
                    case 'default':
                        return validator.runDefault(context);
                    case 'transform':
                        return validator.runTransform(context);
                    case 'translate':
                        return validator.runTranslate(context);
                    case 'schema':
                        return validator.runSchema(context);
                    default:
                        return Promise.resolve();
                }
            });
            return Promise.all(promises);
        });
        return new Promise<void>((resolve, reject) => {
            new this.CollectPromiseResult(validators).collect((result: any) => {
                if (result.error && result.error.length > 0) {
                    reject(result.error);
                } else {
                    resolve();
                }
            });
        });
    }
/* c8 ignore next */
}
