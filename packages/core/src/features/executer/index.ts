import { addChainToStack, createExecutionStack, deleteStack } from '../storage';
import { executeAfter, executeBefore } from '../plugins';
import { logError, logInfo } from '../logger';

import { ArrayChain } from './array-chain';
import Context from '../context';
import { Reducer } from './reducer';
import { Runner } from './runner';
import StartChain from './SingleChain/StartChain';
import { Util } from './util';
import { cache } from '../cache';
import { generateUUID } from '../../shared';

export {
    SigloError,
    RivuletError,
    ExecutionErrorMetadata,
    StepTimeoutException,
    FlowTimeoutException,
    CancellationException,
    ValidationException,
    ValidationErrorDetail,
    StorageAdapterException,
    CheckpointConflictException,
    NamespaceMismatchException,
    CheckpointVersionException,
    FieldCollisionException,
    CollisionDetail,
    IdempotencyConflictException,
    CompensationException,
    CompensationErrorDetail,
    WorkflowSuspendedException,
    DuplicateEventException,
    ExpiredWaitException,
    WorkflowVersionMismatchException,
    GraphValidationException,
    normalizeError
} from './exceptions';
export { RetryConfig, RetryPredicate } from './SingleChain/LifeCycle/OnFail';

export class Executer {
    start(param: any, chains: any, options?: any): Promise<any> | undefined {
        return new Runner(
            (c: any) => c,
            generateUUID,
            Context,
            StartChain,
            ArrayChain,
            Reducer,
            Util,
            createExecutionStack,
            addChainToStack,
            deleteStack,
            cache,
            logInfo,
            logError,
            executeAfter,
            executeBefore
        ).start(param, chains, options);
    }
/* c8 ignore next */
}

export { ArrayChain, Reducer, Runner, StartChain, Util };
