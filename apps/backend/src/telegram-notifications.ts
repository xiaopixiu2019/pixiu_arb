import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarginSnapshot, TelegramStatus } from '@gate-crossex/shared-types';
import { loadTelegramAlertSettings, type TelegramAlertSettings } from './managed-risk-telegram.js';

export const TelegramInputSchema = z.object({
  botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/).max(200),
  chatId: z.string().regex(/^-?\d+$|^@[A-Za-z0-9_]+$/).max(100),
  provider: z.enum(['env_file', 'os_keychain']).default('env_file'),
});
type Settings = z.infer<typeof TelegramInputSchema>;
type Meta = { provider: Settings['provider']; botName: string | null; testedAt: string | null; chatId: string | null };
export interface TelegramDeliveryStore {
  get(key: string): { state: string; at: number } | undefined;
  set(key: string, state: string, at: number): void;
  clear(): void;
}
export interface TelegramSecretEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
export class TelegramNotifications {
  private settings: Settings | null = null;
  private meta: Meta = { provider: 'env_file', botName: null, testedAt: null, chatId: null };
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  private retryAt = 0;
  private inFlight = false;
  private failures = 0;
  private revision = 0;
  private pending: MarginSnapshot | null = null;
  private delivery: Promise<void> | null = null;
  private unavailableSince = new Map<string, number>();
  private readonly delivered = new Map<string, { state: string; at: number }>();
  constructor(private readonly dataDir: string, private readonly changed: (settings: TelegramAlertSettings | null) => void,
    private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now,
    private readonly deliveryStore?: TelegramDeliveryStore,
    private readonly secretEntryFactory?: () => Promise<TelegramSecretEntry>) {
    const legacy = loadTelegramAlertSettings(join(dataDir, 'telegram-alert.env'));
    if (legacy) this.settings = { botToken: legacy.TELEGRAM_BOT_TOKEN, chatId: legacy.TELEGRAM_CHAT_ID, provider: 'env_file' };
  }
  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, 'telegram-settings.json'), 'utf8'));
      this.meta = z.object({ provider: z.enum(['env_file', 'os_keychain']), botName: z.string().nullable(),
        testedAt: z.string().nullable(), chatId: z.string().nullable() }).parse(raw);
      if (this.meta.provider === 'os_keychain') {
        const secret = await (await this.secretEntry()).getPassword();
        this.settings = secret ? TelegramInputSchema.parse(JSON.parse(secret)) : null;
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        this.lastError = 'telegram_configuration_unavailable';
        if (this.meta.provider === 'os_keychain') this.settings = null;
      }
    }
    this.changed(this.legacy());
  }
  private async secretEntry(): Promise<TelegramSecretEntry> {
    if (this.secretEntryFactory) return this.secretEntryFactory();
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry('dev.gate-crossex.notifications', this.dataDir);
    return { setPassword: (value) => entry.setPassword(value), deleteCredential: () => entry.deleteCredential(),
      getPassword: async () => { try { return await entry.getPassword(); } catch (error) {
        if (error instanceof Error && /no entry|no matching entry|not found/i.test(error.message)) return undefined; throw error;
      } } };
  }
  legacy(): TelegramAlertSettings | null {
    return this.settings ? { TELEGRAM_BOT_TOKEN: this.settings.botToken, TELEGRAM_CHAT_ID: this.settings.chatId } : null;
  }
  status(): TelegramStatus {
    return { configured: !!this.settings, botName: this.meta.botName, chatId: this.settings?.chatId ?? null,
      testedAt: this.meta.testedAt, lastSentAt: this.lastSentAt, lastError: this.lastError,
      retryAt: this.retryAt > this.now() ? new Date(this.retryAt).toISOString() : null,
      storage: this.settings?.provider ?? this.meta.provider };
  }
  private async request(settings: Settings, method: 'getMe' | 'sendMessage', body: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${settings.botToken}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch { throw new Error('telegram_delivery_unconfirmed'); }
    if (response.status === 401) throw new Error('telegram_invalid_token');
    if (response.status === 403) throw new Error('telegram_chat_forbidden');
    const raw = await response.json().catch(() => null) as { ok?: boolean; result?: unknown; parameters?: { retry_after?: number } } | null;
    if (response.status === 429) {
      const seconds = raw?.parameters?.retry_after;
      this.retryAt = this.now() + (typeof seconds === 'number' && Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : 60) * 1000;
      throw new Error('telegram_rate_limited');
    }
    if (!response.ok || raw?.ok !== true) throw new Error('telegram_chat_or_request_rejected');
    return raw.result;
  }
  async configure(raw: unknown): Promise<TelegramStatus> {
    const settings = TelegramInputSchema.parse(raw);
    if (this.inFlight) throw new Error('telegram_operation_busy');
    this.inFlight = true;
    try {
      const bot = z.object({ username: z.string() }).parse(await this.request(settings, 'getMe', {}));
      await this.request(settings, 'sendMessage', { chat_id: settings.chatId, text: 'PIXIU ARB 风险管理 · Telegram 配置测试成功。此消息不是交易指令。' });
      const meta: Meta = { provider: settings.provider, botName: bot.username, chatId: settings.chatId, testedAt: new Date(this.now()).toISOString() };
      await this.persist(settings, meta);
      this.settings = settings; this.meta = meta; this.revision += 1;
      this.lastError = null; this.retryAt = 0; this.delivered.clear(); this.deliveryStore?.clear(); this.changed(this.legacy());
      return this.status();
    } catch (error) {
      this.lastError = safeTelegramError(error); throw new Error(this.lastError, { cause: error });
    } finally { this.inFlight = false; }
  }
  private async persist(settings: Settings | null, meta: Meta): Promise<void> {
    const file = join(this.dataDir, 'telegram-alert.env');
    const previousFile = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    let previousSecret: string | undefined, entry: TelegramSecretEntry | null = null;
    if (settings?.provider === 'os_keychain' || this.meta.provider === 'os_keychain') {
      entry = await this.secretEntry();
      previousSecret = await entry.getPassword();
    }
    try {
      if (settings?.provider === 'os_keychain') {
        await entry!.setPassword(JSON.stringify(settings)); await atomicFile(file, '');
      } else {
        await atomicFile(file, settings ? `TELEGRAM_BOT_TOKEN=${settings.botToken}\nTELEGRAM_CHAT_ID=${settings.chatId}\n` : '');
        if (entry && previousSecret !== undefined) await entry.deleteCredential();
      }
      await atomicFile(join(this.dataDir, 'telegram-settings.json'), JSON.stringify(meta));
    } catch (error) {
      const restored = await Promise.allSettled([
        Promise.resolve().then(async () => { if (entry) { if (previousSecret !== undefined) await entry.setPassword(previousSecret); else await entry.deleteCredential(); } }),
        Promise.resolve().then(async () => {
          if (previousFile !== null) await atomicFile(file, previousFile);
          else await unlink(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        }),
      ]);
      if (restored.some((result) => result.status === 'rejected')) throw new Error('telegram_configuration_recovery_failed', { cause: error });
      throw error;
    }
  }
  async test(): Promise<TelegramStatus> {
    if (!this.settings) throw new Error('telegram_not_configured');
    if (this.inFlight) throw new Error('telegram_operation_busy');
    this.inFlight = true;
    try {
      await this.request(this.settings, 'sendMessage', { chat_id: this.settings.chatId, text: 'PIXIU ARB 风险管理 · 通知测试。此消息不改变交易状态。' });
      this.lastSentAt = new Date(this.now()).toISOString(); this.lastError = null;
      return this.status();
    } catch (error) { this.lastError = safeTelegramError(error); throw new Error(this.lastError, { cause: error }); }
    finally { this.inFlight = false; }
  }
  async remove(): Promise<TelegramStatus> {
    if (this.inFlight) throw new Error('telegram_operation_busy');
    this.inFlight = true;
    try {
      const meta: Meta = { provider: 'env_file', botName: null, chatId: null, testedAt: null };
      await this.persist(null, meta);
      this.settings = null; this.meta = meta; this.revision += 1; this.pending = null;
      this.lastError = null; this.retryAt = 0; this.changed(null); return this.status();
    } catch (error) {
      throw new Error('telegram_configuration_failed', { cause: error });
    } finally { this.inFlight = false; }
  }
  observe(snapshot: MarginSnapshot): void {
    if (snapshot.accountId) {
      if (snapshot.status === 'unavailable') {
        if (!this.unavailableSince.has(snapshot.accountId)) this.unavailableSince.set(snapshot.accountId, this.now());
      } else this.unavailableSince.delete(snapshot.accountId);
    }
    this.pending = snapshot;
    this.delivery ??= this.deliver().catch(() => { this.lastError = 'telegram_delivery_failed'; }).finally(() => { this.delivery = null; });
  }
  async stop(): Promise<void> { this.pending = null; await this.delivery; }
  private async deliver(): Promise<void> {
    const s = this.pending, settings = this.settings;
    if (!s?.accountId || !settings || this.inFlight || this.now() < this.retryAt || !s.effectivePolicy.notificationsEnabled) return;
    const previous = this.delivered.get(s.accountId) ?? this.deliveryStore?.get(s.accountId), state = `${s.status}:${s.reason ?? ''}:${s.incidentId ?? ''}`;
    if (s.status === 'clear' && !previous) return;
    if (previous?.state === state && (s.status === 'clear' || s.status === 'recovered' || this.now() - previous.at < s.effectivePolicy.reminderMinutes * 60000)) return;
    if (s.status === 'unavailable' && this.now() - (this.unavailableSince.get(s.accountId) ?? this.now()) < 25000) return;
    this.inFlight = true; const revision = this.revision;
    try {
      const text = [`PIXIU ARB 账户保证金提醒 · ${s.status}`, `账户：${s.accountLabel}`,
        `时间：${new Date(this.now()).toISOString()}`, `IMR：${s.metrics?.initialPct ?? '不可用'}% / MMR：${s.metrics?.maintenancePct ?? '不可用'}%`,
        `预警 / 减仓 / 恢复：IMR ${s.effectivePolicy.initial.warn}/${s.effectivePolicy.initial.reduce}/${s.effectivePolicy.initial.recover}%`,
        `MMR ${s.effectivePolicy.maintenance.warn}/${s.effectivePolicy.maintenance.reduce}/${s.effectivePolicy.maintenance.recover}%`,
        `新增风险：${s.entryBlocked ? '已阻止' : '按准入检查'}`, `实盘权限：${s.liveEnabled ? '已启用' : '未启用，不能自动减仓'}`,
        s.reason ? `待处理：${s.reason}` : '请在风险管理页面查看授权覆盖与处理进度。'].join('\n');
      await this.request(settings, 'sendMessage', { chat_id: settings.chatId, text });
      if (revision === this.revision) { this.delivered.set(s.accountId, { state, at: this.now() }); this.deliveryStore?.set(s.accountId, state, this.now()); }
      this.lastSentAt = new Date(this.now()).toISOString(); this.lastError = null; this.failures = 0;
    } catch (error) {
      this.lastError = safeTelegramError(error); this.failures += 1;
      this.retryAt = Math.max(this.retryAt, this.now() + Math.min(300000, 5000 * 2 ** Math.min(this.failures, 6)));
    } finally { this.inFlight = false; }
  }
}
export function safeTelegramError(error: unknown): string {
  return error instanceof Error && /^telegram_[a-z_]+$/.test(error.message) ? error.message : 'telegram_configuration_failed';
}
async function atomicFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
