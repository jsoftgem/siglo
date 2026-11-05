import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { useStorage, DuplicateEventException } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { signActionToken, PostgresApprovalRevocationStore, PostgresNotificationDispatchStore } from '../dist';
const run = promisify(execFile);
const connectionString = process.env.SIGLO_TEST_POSTGRES_URL;
(connectionString ? describe : describe.skip)('PostgreSQL notification processes', function () {
  this.timeout(30000);
  let pool: Pool;
  let adapter: PostgresStorageAdapter;
  const keys: string[] = [];
  before(async () => {
    pool = new Pool({ connectionString });
    adapter = new PostgresStorageAdapter({ client: pool, recordContextChanges: false });
    await adapter.ensureTables();
    await pool.query('ALTER TABLE siglo_wait_records ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS locked_by TEXT');
    await pool.query('CREATE TABLE IF NOT EXISTS notification_test_effects (request_key TEXT NOT NULL, approved BOOLEAN, event_type TEXT)');
    await new PostgresApprovalRevocationStore(pool).initialize();
  });
  after(async () => {
    for (const key of keys) {
      await pool.query('DELETE FROM notification_test_effects WHERE request_key=$1', [key]);
      await pool.query('DELETE FROM siglo_wait_records WHERE correlation_key=$1', [key]);
      await pool.query('DELETE FROM siglo_approval_revocations WHERE correlation_key=$1', [key]);
      await pool.query('DELETE FROM siglo_checkpoints WHERE stack_id=$1', [key]);
    }
    useStorage(undefined as any);
    await pool.end();
  });
  async function seed(expired = false): Promise<string> {
    const key = `notification-${randomUUID()}`; keys.push(key);
    await adapter.saveCheckpoint({ stackId: key, contexts: {}, metadata: { accumulatedContext: { requestId: key } } } as any);
    await adapter.saveWaitRecord({ correlationKey: key, stackId: key, eventName: 'DONE', status: 'waiting', continuationStepIndex: 1, stepId: 'wait', createdAt: Date.now(), expiresAt: Date.now() + (expired ? -1000 : 60000) });
    return key;
  }
  async function worker(key: string, token: string, mode = 'callback'): Promise<any> {
    const result = await run(process.execPath, ['test/postgres-worker.cjs'], { cwd: process.cwd(), env: { ...process.env, REQUEST_KEY: key, ACTION_TOKEN: token, WORKER_MODE: mode } });
    return JSON.parse(result.stdout);
  }
  it('claims once across independent workers with no shared memory', async () => {
    const key = await seed();
    const token = await signActionToken({ stackId: key, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'test-secret');
    const responses = await Promise.all([worker(key, token), worker(key, token)]);
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
    assert.equal((await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rowCount, 1);
  });
  it('rejects shared revocations in a fresh callback process', async () => {
    const key = await seed();
    await new PostgresApprovalRevocationStore(pool).revoke(key);
    const token = await signActionToken({ stackId: key, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'test-secret');
    assert.equal((await worker(key, token)).status, 409);
    assert.equal((await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rowCount, 0);
  });
  it('rehydrates an expired wait in a fresh scheduler process', async () => {
    const key = await seed(true);
    const result = await worker(key, '', 'timeout');
    assert.ok(result.resumed >= 1);
    assert.equal((await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rowCount, 1);
  });
  it('rejects an expired durable wait even while its bearer token is valid', async () => {
    const key = await seed(true);
    const token = await signActionToken({ stackId: key, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'test-secret');
    assert.equal((await worker(key, token)).status, 410);
    assert.equal((await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rowCount, 0);
  });
  it('recovers the original approval after a process dies immediately after claiming', async () => {
    const key = await seed();
    const token = await signActionToken({ stackId: key, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'test-secret');
    await assert.rejects(worker(key, token, 'crash'), (error: any) => error.code === 73);
    const record = (await pool.query('SELECT * FROM siglo_wait_records WHERE correlation_key=$1', [key])).rows[0];
    assert.equal(record.status, 'RESUMING'); assert.equal(record.resume_payload.approved, true);
    await pool.query("UPDATE siglo_wait_records SET expires_at = NOW() - INTERVAL '1 minute' WHERE correlation_key=$1", [key]);
    assert.ok((await worker(key, '', 'timeout')).resumed >= 1);
    const effects = (await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rows;
    assert.equal(effects.length, 1); assert.equal(effects[0].approved, true); assert.equal(effects[0].event_type, 'DONE');
    assert.equal((await worker(key, token)).status, 409);
  });
  it('serializes compensation and callback execution across processes', async () => {
    const key = await seed();
    const token = await signActionToken({ stackId: key, correlationKey: key, expectedEvent: 'DONE', approved: true, expiresAt: Date.now() + 60000 }, 'test-secret');
    await adapter.withWorkflowLock(key, async () => {
      assert.equal((await worker(key, token)).status, 409);
      await adapter.cancelWorkflow(key);
    });
    assert.equal((await worker(key, token)).status, 409);
    assert.equal((await pool.query('SELECT * FROM notification_test_effects WHERE request_key=$1', [key])).rowCount, 0);
  });
  it('uses a shared approval lock for revocation and acceptance', async () => {
    const key = await seed();
    const a = new PostgresApprovalRevocationStore(pool); const b = new PostgresApprovalRevocationStore(pool);
    await a.withApprovalLock(key, async () => {
      await assert.rejects(b.revoke(key), DuplicateEventException);
      assert.equal(await a.isRevoked(key), false);
    });
    await b.revoke(key); assert.equal(await a.isRevoked(key), true);
  });
  it('persists identical dispatch intents across independent store instances', async () => {
    const key = await seed(); const a = new PostgresNotificationDispatchStore(pool); const b = new PostgresNotificationDispatchStore(pool);
    await a.initialize();
    const first = await a.prepare(key, async () => ({ message: { to: 'a@example.com', content: 'original', idempotencyKey: key } }));
    const second = await b.prepare(key, async () => ({ message: { to: 'a@example.com', content: 'changed' } }));
    assert.deepEqual(second, first);
    await pool.query('DELETE FROM siglo_notification_dispatches WHERE dispatch_key=$1', [key]);
  });

  it('keeps cancellation durable against late checkpoint and wait writes', async () => {
    const key = await seed();
    await adapter.withWorkflowLock(key, async () => { await adapter.cancelWorkflow(key); });
    await adapter.saveWaitRecord({ correlationKey: key, stackId: key, status: 'WAITING', eventName: 'DONE' });
    const checkpoint = (await adapter.getCheckpoint(key))!;
    checkpoint.status = 'waiting'; await adapter.saveCheckpoint(checkpoint);
    assert.equal((await adapter.getWaitRecord(key)).status, 'CANCELLED');
    assert.equal((await adapter.getCheckpoint(key))!.status, 'cancelled');
  });
  it('does not reclaim twice with the same claimant without the workflow lock', async () => {
    const key = await seed();
    await adapter.claimWaitRecord(key, 'same-owner', { eventPayload: { approved: true } });
    await assert.rejects(adapter.claimWaitRecord(key, 'same-owner'), DuplicateEventException);
    const recovered = await adapter.withWorkflowLock(key, () => adapter.claimWaitRecord(key, 'other-owner', { eventPayload: { approved: false } }));
    assert.equal(recovered.resumePayload.approved, true);
  });

});
