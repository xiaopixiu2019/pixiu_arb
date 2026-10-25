import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { MarginRiskStore } from './margin-risk-store.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'margin-risk-read-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, 'risk.sqlite'), resolve('../../migrations'));
  cleanup.push(() => db.close());
  const store = new MarginRiskStore(db);
  return { db, store };
}

describe('risk account reads under concurrent derived-result publication', () => {
  it('reads existing policy, incident and latch without obtaining an unrelated writer lock', () => {
    const { db, store } = fixture(), policy = store.policy('account');
    store.latch('account', true);
    const writer = new Database(db.name); cleanup.push(() => writer.close());
    db.pragma('busy_timeout = 0'); writer.exec('BEGIN IMMEDIATE');
    try {
      writer.prepare('INSERT INTO task_pnl_projection_work VALUES (?,?,?,?)').run('account', 1, 'publication', '{}');
      expect(store.policy('account')).toEqual(policy);
      expect(store.incident('account')).toBeNull();
      expect(store.latched('account')).toBe(true);
      expect(() => store.policy('new-account')).toThrow('database is locked');
    } finally { writer.exec('ROLLBACK'); }
    expect(store.policy('new-account').revision).toBe(0);
  });
  it('supports a genuinely read-only view of an already initialized risk account', () => {
    const { db, store } = fixture(), policy = store.policy('account');
    const reader = new Database(db.name, { readonly: true }); cleanup.push(() => reader.close());
    const view = new MarginRiskStore(reader);
    expect(view.policy('account')).toEqual(policy);
    expect(view.incident('account')).toBeNull();
    expect(view.latched('account')).toBe(false);
    expect(() => view.policy('uninitialized')).toThrow();
    expect(() => view.latch('account', true)).toThrow();
  });
  it('initializes once and preserves later policy, incident and entry-lock writes', () => {
    const { db, store } = fixture(), policy = store.policy('account');
    store.savePolicy('account', { ...policy, protectedGroupIds: ['group'] });
    const incident = store.startIncident('account', Date.now());
    expect(store.policy('account')).toMatchObject({ revision: policy.revision + 1, protectedGroupIds: ['group'] });
    expect(store.incident('account')).toEqual(incident);
    expect(store.latched('account')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM margin_risk_accounts').get()).toEqual({ n: 1 });
  });
});
