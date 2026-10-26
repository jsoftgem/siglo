"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogger = void 0;
const getLogger = (config, props) => {
    let logMonitor = () => false;
    if (props.logMonitor) {
        if (props.logMonitor instanceof Function) {
            logMonitor = props.logMonitor;
        }
        else {
            throw new Error('logMonitor must be a Function');
        }
    }
    config.logMonitor = logMonitor;
};
exports.getLogger = getLogger;
//# sourceMappingURL=getLogger.js.map