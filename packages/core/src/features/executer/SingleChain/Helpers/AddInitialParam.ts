import { STEP_ID, VALIDATORS } from '../../../../shared';
export default class AddInitialParam {
    constructor(initialParam: Record<string, any>, context: any) {
        Object.keys(initialParam).forEach(field => {
            if (field !== STEP_ID && field !== VALIDATORS) {
                const val = typeof initialParam[field] === 'function' ? initialParam[field]() : initialParam[field];
                context.set(field, val);
            }
        });
    }
}
