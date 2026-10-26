import { Step, flow } from 'fluid-func';
import { PostgresStorageAdapter, PostgresIdempotencyStore } from '@fluid-func/postgres';
import { RedisStorageAdapter, RedisIdempotencyStore, RedisLock } from '@fluid-func/redis';

export interface SaaSUsageInput {
    billingPeriod: string;
    organizationId: string;
    apiRequests: number;
    computeMinutes: number;
    storageGigabytes: number;
}

export interface SaaSInvoiceOutput {
    invoiceId: string;
    organizationId: string;
    billingPeriod: string;
    totalAmount: number;
    status: 'INVOICED';
    namespace: string;
}

/**
 * Mock PostgreSQL Client for demonstration and testing.
 */
export class MockPostgresClient {
    public rows: {
        fluid_checkpoints: any[];
        fluid_context_events: any[];
        fluid_idempotency: any[];
    } = {
        fluid_checkpoints: [],
        fluid_context_events: [],
        fluid_idempotency: []
    };
    public queryLogs: string[] = [];

    async query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
        this.queryLogs.push(sql);

        if (sql.includes('CREATE TABLE')) {
            return { rows: [], rowCount: 0 };
        }

        // Checkpoints
        if (sql.includes('INSERT INTO fluid_checkpoints')) {
            const [stackId, namespace, stateJson] = params;
            const parsedState = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
            const existing = this.rows.fluid_checkpoints.find(r => r.stack_id === stackId);
            if (existing) {
                existing.namespace = namespace;
                existing.state = parsedState;
            } else {
                this.rows.fluid_checkpoints.push({
                    stack_id: stackId,
                    namespace,
                    state: parsedState,
                    created_at: new Date()
                });
            }
            return { rows: [], rowCount: 1 };
        }

        if (sql.includes('SELECT state FROM fluid_checkpoints')) {
            const [stackId] = params;
            const match = this.rows.fluid_checkpoints.find(r => r.stack_id === stackId);
            return { rows: match ? [{ state: match.state }] : [], rowCount: match ? 1 : 0 };
        }

        // Context Events
        if (sql.includes('INSERT INTO fluid_context_events')) {
            const [stackId, stepId, namespace, field, value] = params;
            this.rows.fluid_context_events.push({
                stack_id: stackId,
                step_id: stepId,
                namespace,
                field,
                value,
                created_at: new Date()
            });
            return { rows: [], rowCount: 1 };
        }

        // Idempotency: INSERT ON CONFLICT DO NOTHING
        if (sql.includes('INSERT INTO fluid_idempotency')) {
            const [key, expiresAt] = params;
            const existing = this.rows.fluid_idempotency.find(r => r.key === key);
            if (existing) {
                return { rows: [], rowCount: 0 };
            }
            this.rows.fluid_idempotency.push({
                key,
                status: 'in-progress',
                result: null,
                expires_at: expiresAt
            });
            return { rows: [], rowCount: 1 };
        }

        if (sql.includes('SELECT status, result, expires_at FROM fluid_idempotency')) {
            const [key] = params;
            const match = this.rows.fluid_idempotency.find(r => r.key === key);
            return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
        }

        if (sql.includes('UPDATE fluid_idempotency')) {
            const [resultJson, key] = params;
            const match = this.rows.fluid_idempotency.find(r => r.key === key);
            if (match) {
                match.status = 'completed';
                match.result = resultJson;
            }
            return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
    }
}

/**
 * Mock Redis Client for demonstration and testing.
 */
export class MockRedisClient {
    public store: Map<string, string> = new Map();
    public sets: Map<string, Set<string>> = new Map();

    async get(key: string): Promise<string | null> {
        return this.store.get(key) || null;
    }

    async set(key: string, val: string, ...options: any[]): Promise<'OK' | null> {
        const hasNx = options.some(opt => typeof opt === 'string' && opt.toUpperCase() === 'NX');
        if (hasNx && this.store.has(key)) {
            return null;
        }
        this.store.set(key, val);
        return 'OK';
    }

    async del(key: string): Promise<number> {
        return this.store.delete(key) ? 1 : 0;
    }

    async eval(script: string, numkeys: number, ...args: any[]): Promise<any> {
        const [key, expectedVal] = args;
        if (this.store.get(key) === expectedVal) {
            this.store.delete(key);
            return 1;
        }
        return 0;
    }

    async hset(key: string, field: string, val: string): Promise<number> {
        this.store.set(`${key}:${field}`, val);
        return 1;
    }

    async sadd(key: string, member: string): Promise<number> {
        if (!this.sets.has(key)) this.sets.set(key, new Set());
        const set = this.sets.get(key)!;
        if (set.has(member)) return 0;
        set.add(member);
        return 1;
    }

    async expire(): Promise<number> {
        return 1;
    }
}

/**
 * Use Case 22: Multi-Tenant SaaS Billing & Audit Ledger
 * Adapters demonstrated: @fluid-func/postgres & @fluid-func/redis
 * Features demonstrated:
 * - Scoped multi-tenant billing workflow partitioned by `namespace`
 * - Durable Postgres checkpoints and context event audit stream
 * - Postgres/Redis Idempotency locking preventing duplicate billing charges
 * - RedisLock ensuring single-flight concurrency synchronization
 */
export function createSaaSBillingWorkflow() {
    // Step 1: Calculate Consumption Fees
    const computeUsageFees = Step.create('computeUsageFees', async (param: any) => {
        const { apiRequests, computeMinutes, storageGigabytes } = param;

        const apiFee = (apiRequests / 1000) * 0.10;
        const computeFee = computeMinutes * 0.05;
        const storageFee = storageGigabytes * 0.10;
        const subtotal = Math.round((apiFee + computeFee + storageFee) * 100) / 100;

        return {
            apiFee,
            computeFee,
            storageFee,
            subtotal,
            calculatedAt: Date.now()
        };
    }).modern();

    // Step 2: Apply Tenant Tier Discount & Taxes
    const finalizeInvoice = Step.create('finalizeInvoice', async (param: any) => {
        const { organizationId, billingPeriod, subtotal } = param;
        const namespace = param.$namespace ? param.$namespace() : 'default';

        // 10% discount for enterprise tenants
        const isEnterprise = namespace.includes('enterprise');
        const discount = isEnterprise ? Math.round(subtotal * 0.10 * 100) / 100 : 0;
        const totalAmount = Math.max(0, Math.round((subtotal - discount) * 100) / 100);

        const invoiceId = `INV-${namespace.toUpperCase()}-${billingPeriod}`;

        return {
            invoiceId,
            organizationId,
            billingPeriod,
            subtotal,
            discount,
            totalAmount,
            status: 'INVOICED',
            namespace
        };
    }).modern();

    return flow(computeUsageFees, finalizeInvoice);
}

/**
 * Configures the complete Phase 3 persistence and concurrency infrastructure for SaaS billing.
 */
export function setupSaaSBillingInfrastructure(
    pgClient: MockPostgresClient,
    redisClient: MockRedisClient
) {
    const workflow = createSaaSBillingWorkflow();

    // 1. Postgres Storage Adapter for durable checkpoints & events
    const postgresStorage = new PostgresStorageAdapter({ client: pgClient as any });

    // 2. Postgres Idempotency Store
    const postgresIdempotency = new PostgresIdempotencyStore({ client: pgClient as any, defaultTtlMs: 86400000 });

    // 3. Redis Storage Adapter for fast caching
    const redisStorage = new RedisStorageAdapter({ client: redisClient as any });

    // 4. Redis Idempotency Store
    const redisIdempotency = new RedisIdempotencyStore({ client: redisClient as any, defaultTtlMs: 86400000 });

    // 5. Redis Distributed Lock
    const redisLock = new RedisLock(redisClient as any, 'fluid:lock:');

    return {
        workflow,
        postgresStorage,
        postgresIdempotency,
        redisStorage,
        redisIdempotency,
        redisLock
    };
}
