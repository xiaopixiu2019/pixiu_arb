import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { TradingSession } from './trading-session.js';
import { ProtectionAuthority } from './protection-authority.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = openDatabase(':memory:', resolve('../../migrations')); databases.push(db);
  const session = new TradingSession();
  const authority = new ProtectionAuthority(db, session, () => 'profile');
  return { db, session, authority };
}
describe('explicit continuous protection authority', () => {
  it('does not migrate legacy holdings or risk policies into a continuous grant', () => {
    const { authority, session } = setup();
    expect(authority.grant()).toBeNull(); session.set('live'); session.pause();
    expect(session.current).toBe('readonly');
  });
  it('freezes ordinary live execution while preserving an explicit protection grant', () => {
    const { authority, session } = setup(); session.set('live');
    authority.configure('account-key', ['group'], 0, true); session.pause();
    expect(session.current).toBe('protect_only'); expect(session.liveTradingEnabled).toBe(false);
    expect(authority.grant()?.enabled).toBe(true);
  });
  it('explicit readonly revokes the grant even if already readonly and cannot be undone by restart', () => {
    const { authority, session, db } = setup(); session.set('live');
    authority.configure('account-key', ['group'], 0, true); session.set('readonly');
    expect(authority.grant()?.enabled).toBe(false);
    const restarted = new ProtectionAuthority(db, new TradingSession(), () => 'profile');
    expect(restarted.grant()?.enabled).toBe(false);
    expect(() => authority.configure('account-key', ['group'], 1, true)).toThrow('protection_revision_changed');
  });
  it('retains the enrolled identity across restart without arming ordinary trading', () => {
    const { authority, session, db } = setup(); session.set('live');
    authority.configure('account-key', ['group'], 0, true);
    const next = new TradingSession(); const restarted = new ProtectionAuthority(db, next, () => 'profile');
    expect(next.current).toBe('unset'); expect(restarted.grant()).toMatchObject({ accountId: 'account-key', enabled: true });
  });
  it('rejects forged, enlarged, reversed and expired capabilities', () => {
    const { authority, session } = setup(); session.set('live'); authority.configure('key', ['group'], 0, true);
    const input = { symbol: 'GATE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', quantity: '1', reduceOnly: true };
    const token = authority.issue(input, 'task', () => undefined, Date.now() + 10000);
    expect(() => authority.validate({}, input, 'task')).toThrow('protection_permission_changed');
    expect(() => authority.validate(token, { ...input, quantity: '2' }, 'task')).toThrow('protection_order_changed');
    expect(() => authority.validate(token, { ...input, side: 'BUY' }, 'task')).toThrow('protection_order_changed');
    const expired = authority.issue(input, 'task', () => undefined, Date.now() - 1);
    expect(() => authority.validate(expired, input, 'task')).toThrow('protection_permission_changed');
    authority.validate(token, input, 'task', 'first-order');
    expect(() => authority.validate(token, input, 'task', 'second-order')).toThrow('protection_permit_consumed');
    authority.configure('key', [], 1, false);
    expect(() => authority.validate(token, input, 'task')).toThrow('protection_permission_changed');
  });
  it('locks the process immediately even if persisting a revocation fails', () => {
    const session = new TradingSession(); session.set('live');
    session.attachProtection(() => true, () => { throw new Error('synthetic storage failure'); });
    expect(() => session.set('readonly')).toThrow('synthetic storage failure');
    expect(session.current).toBe('readonly'); expect(session.liveTradingEnabled).toBe(false);
  });
});
