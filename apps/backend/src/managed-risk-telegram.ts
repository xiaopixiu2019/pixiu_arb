import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MANAGED_ACCOUNT_RECHECKING, MANAGED_RECOVERY_WINDOW_MS } from './managed-position-store.js';

const SettingsSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$|^@[A-Za-z0-9_]+$/),
});
export type TelegramAlertSettings = z.infer<typeof SettingsSchema>;
type AlertLogger = (fields: Record<string, unknown>, message: string) => void;

export function loadTelegramAlertSettings(path: string): TelegramAlertSettings | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (!match) continue;
    const value = match[2];
    values[match[1]] = value.length >= 2 && /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return Object.keys(values).length ? SettingsSchema.parse(values) : null;
}

interface RiskLock { reason: string; created_at: string }
interface TaskRow { id: string; asset: string; left_quantity: string | null; right_quantity: string | null; checked_at: string | null }
interface SignalRow extends TaskRow { signal_reason: string; missing_since: number }
interface Alert { key: string; type: string; reason: string; text: string; taskCount: number }

export class ManagedRiskTelegramAlerts {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private retryAt = 0;
  private failures = 0;
  private retryKey: string | null = null;

  constructor(private readonly db: Database.Database, private settings: TelegramAlertSettings | null,
    private readonly log: AlertLogger, private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {}

  updateSettings(settings: TelegramAlertSettings | null): void {
    this.settings = settings;
    if (!settings && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.retryAt = 0;
  }

  start(): void {
    if (!this.settings || this.timer) return;
    this.timer = setInterval(() => { this.runPoll(); }, 5_000);
    this.timer.unref?.();
    this.runPoll();
  }
  private runPoll(): void {
    void this.poll().catch(() => this.log({}, 'managed risk Telegram alert scan failed'));
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
  async poll(): Promise<void> {
    if (!this.settings || this.inFlight) return;
    const lock = this.db.prepare('SELECT reason, created_at FROM managed_risk_lock WHERE singleton = 1')
      .get() as RiskLock | undefined;
    const alert = lock?.reason === MANAGED_ACCOUNT_RECHECKING
      ? this.now() - Date.parse(lock.created_at) >= MANAGED_RECOVERY_WINDOW_MS ? this.stalledRecheckAlert(lock) : null
      : lock ? this.hardAlert(lock) : [...this.signalAlerts(), ...this.recoveryAlerts()].find((candidate) => !this.wasSent(candidate)) ?? null;
    if (!alert || this.wasSent(alert)) return;
    if (this.retryKey !== alert.key) { this.retryKey = alert.key; this.retryAt = 0; this.failures = 0; }
    if (this.now() < this.retryAt) return;
    this.inFlight = this.send(alert).catch(() => {
      this.failures += 1;
      this.retryAt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(this.failures, 6));
      this.log({ incidentKey: alert.key, retryAt: new Date(this.retryAt).toISOString() }, 'managed risk Telegram delivery failed');
    }).finally(() => { this.inFlight = null; });
    await this.inFlight;
  }
  private wasSent(alert: Alert): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM audit_events
      WHERE type = ? AND correlation_id = ? LIMIT 1`).get(alert.type, alert.key));
  }
  private tasks(): TaskRow[] {
    return this.db.prepare(`SELECT s.id, json_extract(s.config_json, '$.asset') AS asset,
      json_extract(m.state_json, '$.leftQuantity') AS left_quantity,
      json_extract(m.state_json, '$.rightQuantity') AS right_quantity,
      json_extract(m.state_json, '$.checkedAt') AS checked_at
      FROM managed_positions m JOIN execution_strategies s ON s.id = m.strategy_id
      WHERE json_extract(m.state_json, '$.phase') = 'RISK_PAUSED'`).all() as TaskRow[];
  }
  private hardAlert(lock: RiskLock): Alert {
    const tasks = this.tasks().map((task) =>
      `${task.asset} ${task.id}: A ${task.left_quantity ?? '未知'} / B ${task.right_quantity ?? '未知'}；最后核对 ${task.checked_at ?? '未知'}`);
    return { key: lock.created_at, type: 'managed_risk_telegram_sent', reason: lock.reason, taskCount: tasks.length,
      text: ['🚨 Gate CrossEx 需要人工核查', `原因：${lock.reason}`, `故障开始：${lock.created_at} UTC`, ...this.readEvidence(lock),
      '系统状态：全局风险暂停；新交易和自动退出已阻止。',
      ...tasks, '请到交易所核对实际持仓、挂单和订单结果；未确认前不要重放订单或直接解除风险锁。'].join('\n') };
  }
  private readEvidence(lock: RiskLock): string[] {
    const pause = this.db.prepare("SELECT created_at FROM audit_events WHERE type='managed_account_hard_pause' AND correlation_id=? ORDER BY created_at DESC LIMIT 1")
      .get(lock.created_at) as { created_at: string } | undefined;
    const row = this.db.prepare("SELECT created_at,payload_json FROM audit_events WHERE type='managed_account_read_fault' AND correlation_id=? ORDER BY created_at DESC LIMIT 1")
      .get(lock.created_at) as { created_at: string; payload_json: string } | undefined;
    const lines = pause ? [`硬暂停时间：${pause.created_at} UTC`] : [];
    if (row) {
      const parsed = z.object({ status: z.number().optional(), label: z.string(), endpoint: z.string().optional(), phase: z.string().optional() }).safeParse(JSON.parse(row.payload_json));
      if (parsed.success) {
        const f = parsed.data;
        lines.push(`最后读取失败：${row.created_at}；${f.endpoint ?? '账户读取'}；HTTP ${f.status ?? '未知'} / ${f.label}；阶段 ${f.phase ?? '未知'}`);
      }
    }
    return lines;
  }
  private stalledRecheckAlert(lock: RiskLock): Alert {
    const active = this.db.prepare(`SELECT s.id, json_extract(s.config_json, '$.asset') AS asset
      FROM managed_positions m JOIN execution_strategies s ON s.id = m.strategy_id
      WHERE s.status = 'RUNNING'`).all() as Array<{ id: string; asset: string }>;
    return { key: `recheck:${lock.created_at}`, type: 'managed_recheck_stalled_telegram_sent',
      reason: lock.reason, taskCount: active.length,
      text: ['🚨 Gate CrossEx 账户核实未完成', `开始时间：${lock.created_at} UTC`,
        `受影响任务：${active.map((task) => `${task.asset} ${task.id}`).join('、') || '未知'}`,
        '系统仍阻止新交易。自动恢复未能在安全期限内完成，可能是服务重启或交易权限仍关闭。',
        '请核对交易所持仓、挂单及系统运行状态；未确认前不要直接解除风险锁。'].join('\n') };
  }
  private signalAlerts(): Alert[] {
    const rows = this.db.prepare(`SELECT s.id, json_extract(s.config_json, '$.asset') AS asset,
      json_extract(m.state_json, '$.leftQuantity') AS left_quantity,
      json_extract(m.state_json, '$.rightQuantity') AS right_quantity,
      json_extract(m.state_json, '$.checkedAt') AS checked_at,
      json_extract(m.state_json, '$.signalReason') AS signal_reason,
      json_extract(m.state_json, '$.signalMissingSince') AS missing_since
      FROM managed_positions m JOIN execution_strategies s ON s.id = m.strategy_id
      WHERE s.status = 'RUNNING' AND json_extract(m.state_json, '$.signalReason') IS NOT NULL
        AND (json_extract(m.state_json, '$.signalMissingSince') <= ? OR json_extract(m.state_json, '$.signalReason') LIKE 'managed_quote_unavailable:%')
      ORDER BY missing_since`).all(this.now() - 300_000) as SignalRow[];
    return rows.map((row): Alert => ({ key: `signal:${row.id}:${row.missing_since}`,
      type: this.now() - row.missing_since < 300000 ? 'managed_quote_unavailable_telegram_sent' : 'managed_signal_telegram_sent',
      reason: row.signal_reason, taskCount: 1,
      text: [this.now() - row.missing_since < 300000 ? '⚠️ 自动退出所需报价不可用，正在持续探测主备来源' : '⚠️ Gate CrossEx 自动退出信号持续缺失', `${row.asset} ${row.id}`,
        `缺失：${row.signal_reason}`, `开始：${new Date(row.missing_since).toISOString()} UTC`,
        `最后持仓核对：${row.checked_at ?? '未知'}；A ${row.left_quantity ?? '未知'} / B ${row.right_quantity ?? '未知'}`,
        '持仓核对与失衡保护仍在运行；经济退出条件无法确认。请检查对应行情或费率数据源。'].join('\n') }));
  }
  private recoveryAlerts(): Alert[] {
    const events = this.db.prepare("SELECT correlation_id,payload_json FROM audit_events WHERE type='managed_signal_recovered' AND created_at>=? ORDER BY created_at DESC LIMIT 100")
      .all(new Date(this.now() - 86400000).toISOString()) as Array<{ correlation_id: string; payload_json: string }>;
    const seen = new Set<string>();
    return events.flatMap(event => {
      const parsed = z.object({ strategyId: z.string(), asset: z.string(), startedAt: z.number(), endedAt: z.number() }).safeParse(JSON.parse(event.payload_json));
      if (!parsed.success) return [];
      const value = parsed.data;
      if (seen.has(value.strategyId)) return []; seen.add(value.strategyId);
      const state = this.db.prepare('SELECT state_json FROM managed_positions WHERE strategy_id=?').get(value.strategyId) as { state_json: string } | undefined;
      if (!state || JSON.parse(state.state_json).signalReason) return [];
      return [{ key: event.correlation_id, type: 'managed_signal_recovered_telegram_sent', reason: 'signal_data_recovered', taskCount: 1,
        text: [`${value.asset} ${value.strategyId} 自动退出所需价格与费率数据已恢复`,
          `缺失窗口：${new Date(value.startedAt).toISOString()} — ${new Date(value.endedAt).toISOString()}`,
          '退出条件持续时间重新计算；交易是否允许仍取决于账户核对、风险锁和原授权。'].join('\n') }];
    });
  }
  private async send(alert: Alert): Promise<void> {
    const settings = this.settings!;
    const response = await this.fetchImpl(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.TELEGRAM_CHAT_ID, text: alert.text }),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = z.object({ ok: z.boolean() }).safeParse(await response.json());
    if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error('telegram_send_rejected');
    this.db.prepare(`INSERT INTO audit_events (id, created_at, type, correlation_id, payload_json)
      VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), new Date(this.now()).toISOString(),
      alert.type, alert.key, JSON.stringify({ reason: alert.reason, taskCount: alert.taskCount }));
    this.failures = 0; this.retryAt = 0;
    this.log({ incidentKey: alert.key }, 'managed risk Telegram alert delivered');
  }
}
