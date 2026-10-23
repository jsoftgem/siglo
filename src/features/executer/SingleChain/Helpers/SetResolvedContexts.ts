export default class SetResolvedContexts {
    constructor(resolvedContext: Record<string, any>, context: any) {
        if (resolvedContext) {
            for (const field in resolvedContext) {
                if (Object.prototype.hasOwnProperty.call(resolvedContext, field)) {
                    const fieldData = resolvedContext[field];
                    context.set(field, fieldData);
                }
            }
        }
    }
}
