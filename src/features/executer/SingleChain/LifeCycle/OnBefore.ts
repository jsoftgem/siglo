import OnSkip from './OnSkip';
import { wrapParam } from '../../../context/proxy';

export default class OnBefore {
    constructor(
        chain: any,
        param: any,
        resolve: (value: any) => void,
        reject: (reason?: any) => void,
        Context: any,
        next: () => void,
        propertyToContextOrStackId?: any,
        stackId?: string
    ) {
        let propertyToContext: ((context: any, chainReturn: any) => void) | undefined;
        let actualStackId = stackId;

        if (typeof propertyToContextOrStackId === 'function') {
            propertyToContext = propertyToContextOrStackId;
        } else if (typeof propertyToContextOrStackId === 'string') {
            actualStackId = propertyToContextOrStackId;
        }

        const handleSkip = () => {
            new OnSkip(chain, param, resolve, reject, Context, propertyToContext, actualStackId);
        };

        try {
            const wrappedParam = (param && (param as any).raw !== undefined) ? param : wrapParam(param);
            const actionParam = chain.isModern && wrappedParam?.raw !== undefined ? wrappedParam.raw : wrappedParam;
            const onbefore = chain.onbefore(actionParam);
            if (onbefore instanceof Promise) {
                onbefore.then((con: any) => {
                    if (con) {
                        next();
                    } else {
                        handleSkip();
                    }
                }).catch((err: any) => {
                    reject(err);
                });
            } else if (onbefore) {
                next();
            } else {
                handleSkip();
            }
        } catch (err) {
            reject(err);
        }
    }
/* c8 ignore next */
}
