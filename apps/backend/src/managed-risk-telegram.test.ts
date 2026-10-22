import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import { loadTelegramAlertSettings, ManagedRiskTelegramAlerts } from './managed-risk-telegram.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'risk-telegram-')); directories.push(directory);
  const db = openDatabase(join(directory, 'test.sqlite'), resolve('../../migrations'));
  db.prepare('INSERT INTO managed_risk_lock VALUES (1, ?, ?)').run('managed_order_unresolved', '2026-09-27T00:00:00.000Z');
  const settings = { TELEGRAM_BOT_TOKEN: '123:fake-token', TELEGRAM_CHAT_ID: '456' };
  return { db, settings, directory };
}

describe('managed risk Telegram alerts', () => {
  it('notifies quote loss immediately, deduplicates across restart, then records recovery without claiming trading permission', async () => {
    const h = harness(); h.db.exec('DELETE FROM managed_risk_lock');
    let now = Date.now(); const startedAt = now;
    h.db.prepare("INSERT INTO execution_strategies (id,kind,environment,status,config_json,created_at,updated_at) VALUES ('PAIR-LOSS','position','live','RUNNING',?, 'test','test')").run('{"asset":"ETH"}');
    const state = { phase: 'MONITORING', leftQuantity: '1', rightQuantity: '1', signalReason: 'managed_quote_unavailable:BYBIT_FUTURE_ETH_USDT', signalMissingSince: now };
    h.db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('PAIR-LOSS','synthetic',JSON.stringify(state),'test');
    const send = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const notifier = () => new ManagedRiskTelegramAlerts(h.db,h.settings,vi.fn(),send,()=>now);
    await notifier().poll(); await notifier().poll(); expect(send).toHaveBeenCalledTimes(1);
    now += 2000;
    h.db.prepare('UPDATE managed_positions SET state_json=? WHERE strategy_id=?').run(JSON.stringify({ ...state, signalReason: null, signalMissingSince: null }), 'PAIR-LOSS');
    h.db.prepare('INSERT INTO audit_events (id,type,created_at,correlation_id,payload_json) VALUES (?,?,?,?,?)').run('recovery','managed_signal_recovered',new Date(now).toISOString(),`signal:PAIR-LOSS:${startedAt}`,JSON.stringify({ strategyId:'PAIR-LOSS',asset:'ETH',startedAt,endedAt:now }));
    await notifier().poll(); await notifier().poll(); expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(send.mock.calls[1][1]?.body)).text).toContain('风险锁');
    h.db.close();
  });
  it('reports failure start separately from hard pause and retains the precise read cause without duplicate alerts', async () => {
    const h = harness();
    for (const [id, type, at, payload] of [
      ['fault', 'managed_account_read_fault', '2026-09-27T00:00:23.000Z', { status: 500, label: 'INTERNAL', endpoint: '/crossex/positions', phase: 'decode' }],
      ['pause', 'managed_account_hard_pause', '2026-09-27T00:00:25.000Z', { reason: 'managed_account_recovery_expired' }],
    ] as const) h.db.prepare('INSERT INTO audit_events (id,type,created_at,correlation_id,payload_json) VALUES (?,?,?,?,?)')
      .run(id, type, at, '2026-09-27T00:00:00.000Z', JSON.stringify(payload));
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
    const alerts = new ManagedRiskTelegramAlerts(h.db, h.settings, vi.fn(), send as typeof fetch);
    await alerts.poll(); await alerts.poll();
    const text = JSON.parse(String(send.mock.calls[0][1]?.body)).text;
    expect(text).toContain('故障开始：2026-09-27T00:00:00.000Z');
    expect(text).toContain('硬暂停时间：2026-09-27T00:00:25.000Z');
    expect(text).toContain('/crossex/positions；HTTP 500 / INTERNAL'); expect(send).toHaveBeenCalledTimes(1);
    h.db.close();
  });
  it('delivers an existing hard lock once and deduplicates across process restarts', async () => {
    const h = harness(); const send = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/sendMessage'); expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const logger = vi.fn();
    const first = new ManagedRiskTelegramAlerts(h.db, h.settings, logger, send as typeof fetch);
    await first.poll(); await first.poll();
    const restarted = new ManagedRiskTelegramAlerts(h.db, h.settings, logger, send as typeof fetch);
    await restarted.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({ chat_id: '456' });
    expect(h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE type = 'managed_risk_telegram_sent'").get()).toEqual({ n: 1 });
    h.db.close();
  });
  it('retries delivery after failure without clearing the risk lock', async () => {
    const h = harness(); let now = Date.parse('2026-09-27T00:00:00Z');
    const send = vi.fn().mockRejectedValueOnce(new Error('synthetic outage'))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const alerts = new ManagedRiskTelegramAlerts(h.db, h.settings, vi.fn(), send as typeof fetch, () => now);
    await alerts.poll(); await alerts.poll(); expect(send).toHaveBeenCalledTimes(1);
    now += 11_000; await alerts.poll();
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.db.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'managed_order_unresolved' });
    h.db.close();
  });
  it('does not alert on a temporary account recheck and validates the private file', async () => {
    const h = harness(); h.db.prepare('UPDATE managed_risk_lock SET reason = ?').run('managed_account_rechecking');
    const send = vi.fn();
    const alerts = new ManagedRiskTelegramAlerts(h.db, h.settings, vi.fn(), send as typeof fetch,
      () => Date.parse('2026-09-27T00:00:01Z'));
    await alerts.poll(); expect(send).not.toHaveBeenCalled();
    const path = join(h.directory, 'telegram-alert.env');
    writeFileSync(path, 'TELEGRAM_BOT_TOKEN=123:fake-token\nTELEGRAM_CHAT_ID=456\n');
    expect(loadTelegramAlertSettings(path)).toEqual(h.settings);
    h.db.close();
  });
  it('alerts when a temporary recheck is stranded after restart', async () => {
    const h = harness(); h.db.prepare('UPDATE managed_risk_lock SET reason = ?').run('managed_account_rechecking');
    const send = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const alerts = new ManagedRiskTelegramAlerts(h.db, h.settings, vi.fn(), send as typeof fetch,
      () => Date.parse('2026-09-27T00:00:26Z'));
    await alerts.poll(); await alerts.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE type = 'managed_recheck_stalled_telegram_sent'").get()).toEqual({ n: 1 });
    h.db.close();
  });
  it('warns each active task with a missing exit signal without repeating a delivered incident', async () => {
    const h = harness(); h.db.prepare('DELETE FROM managed_risk_lock').run();
    const now = Date.parse('2026-09-27T01:00:00Z');
    h.db.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, created_at, updated_at)
      VALUES ('PAIR-SIGNAL', 'position', 'live', 'RUNNING', ?, ?, ?)`).run('{"asset":"SIREN"}', new Date(now).toISOString(), new Date(now).toISOString());
    h.db.prepare('INSERT INTO managed_positions VALUES (?, ?, ?, ?)').run('PAIR-SIGNAL', 'account-1',
      JSON.stringify({ phase: 'MONITORING', leftQuantity: '4000', rightQuantity: '4000',
        checkedAt: new Date(now).toISOString(), signalReason: 'managed_funding_unavailable:BYBIT_FUTURE_SIREN_USDT',
        signalMissingSince: now - 301_000 }), new Date(now).toISOString());
    h.db.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, created_at, updated_at)
      VALUES ('PAIR-OTHER', 'position', 'live', 'RUNNING', ?, ?, ?)`).run('{"asset":"PENDLE"}', new Date(now).toISOString(), new Date(now).toISOString());
    h.db.prepare('INSERT INTO managed_positions VALUES (?, ?, ?, ?)').run('PAIR-OTHER', 'account-1',
      JSON.stringify({ phase: 'MONITORING', leftQuantity: '10', rightQuantity: '10',
        checkedAt: new Date(now).toISOString(), signalReason: 'managed_quote_unavailable:GATE_FUTURE_PENDLE_USDT',
        signalMissingSince: now - 300_500 }), new Date(now).toISOString());
    const send = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const alerts = new ManagedRiskTelegramAlerts(h.db, h.settings, vi.fn(), send as typeof fetch, () => now);
    await alerts.poll(); await alerts.poll(); await alerts.poll();
    expect(send).toHaveBeenCalledTimes(2);
    expect(h.db.prepare("SELECT count(*) AS n FROM audit_events WHERE type = 'managed_signal_telegram_sent'").get()).toEqual({ n: 2 });
    h.db.close();
  });
});
