import { toPOJO } from '../../../context';
import { isFunction } from '../../../../shared';

export default class OnSkip {
    constructor(
        chain: any,
        param: any,
        resolve: (value: any) => void,
        reject: (reason?: any) => void,
        Context: any,
        propertyToContext?: (context: any, chainReturn: any) => void,
        stackId?: string
    ) {
        const context = Context.createContext(chain.$stepId, stackId);
        if (isFunction(chain.onskip)) {
            try {
                const actionParam = toPOJO(param);
                const result = chain.onskip(actionParam);
                if (result instanceof Promise) {
                    result.then((fallbackProps: any) => {
                        if (fallbackProps !== undefined && propertyToContext) {
                            propertyToContext(context, fallbackProps);
                        }
                        resolve(toPOJO(context.getData()));
                    }).catch((err: any) => {
                        reject(err);
                    });
                } else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    resolve(toPOJO(context.getData()));
                }
            } catch (err) {
                reject(err);
            }
        } else {
            resolve(toPOJO(context.getData()));
        }
    }
/* c8 ignore next */
}
