import Context from '../context';
import { generateUUID as defaultGenerateUUID } from '../../shared/Util';

export class Util {
    static convertToContextStructure(
        param: any,
        ContextClass?: any,
        generateUUID?: any,
        stackId?: string,
        tenantId?: string
    ): any {
        let effContext = Context;
        let effUUID = defaultGenerateUUID;
        let effStackId = stackId;
        let effTenantId = tenantId;

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
                effTenantId = stackId;
            }
        }

        if (!(param instanceof effContext)) {
            const newParam = effContext.createContext(effUUID(), effStackId, effTenantId);
            for (const name in param) {
                if (Object.prototype.hasOwnProperty.call(param, name)) {
                    newParam.set(name, param[name]);
                }
            }
            return newParam.getData();
        }
        if (effStackId && !param.$stackId) {
            param.setStackId(effStackId);
        }
        if (effTenantId && !param.$tenantId) {
            param.setTenantId(effTenantId);
        }
        return param.getData();
    }
/* c8 ignore next */
}
