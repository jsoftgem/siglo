import { AsyncLocalStorage } from 'node:async_hooks';
import { DuplicateEventException } from '../executer/exceptions';
const held = new Map<string, symbol>();
const scope = new AsyncLocalStorage<Map<string, symbol>>();
/** Local equivalent of the storage adapter's session lock, reentrant for compensation. */
export async function withLocalWorkflowLock<T>(stackId: string, action: () => Promise<T>): Promise<T> {
    if (held.has(stackId) && scope.getStore()?.get(stackId) === held.get(stackId)) return action();
    if (held.has(stackId)) throw new DuplicateEventException(stackId);
    const owner = Symbol(stackId);
    held.set(stackId, owner);
    try { return await scope.run(new Map([...(scope.getStore() ?? []), [stackId, owner]]), action); }
    finally { held.delete(stackId); }
}
