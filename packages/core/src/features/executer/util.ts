import Context from '../context';
import { generateUUID as defaultGenerateUUID, STACK_ID, NAMESPACE } from '../../shared';

export class Util {
    static convertToContextStructure(
        param: any,
        ContextClass?: any,
        generateUUID?: any,
        stackId?: string,
        namespace?: string,
    ): any {
        let effContext = Context;
        let effUUID = defaultGenerateUUID;
        let effStackId = stackId;
        let effNamespace = namespace;

        if (typeof ContextClass === 'function' && ContextClass.createContext) {
            effContext = ContextClass;
            effUUID = typeof generateUUID === 'function' ? generateUUID : defaultGenerateUUID;
        } else {
            if (typeof ContextClass === 'string') {
                effUUID = () => ContextClass;
            }
            if (typeof generateUUID === 'string') {
                effStackId = generateUUID;
            }
            if (typeof stackId === 'string') {
                effNamespace = stackId;
            }
        }

        if (!(param instanceof effContext)) {
            const newParam = effContext.createContext(effUUID(), effStackId, effNamespace);
            for (const name in param) {
                if (Object.prototype.hasOwnProperty.call(param, name)) {
                    if (typeof param[name] === 'function') {
                        continue;
                    }
                    newParam.set(name, param[name]);
                }
            }
            const data = newParam.getData();
            for (const name in param) {
                if (typeof param[name] === 'function') {
                    data[name] = param[name];
                }
            }
            for (const sym of Object.getOwnPropertySymbols(param)) {
                (data as any)[sym] = (param as any)[sym];
            }
            return data;
        }
        if (effStackId && !(param as any)[STACK_ID]) {
            param.setStackId(effStackId);
        }
        if (effNamespace && !(param as any)[NAMESPACE]) {
            param.setNamespace(effNamespace);
        }
        return param.getData();
    }
    /* c8 ignore next */
}
