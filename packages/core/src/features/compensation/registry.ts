import { CompensationHandler } from './types';

const globalCompensationRegistry = new Map<string, CompensationHandler>();

/**
 * Registers a named compensation handler globally in the runtime.
 * Decouples compensation execution from local step closures and enables
 * resilient rollback across deployments and process restarts.
 */
export function registerCompensationHandler(name: string, handler: CompensationHandler): void {
    if (!name || typeof name !== 'string') {
        throw new Error('Compensation handler name must be a non-empty string');
    }
    if (typeof handler !== 'function' && (!handler || typeof (handler as any).execute !== 'function')) {
        throw new Error(`Compensation handler for '${name}' must be a function or have an execute method`);
    }
    globalCompensationRegistry.set(name, handler);
}

/**
 * Retrieves a registered named compensation handler.
 */
export function getCompensationHandler(name: string): CompensationHandler | undefined {
    return globalCompensationRegistry.get(name);
}

/**
 * Checks if a named compensation handler is registered.
 */
export function hasCompensationHandler(name: string): boolean {
    return globalCompensationRegistry.has(name);
}

/**
 * Removes a named compensation handler from the registry.
 */
export function unregisterCompensationHandler(name: string): boolean {
    return globalCompensationRegistry.delete(name);
}

/**
 * Clears all registered named compensation handlers.
 */
export function clearCompensationHandlers(): void {
    globalCompensationRegistry.clear();
}
