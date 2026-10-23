export default class AddSpecToContext {
    constructor(specs: any[], context: any) {
        if (specs) {
            specs.forEach(spec => {
                context.addSpec(spec);
            });
        }
    }
}
