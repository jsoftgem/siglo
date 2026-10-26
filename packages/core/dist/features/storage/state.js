"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialState = createInitialState;
function createInitialState() {
    return {
        chains: new Map(),
        contexts: new Map(),
        stacks: new Map(),
        cache: new Map(),
        config: {},
        plugins: {}
    };
}
//# sourceMappingURL=state.js.map