import { AsyncLocalStorage } from 'node:async_hooks';
import { DuplicateEventException, getStorageAdapter, defaultDurableManager } from 'siglo';
/** Acceptance and revocation must use the same lock implementation on every worker. */
export interface ApprovalRevocationStore {
  revoke(correlationKey: string): Promise<void>;
  isRevoked(correlationKey: string): Promise<boolean>;
  withApprovalLock<T>(correlationKey: string, action: () => Promise<T>): Promise<T>;
}
export class InMemoryApprovalRevocationStore implements ApprovalRevocationStore {
  private revoked = new Set<string>();
  private locks = new Map<string, symbol>();
  private scope = new AsyncLocalStorage<Map<string, symbol>>();
  async withApprovalLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.locks.has(key) && this.scope.getStore()?.get(key) === this.locks.get(key)) return action();
    if (this.locks.has(key)) throw new DuplicateEventException(key);
    const owner = Symbol(key);
    this.locks.set(key, owner);
    try { return await this.scope.run(new Map([...(this.scope.getStore() ?? []), [key, owner]]), action); }
    finally { this.locks.delete(key); }
  }
  async revoke(key: string): Promise<void> { await this.withApprovalLock(key, async () => { this.revoked.add(key); const waiting = defaultDurableManager.getWaiting(key); if (waiting) waiting.status = 'failed'; }); }
  async isRevoked(key: string): Promise<boolean> { return this.revoked.has(key); }
}
let store: ApprovalRevocationStore = new InMemoryApprovalRevocationStore();
export function configureApprovalRevocationStore(value: ApprovalRevocationStore): void { store = value; }
export function getApprovalRevocationStore(): ApprovalRevocationStore { return store; }
interface Connection {
  query(sql: string, values?: any[]): Promise<{ rows: any[] }>;
  release?(error?: Error): void;
}
interface Client extends Connection { connect?(): Promise<Connection | void> }
/** Use a Pool in multi-worker deployments; locks hold a dedicated connection until completion. */
export class PostgresApprovalRevocationStore implements ApprovalRevocationStore {
  private scope = new AsyncLocalStorage<{ key: string; client: Connection; active: boolean }>();
  private directClientBusy = false;
  constructor(private client: Client) {}
  async initialize(): Promise<void> {
    await this.client.query('CREATE TABLE IF NOT EXISTS siglo_approval_revocations (correlation_key TEXT PRIMARY KEY, revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  }
  async withApprovalLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()?.active && this.scope.getStore()?.key === key) return action();
    // pg.Client.connect() is not a pool checkout. Pools expose totalCount.
    const pooled = 'totalCount' in this.client;
    if (!pooled && this.directClientBusy) throw new DuplicateEventException(key);
    if (!pooled) this.directClientBusy = true;
    let connection: Connection | undefined;
    let locked = false;
    try {
      connection = pooled ? await this.client.connect!() as Connection : this.client;
      const result = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`siglo:approval:${key}`]);
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new DuplicateEventException(key);
      const scope = { key, client: connection, active: true };
      try { return await this.scope.run(scope, action); }
      finally { scope.active = false; }
    } finally {
      try { if (locked) await connection!.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`siglo:approval:${key}`]); }
      catch (error) { if (pooled) { connection?.release?.(error as Error); connection = undefined; } throw error; }
      finally { if (pooled) connection?.release?.(); else this.directClientBusy = false; }
    }
  }
  async revoke(correlationKey: string): Promise<void> {
    await this.withApprovalLock(correlationKey, async () => {
      const adapter = getStorageAdapter();
      const record = await adapter?.getWaitRecord?.(correlationKey);
      const cancel = async () => {
        // Cancel recovery first: a crash before the revocation INSERT must fail closed.
        await adapter?.cancelWaitRecord?.(correlationKey);
        await this.scope.getStore()!.client.query('INSERT INTO siglo_approval_revocations (correlation_key) VALUES ($1) ON CONFLICT (correlation_key) DO NOTHING', [correlationKey]);
      };
      if (record && adapter?.withWorkflowLock) await adapter.withWorkflowLock(record.stackId, cancel);
      else await cancel();
    });
  }
  async isRevoked(correlationKey: string): Promise<boolean> {
    const result = await (this.scope.getStore()?.active ? this.scope.getStore()!.client : this.client).query('SELECT correlation_key FROM siglo_approval_revocations WHERE correlation_key = $1', [correlationKey]);
    return result.rows.length > 0;
  }
}
