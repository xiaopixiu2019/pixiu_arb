import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TradingSession } from './trading-session.js';

export interface ProtectionGrant { accountId: string; profileId: string; revision: number; enabled: boolean; groupIds: string[] }
export interface ProtectionLaunchAuthorization { profileId: string; revision: number; epoch: number }
export type ProtectionState = 'WATCHING' | 'RECONCILING' | 'EXECUTING' | 'BLOCKED' | 'DISABLED';
export interface ProtectionOrder { symbol: string; side: string; quantity: string; reduceOnly: boolean; type: string }
type Permit = { grant: ProtectionGrant; input: ProtectionOrder; strategyId: string; until: number; orderId?: string; validate(exclude?: string): void };

/** A permit is an in-process capability, never an HTTP field or a persisted replay request. */
export class ProtectionAuthority {
  private readonly permits = new WeakMap<object, Permit>();
  private revocationEpoch = 0;
  epoch(): number { return this.revocationEpoch; }
  constructor(private readonly db: Database.Database, private readonly session: TradingSession,
    private readonly profile: () => string | null, private readonly now = Date.now) {
    session.attachProtection(() => this.grant()?.enabled === true, () => this.revoke());
  }
  grant(): ProtectionGrant | null {
    const profileId = this.profile(); if (!profileId) return null;
    const r = this.db.prepare('SELECT * FROM continuous_protection_authority WHERE profile_id=?').get(profileId) as
      { account_key: string; revision: number; enabled: number; groups_json: string } | undefined;
    return r ? { profileId, accountId: r.account_key, revision: r.revision, enabled: r.enabled === 1,
      groupIds: z.array(z.string()).parse(JSON.parse(r.groups_json)) } : null;
  }
  captureLaunchAuthorization(profileId: string): ProtectionLaunchAuthorization {
    if (!this.session.liveTradingEnabled || this.profile() !== profileId) throw new Error('protection_launch_permission_changed');
    return { profileId, revision: this.grant()?.revision ?? 0, epoch: this.epoch() };
  }
  /** Part of task creation, before any actor/order; never called by polling or resume. */
  authorizeLaunchedGroup(accountId: string, groupId: string, expected: ProtectionLaunchAuthorization): void {
    if (!this.db.inTransaction) throw new Error('protection_launch_transaction_required');
    const current = this.captureLaunchAuthorization(expected.profileId), grant = this.grant();
    if (current.revision !== expected.revision || current.epoch !== expected.epoch
      || grant && grant.accountId !== accountId) throw new Error('protection_launch_permission_changed');
    if (grant?.enabled && grant.groupIds.includes(groupId)) return;
    // A fresh launch authorizes this group only; a disabled old scope must stay revoked.
    this.configure(accountId, [...(grant?.enabled ? grant.groupIds : []), groupId], current.revision, true);
  }
  configure(accountId: string, groupIds: string[], revision: number, enabled: boolean): ProtectionGrant {
    const profileId = this.profile(); if (!profileId) throw new Error('protection_account_unavailable');
    const current = this.grant();
    if ((current?.revision ?? 0) !== revision) throw new Error('protection_revision_changed');
    if (enabled && !groupIds.length) throw new Error('protection_scope_empty');
    const groups = [...new Set(z.array(z.string().min(1).max(120)).max(100).parse(groupIds))];
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO continuous_protection_authority VALUES (?,?,?,?,?,?)')
        .run(profileId, accountId, revision + 1, enabled ? 1 : 0, JSON.stringify(groups), new Date(this.now()).toISOString());
      this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?)').run(randomUUID(), new Date(this.now()).toISOString(),
        enabled ? 'continuous_protection_authorized' : 'continuous_protection_revoked', profileId,
        JSON.stringify({ accountId, groupIds: groups, revision: revision + 1 }));
    })();
    return this.grant()!;
  }
  revoke(): void {
    this.revocationEpoch += 1;
    const current = this.grant();
    if (current?.enabled) this.configure(current.accountId, current.groupIds, current.revision, false);
  }
  status(strategyId: string, state: ProtectionState, reason: string | null = null): void {
    const profile = this.profile(); if (!profile) return;
    this.db.prepare('INSERT OR REPLACE INTO continuous_protection_status VALUES (?,?,?,?,?)')
      .run(profile, strategyId, state, reason, this.now());
  }
  statuses(): Array<{ strategyId: string; state: ProtectionState; reason: string | null; checkedAt: number }> {
    return this.db.prepare('SELECT strategy_id AS strategyId,state,reason,checked_at AS checkedAt FROM continuous_protection_status WHERE profile_id=?')
      .all(this.profile() ?? '') as ReturnType<ProtectionAuthority['statuses']>;
  }
  issue(input: ProtectionOrder, strategyId: string, validate: Permit['validate'], until: number): object {
    const grant = this.grant(); if (!grant?.enabled) throw new Error('protection_authority_revoked');
    const token = Object.freeze({}); this.permits.set(token, { grant, input: { ...input }, strategyId, validate, until });
    return token;
  }
  validate(token: object, input: ProtectionOrder, strategyId: string | undefined, exclude?: string): void {
    const permit = this.permits.get(token), current = this.grant();
    if (!permit || !current?.enabled || current.profileId !== permit.grant.profileId || current.accountId !== permit.grant.accountId
      || current.revision !== permit.grant.revision || strategyId !== permit.strategyId || this.now() > permit.until
      || !['live', 'protect_only'].includes(this.session.current)) throw new Error('protection_permission_changed');
    if (!input.reduceOnly || input.type !== 'MARKET' || (Object.keys(permit.input) as Array<keyof ProtectionOrder>)
      .some(key => input[key] !== permit.input[key])) throw new Error('protection_order_changed');
    if (permit.orderId && permit.orderId !== exclude) throw new Error('protection_permit_consumed');
    permit.validate(exclude);
    if (exclude) permit.orderId = exclude;
  }
}
