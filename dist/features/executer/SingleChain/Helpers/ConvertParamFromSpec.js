"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ConvertParamFromSpec {
    getParam;
    constructor(param, chainInstance) {
        let newParam = param;
        if (chainInstance.isStrict) {
            newParam = {};
            if (chainInstance.specs) {
                chainInstance.specs.forEach((spec) => {
                    newParam[spec.field] = param[spec.field];
                });
            }
        }
        this.getParam = () => newParam;
    }
}
exports.default = ConvertParamFromSpec;
//# sourceMappingURL=ConvertParamFromSpec.js.map