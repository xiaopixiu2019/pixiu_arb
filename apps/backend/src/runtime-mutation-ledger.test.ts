import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { trackRuntimeMutation, unresolvedRuntimeMutations, reconcileRuntimeMutations } from './runtime-mutation-ledger.js';
import { GateApiError } from './crossex-client.js';
import { RequestNotDispatchedError } from './authenticated-scheduler.js';
import { runDatabaseMaintenance } from './database-maintenance.js';

const databases: ReturnType<typeof openDatabase>[] = [];
function fixture() { const db = openDatabase(':memory:', resolve('../../migrations')); databases.push(db); return db; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('non-order write responsibility', () => {
  it('retains uncertain transfer responsibility after its promise rejects', async () => {
    const db = fixture();
    await expect(trackRuntimeMutation(db, { kind: 'transfer', text: 'transfer-fixture', coin: 'USDT', amount: '1', from: 'SPOT', to: 'CROSSEX' }, async () => {
      expect(unresolvedRuntimeMutations(db)).toBe(1);
      throw new GateApiError(0, 'REQUEST_TIMEOUT');
    })).rejects.toThrow();
    expect(unresolvedRuntimeMutations(db)).toBe(1);
    db.prepare("UPDATE audit_events SET created_at='2000-01-01T00:00:00Z' WHERE type='runtime_mutation_pending'").run();
    runDatabaseMaintenance(db);
    expect(unresolvedRuntimeMutations(db)).toBe(1);
  });
  it('settles a confirmed receipt or a proven unsent operation', async () => {
    const db = fixture();
    await trackRuntimeMutation(db, { kind: 'leverage', symbol: 'fixture', leverage: '2' }, async () => ({ symbol: 'fixture', leverage: '2' }));
    await expect(trackRuntimeMutation(db, { kind: 'leverage', symbol: 'fixture', leverage: '2' }, async () => {
      throw new RequestNotDispatchedError();
    })).rejects.toThrow();
    expect(unresolvedRuntimeMutations(db)).toBe(0);
  });
  it('does not clear an uncertain transfer from empty or mismatched history', async () => {
    const db = fixture();
    const credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
    await expect(trackRuntimeMutation(db, { kind: 'transfer', text: 'owned', generatedCorrelation: true, coin: 'USDT', amount: '1', from: 'SPOT', to: 'CROSSEX' },
      async () => { throw new GateApiError(0, 'REQUEST_TIMEOUT'); }, credentials)).rejects.toThrow();
    await expect(reconcileRuntimeMutations(db, { queryTransfers: async () => [] },
      { apiKey: 'other-account', apiSecret: 'synthetic' }, AbortSignal.timeout(1000)))
      .rejects.toThrow('deployment_mutation_identity_unverified');
    await reconcileRuntimeMutations(db, { queryTransfers: async () => [] }, credentials, AbortSignal.timeout(1000));
    expect(unresolvedRuntimeMutations(db)).toBe(1);
    const row = { id: 'remote-receipt', text: 'foreign', coin: 'USDT', amount: '1', actual_receive: '1',
      from_account_type: 'SPOT' as const, to_account_type: 'CROSSEX' as const,
      status: 'SUCCESS' as const, fail_reason: '', create_time: Date.now(), update_time: Date.now() };
    await reconcileRuntimeMutations(db, { queryTransfers: async () => [row] }, credentials, AbortSignal.timeout(1000));
    expect(unresolvedRuntimeMutations(db)).toBe(1);
    await reconcileRuntimeMutations(db, { queryTransfers: async () => [{ ...row, text: 'owned' }] }, credentials, AbortSignal.timeout(1000));
    expect(unresolvedRuntimeMutations(db)).toBe(0);
    const saved = db.prepare("SELECT payload_json FROM audit_events WHERE type='runtime_mutation_settled'").get() as { payload_json: string };
    expect(JSON.parse(saved.payload_json)).toMatchObject({ remoteId: 'remote-receipt', outcome: 'remote_identity_verified' });
  });
  it('settles an explicit parameter rejection but preserves ambiguous failures', async () => {
    const db = fixture(), mutation = { kind: 'leverage' as const, symbol: 'fixture', leverage: '2' };
    await expect(trackRuntimeMutation(db, mutation, async () => { throw new GateApiError(400, 'INVALID_PARAM_VALUE'); })).rejects.toThrow();
    expect(unresolvedRuntimeMutations(db)).toBe(0);
    await expect(trackRuntimeMutation(db, mutation, async () => { throw new GateApiError(500, 'INTERNAL'); })).rejects.toThrow();
    expect(unresolvedRuntimeMutations(db)).toBe(1);
  });
});
