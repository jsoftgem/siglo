import { wrapParam } from '../../../context';
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
        const context = Context.createContext(chain.$chainId, stackId);
        if (isFunction(chain.onskip)) {
            try {
                const wrappedParam = (param && (param as any).raw !== undefined) ? param : wrapParam(param);
                const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
                const result = chain.onskip(actionParam);
                if (result instanceof Promise) {
                    result.then((fallbackProps: any) => {
                        if (fallbackProps !== undefined && propertyToContext) {
                            propertyToContext(context, fallbackProps);
                        }
                        resolve(wrapParam(context.getData()));
                    }).catch((err: any) => {
                        reject(err);
                    });
                } else {
                    if (result !== undefined && propertyToContext) {
                        propertyToContext(context, result);
                    }
                    resolve(wrapParam(context.getData()));
                }
            } catch (err) {
                reject(err);
            }
        } else {
            resolve(context.getData());
        }
    }
/* c8 ignore next */
}
