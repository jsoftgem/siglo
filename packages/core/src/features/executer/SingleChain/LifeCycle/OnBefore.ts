import OnSkip from './OnSkip';
import { toPOJO } from '../../../context';
import { isFunction, STACK_ID, STACK_ID_KEY } from '../../../../shared';
import { emitMonitoringEvent } from '../../../events/emitter';

export default class OnBefore {
    constructor(
        chain: any,
        param: any,
        resolve: (value: any) => void,
        reject: (reason?: any) => void,
        Context: any,
        next: () => void,
        propertyToContextOrStackId?: any,
        stackId?: string,
        options?: any,
    ) {
        let propertyToContext: ((context: any, chainReturn: any) => void) | undefined;
        let actualStackId = stackId;

        if (isFunction(propertyToContextOrStackId)) {
            propertyToContext = propertyToContextOrStackId;
        } else if (typeof propertyToContextOrStackId === 'string') {
            actualStackId = propertyToContextOrStackId;
        }

        const resolvedStackId =
            actualStackId ||
            options?.stackId ||
            (typeof param?.$stackId === 'function' ? param.$stackId() : param?.$stackId) ||
            (param && typeof param[STACK_ID] === 'function' ? param[STACK_ID]() : param?.[STACK_ID]) ||
            param?.[STACK_ID_KEY] ||
            '';

        const handleSkip = () => {
            emitMonitoringEvent(options, {
                type: 'step:skipped',
                stackId: resolvedStackId,
                stepId: chain.$stepId || chain.name || '',
                stepName: chain.func || chain.name || '',
                timestamp: Date.now(),
                namespace: options?.namespace,
            });
            new OnSkip(chain, param, resolve, reject, Context, propertyToContext, resolvedStackId);
        };

        try {
            const actionParam = toPOJO(param);
            const onbefore = chain.onbefore(actionParam);
            if (onbefore instanceof Promise) {
                onbefore
                    .then((con: any) => {
                        if (con) {
                            next();
                        } else {
                            handleSkip();
                        }
                    })
                    .catch((err: any) => {
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
