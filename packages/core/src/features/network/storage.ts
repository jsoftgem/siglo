import { AsyncLocalStorage } from 'node:async_hooks';
import { ActiveNetworkPolicyContext } from './types';

export const networkPolicyStorage = new AsyncLocalStorage<ActiveNetworkPolicyContext>();
