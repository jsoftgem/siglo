export default class AddInitialParam {
    constructor(initialParam: Record<string, any>, context: any) {
        Object.keys(initialParam).forEach(field => {
            if (field !== '$chainId' && field !== '$$$validators') {
                const val = typeof initialParam[field] === 'function' ? initialParam[field]() : initialParam[field];
                context.set(field, val);
            }
        });
    }
}
