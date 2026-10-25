import { WorkflowVersionMismatchException } from '../executer';
import { StateMigrationFn } from './types';
import { isFunction, isObject } from '../../shared';

export function validateWorkflowVersion(
    expectedVersion: any,
    actualVersion: any,
    migrations?: Record<string, StateMigrationFn> | StateMigrationFn,
    state?: any
): any {
    if (expectedVersion === undefined || actualVersion === undefined || expectedVersion === actualVersion) {
        return state;
    }

    if (isFunction(migrations)) {
        return migrations(actualVersion, expectedVersion, state);
    }

    if (isObject(migrations)) {
        const migrationKey = `${actualVersion}->${expectedVersion}`;
        const migrationFn = migrations[migrationKey];
        if (isFunction(migrationFn)) {
            return migrationFn(actualVersion, expectedVersion, state);
        }
    }

    throw new WorkflowVersionMismatchException(expectedVersion, actualVersion);
}
