"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Configurator = void 0;
const storage_1 = require("../storage");
const getLogger_1 = require("./getLogger");
const getPlugins_1 = require("./getPlugins");
class Configurator {
    static configure(props) {
        const config = {};
        (0, getLogger_1.getLogger)(config, props);
        (0, getPlugins_1.getPlugins)(config, props, (0, storage_1.getPlugins)());
        (0, storage_1.setChainConfig)(config);
    }
}
exports.default = Configurator;
exports.Configurator = Configurator;
//# sourceMappingURL=index.js.map