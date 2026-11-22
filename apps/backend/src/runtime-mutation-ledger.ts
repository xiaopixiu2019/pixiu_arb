import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { RequestNotDispatchedError } from './authenticated-scheduler.js';
import { GateApiError, type PortfolioOperationsCrossExGateway, type TradingCrossExGateway } from './crossex-client.js';
import { DEFAULT_CREDENTIAL_PROFILE, type GateCredentials } from './credential-vault.js';
import { readActiveCredentialProfile } from './repositories.js';
import { Decimal } from 'decimal.js';

type Mutation = { kind: 'leverage'; symbol: string; leverage: string }
  | { kind: 'transfer'; coin: string; amount: string; from: string; to: string; text: string; generatedCorrelation?: boolean };

/** Non-order writes need durable uncertainty too; the order ledger handles submits/cancels. */
export async function trackRuntimeMutation<T>(
  db: Database.Database, mutation: Mutation, work: () => Promise<T>,
  credentials?: GateCredentials,
): Promise<T> {
  const id = randomUUID();
  const identity = { ...mutation, profileId: readActiveCredentialProfile(db) ?? DEFAULT_CREDENTIAL_PROFILE, operationId: id,
    credentialIdentity: credentials ? credentialIdentity(credentials) : null };
  db.prepare('INSERT INTO audit_events (id,created_at,type,correlation_id,payload_json) VALUES (?,?,?,?,?)')
    .run(id, new Date().toISOString(), 'runtime_mutation_pending', id, JSON.stringify(identity));
  const settle = (outcome: 'acknowledged' | 'not_dispatched' | 'rejected', remoteId?: string) => {
    db.prepare("UPDATE audit_events SET type='runtime_mutation_settled',payload_json=? WHERE id=? AND type='runtime_mutation_pending'")
      .run(JSON.stringify({ ...identity, outcome, remoteId, settledAt: new Date().toISOString() }), id);
  };
  try {
    const result = await work();
    const remoteId = result && typeof result === 'object' && 'tx_id' in result && typeof result.tx_id === 'string'
      ? result.tx_id : undefined;
    settle('acknowledged', remoteId); return result;
  } catch (error) {
    if (error instanceof RequestNotDispatchedError) settle('not_dispatched');
    else if (error instanceof GateApiError && error.statusCode === 400
      && ['INVALID_PARAM_VALUE', 'INVALID_ARGUMENT'].includes(error.label)) settle('rejected');
    throw error;
  }
}

export function unresolvedRuntimeMutations(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS count FROM audit_events WHERE type='runtime_mutation_pending'")
    .get() as { count: number }).count;
}

function credentialIdentity(credentials: GateCredentials): string {
  return createHash('sha256').update(JSON.stringify([credentials.apiKey, credentials.apiSecret])).digest('hex');
}

/** Bounded reads only. Empty history never proves that a transfer was rejected. */
export async function reconcileRuntimeMutations(
  db: Database.Database,
  gateway: Partial<TradingCrossExGateway & PortfolioOperationsCrossExGateway>,
  credentials: GateCredentials,
  signal: AbortSignal,
): Promise<void> {
  const profileId = readActiveCredentialProfile(db) ?? DEFAULT_CREDENTIAL_PROFILE;
  const rows = db.prepare("SELECT id,created_at,payload_json FROM audit_events WHERE type='runtime_mutation_pending' ORDER BY created_at LIMIT 16")
    .all() as { id: string; created_at: string; payload_json: string }[];
  for (const row of rows) {
    signal.throwIfAborted();
    const identity = JSON.parse(row.payload_json) as Mutation & { profileId: string; operationId: string; credentialIdentity: string };
    if (identity.operationId !== row.id || identity.profileId !== profileId
      || identity.credentialIdentity !== credentialIdentity(credentials)) throw new Error('deployment_mutation_identity_unverified');
    let evidence: Record<string, unknown> | undefined;
    if (identity.kind === 'leverage' && gateway.queryLeverages) {
      const values = await gateway.queryLeverages(credentials, [identity.symbol]);
      if (values[identity.symbol] && new Decimal(values[identity.symbol]!).eq(identity.leverage)) {
        evidence = { outcome: 'current_setting_verified', symbol: identity.symbol, leverage: values[identity.symbol] };
      }
    } else if (identity.kind === 'transfer' && identity.generatedCorrelation === true && gateway.queryTransfers) {
      const from = Math.floor(Date.parse(row.created_at) / 1000) - 60;
      const values = await gateway.queryTransfers(credentials, { coin: identity.coin, from, page: 1, limit: 100 }, signal);
      const matches = values.filter(value => value.text === identity.text && value.coin === identity.coin
        && value.from_account_type === identity.from && value.to_account_type === identity.to
        && new Decimal(value.amount).eq(identity.amount));
      if (matches.length === 1) evidence = { outcome: 'remote_identity_verified', remoteId: matches[0]!.id, status: matches[0]!.status };
    }
    signal.throwIfAborted();
    if ((readActiveCredentialProfile(db) ?? DEFAULT_CREDENTIAL_PROFILE) !== profileId) throw new Error('deployment_controls_changed');
    if (!evidence) continue;
    db.prepare("UPDATE audit_events SET type='runtime_mutation_settled',payload_json=? WHERE id=? AND type='runtime_mutation_pending' AND payload_json=?")
      .run(JSON.stringify({ ...identity, ...evidence, settledAt: new Date().toISOString() }), row.id, row.payload_json);
  }
}
