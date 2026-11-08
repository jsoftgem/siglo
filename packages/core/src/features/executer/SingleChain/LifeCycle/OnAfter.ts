import { toPOJO } from '../../../context';
import { isFunction } from '../../../../shared';

export default class OnAfter {
    constructor(
        chain: any,
        output: any,
        param: any,
        context: any,
        propertyToContext: (context: any, chainReturn: any) => void,
        next: () => void,
        reject: (reason?: any) => void,
    ) {
        if (isFunction(chain.onafter)) {
            try {
                const actionParam = toPOJO(param);
                const actionOutput = toPOJO(output);
                const result = chain.onafter(actionOutput, actionParam);
                if (result instanceof Promise) {
                    result
                        .then((enrichProps: any) => {
                            if (enrichProps !== undefined && propertyToContext) {
                                propertyToContext(context, enrichProps);
                            }
                            next();
                        })
                        .catch((err: any) => {
                            reject(err);
                        });
                } else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    next();
                }
            } catch (err) {
                reject(err);
            }
        } else {
            next();
        }
    }
    /* c8 ignore next */
}
