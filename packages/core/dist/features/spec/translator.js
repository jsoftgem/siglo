"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Translator = void 0;
class Translator {
    field;
    specData;
    context;
    SpecFailedException;
    constructor(field, specData, context, SpecFailedException) {
        this.field = field;
        this.specData = specData;
        this.context = context;
        this.SpecFailedException = SpecFailedException;
    }
    runTranslate() {
        return new Promise((resolve, reject) => {
            new this.SpecFailedException(() => {
                const { translator } = this.specData;
                if (translator) {
                    const contextData = this.context.getData();
                    if (contextData[this.field]) {
                        translator(contextData[this.field](), this.context)
                            .then(() => {
                            resolve();
                        })
                            .catch((error) => { reject({ field: this.field, error }); });
                    }
                    else {
                        resolve();
                    }
                }
                else {
                    resolve();
                }
            }, this.field, reject);
        });
    }
}
exports.Translator = Translator;
//# sourceMappingURL=translator.js.map