import { describe, expect, it } from 'vitest';
import { managedExitSignal } from './managed-position-model.js';
import { openDatabase } from './database.js';
import { ManagedRiskTelegramAlerts } from './managed-risk-telegram.js';
import { resolve } from 'node:path';

const legs = [{ symbol: 'BYBIT_FUTURE_MSTR_USDT', side: 'SELL' as const }, { symbol: 'DERIBIT_FUTURE_MSTR_USDC', side: 'BUY' as const }];
const config = { condition: 'AND' as const, spreadBps: '1000', fundingAprPct: '1000', durationSeconds: 60,
  perOrderQuantity: '1', makerLeg: 'left' as const, intervalSeconds: 1, makerWaitSeconds: 5, marketFallback: false };
function sample(now: number, broken: number, previous: Parameters<typeof managedExitSignal>[4]) {
  const quote = { source: 'gate_crossex_websocket', bidPrice: '100', askPrice: '101', updatedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
  return managedExitSignal(config, legs, [quote, quote].map((q, i) => i === broken ? { ...q, receivedAt: '' } : q),
    [{ rate8h: '0.001', fetchedAt: now }, { rate8h: '0.001', fetchedAt: now }], previous, now);
}
describe('continuous exit signal incident', () => {
  it('retains the first missing time through reason changes and resets economic dwell separately', () => {
    const first = sample(100_000, 1, { conditionSince: 1 });
    const switched = sample(340_000, 0, JSON.parse(JSON.stringify(first)));
    const switchedBack = sample(348_000, 1, switched);
    expect(switched.signalReason).not.toBe(first.signalReason);
    expect(switchedBack).toMatchObject({ signalMissingSince: 100_000, conditionSince: null, trigger: false });
    const recovered = sample(640_000, -1, switchedBack);
    expect(recovered).toMatchObject({ signalMissingSince: null, signalReason: null, conditionSince: 640_000, trigger: false });
    expect(sample(650_000, 1, recovered)).toMatchObject({ signalMissingSince: 650_000, conditionSince: null, trigger: false });
  });

  it('deduplicates a quote-to-funding incident across notifier restart and permits a new incident after recovery', async () => {
    const db = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    try {
      const started = 100_000, first = sample(started, 1, { conditionSince: null });
      const quote = { source: 'gate_crossex_websocket', bidPrice: '100', askPrice: '101', updatedAt: new Date(340_000).toISOString(), receivedAt: new Date(340_000).toISOString() };
      const fundingMissing = managedExitSignal(config, legs, [quote, quote], [null, { rate8h: '0', fetchedAt: 340_000 }], first, 340_000);
      expect(fundingMissing.signalMissingSince).toBe(started);
      expect(fundingMissing.signalReason).toMatch(/^managed_funding_unavailable/);
      db.prepare('INSERT INTO execution_strategies (id,kind,environment,status,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run('PAIR-TEST', 'position', 'live', 'RUNNING', '{"asset":"MSTR"}', 'test', 'test');
      const state = (value: typeof first) => JSON.stringify({ phase: 'MONITORING', leftQuantity: '1', rightQuantity: '1', ...value });
      db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('PAIR-TEST', 'test-account', state(fundingMissing), 'test');
      let sent = 0, now = 401_000;
      const send: typeof fetch = async () => { sent++; return new Response('{"ok":true}'); };
      const notifier = () => new ManagedRiskTelegramAlerts(db, { TELEGRAM_BOT_TOKEN: '123:fake-token', TELEGRAM_CHAT_ID: '456' }, () => undefined, send, () => now);
      await notifier().poll(); await notifier().poll(); expect(sent).toBe(1);
      const recovered = sample(450_000, -1, fundingMissing), next = sample(500_000, 1, recovered);
      db.prepare('UPDATE managed_positions SET state_json=? WHERE strategy_id=?').run(state(next), 'PAIR-TEST'); now = 801_000;
      await notifier().poll(); expect(sent).toBe(2);
    } finally { db.close(); }
  });
});
