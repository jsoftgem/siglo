"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollectPromiseResult = exports.batch = exports.batchIn = exports.generateUUID = void 0;
exports.isValidJson = isValidJson;
const generateUUID = () => {
    let d = new Date().getTime();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
};
exports.generateUUID = generateUUID;
const batchIn = (object, next, done) => {
    const keys = Object.keys(object);
    batchForObject(keys, object, next, done);
};
exports.batchIn = batchIn;
function batchForObject(keys, object, next, done, index = 0) {
    if (index < keys.length) {
        const value = object[keys[index]];
        next(value, () => {
            batchForObject(keys, object, next, done, ++index);
        });
    }
    else {
        done();
    }
}
const batch = (array, next, done, index = 0) => {
    if (index < array.length) {
        const value = array[index];
        next(value, () => {
            (0, exports.batch)(array, next, done, ++index);
        });
    }
    else {
        done();
    }
};
exports.batch = batch;
function isValidJson(json) {
    try {
        JSON.parse(json);
        return true;
    }
    catch {
        return false;
    }
}
class CollectPromiseResult {
    promises;
    constructor(promises) {
        this.promises = [...promises];
    }
    collect(callback, results = []) {
        if (this.promises.length > 0) {
            const promise = this.promises.shift();
            if (promise) {
                promise
                    .then(data => {
                    results.push({ success: true, data });
                    new CollectPromiseResult(this.promises).collect(callback, results);
                })
                    .catch(error => {
                    results.push({ failed: true, error });
                    new CollectPromiseResult(this.promises).collect(callback, results);
                });
            }
        }
        else {
            const error = results.filter(result => result.failed).map(result => result.error);
            const success = results.filter(result => result.success).map(result => result.data);
            callback({
                error,
                success
            });
        }
    }
}
exports.CollectPromiseResult = CollectPromiseResult;
//# sourceMappingURL=Util.js.map