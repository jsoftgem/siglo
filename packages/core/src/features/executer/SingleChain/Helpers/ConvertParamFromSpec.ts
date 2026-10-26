export default class ConvertParamFromSpec {
    getParam: () => Record<string, any>;

    constructor(param: Record<string, any>, chainInstance: any) {
        let newParam = param;
        if (chainInstance.isStrict) {
            newParam = {};
            if (chainInstance.specs) {
                chainInstance.specs.forEach((spec: any) => {
                    newParam[spec.field] = param[spec.field];
                });
            }
        }
        this.getParam = () => newParam;
    }
}
