import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramNotifications } from './telegram-notifications.js';
import { DEFAULT_MARGIN_POLICY, MarginSnapshotSchema } from '@gate-crossex/shared-types';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const token = '123456:synthetic_test_token';
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-risk-test-')); dirs.push(dir);
  const changed = vi.fn(), fetcher = vi.fn<typeof fetch>();
  const service = new TelegramNotifications(dir, changed, fetcher);
  const success = () => { fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { username: 'fake_bot' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))); };
  return { dir, service, changed, fetcher, success };
}
describe('terminal-wide notification configuration', () => {
  it('rolls back rejected plaintext even when keychain cleanup and recovery both fail', async () => {
    const h = harness(); let secret: string | undefined, unavailable = false;
    const entry = { getPassword: async () => secret, setPassword: async (value: string) => { if (unavailable) throw new Error('offline'); secret = value; },
      deleteCredential: async () => { if (unavailable) throw new Error('offline'); secret = undefined; return true; } };
    const service = new TelegramNotifications(h.dir, h.changed, h.fetcher, Date.now, undefined, async () => entry);
    h.success(); await service.configure({ botToken: token, chatId: '123', provider: 'os_keychain' });
    unavailable = true; h.success();
    await expect(service.configure({ botToken: '234:rejected', chatId: '456', provider: 'env_file' })).rejects.toThrow('telegram_configuration_recovery_failed');
    expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).toBe(''); expect(service.status().chatId).toBe('123');
  });
  it('removes configured or empty settings without breaking the next startup', async () => {
    const h = harness(); await h.service.remove();
    expect(new TelegramNotifications(h.dir, vi.fn(), h.fetcher).status().configured).toBe(false);
    h.success(); await h.service.configure({ botToken: token, chatId: '123' }); await h.service.remove();
    const restarted = new TelegramNotifications(h.dir, vi.fn(), h.fetcher); await restarted.initialize();
    expect(restarted.status().configured).toBe(false); expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).not.toContain(token);
  });
  it('migrates both storage directions, removes superseded secrets, and rolls back cleanup failures', async () => {
    const h = harness(); let secret: string | undefined, failDelete = false;
    const entry = { getPassword: async () => secret, setPassword: async (value: string) => { secret = value; },
      deleteCredential: async () => { if (failDelete) { failDelete = false; throw new Error('synthetic_cleanup_failure'); } secret = undefined; return true; } };
    const service = new TelegramNotifications(h.dir, h.changed, h.fetcher, Date.now, undefined, async () => entry);
    h.success(); await service.configure({ botToken: token, chatId: '123', provider: 'env_file' });
    h.success(); await service.configure({ botToken: token, chatId: '123', provider: 'os_keychain' });
    expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).toBe(''); expect(secret).toContain(token);
    failDelete = true; h.success();
    await expect(service.configure({ botToken: '234:replacement', chatId: '456', provider: 'env_file' })).rejects.toThrow();
    expect(service.status().storage).toBe('os_keychain'); expect(secret).toContain(token); expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).toBe('');
    h.success(); await service.configure({ botToken: token, chatId: '123', provider: 'env_file' });
    expect(secret).toBeUndefined(); await service.remove(); expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).toBe('');
  });
  it('alerts on continuously incomplete unit data even when every response has age zero', async () => {
    const h = harness(); let now = Date.now();
    const service = new TelegramNotifications(h.dir, h.changed, h.fetcher, () => now);
    h.success(); await service.configure({ botToken: token, chatId: '123' });
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 2 } })));
    for (let i = 0; i < 30; i += 1) {
      service.observe(MarginSnapshotSchema.parse({ accountId: 'test', accountLabel: 'Test', sampledAt: now, ageMs: 0,
        status: 'unavailable', reason: 'margin_unit_unavailable', fresh: false, entryBlocked: true, liveEnabled: false,
        metrics: null, policy: DEFAULT_MARGIN_POLICY, effectivePolicy: DEFAULT_MARGIN_POLICY, incidentId: null, groups: [], uncoveredSymbols: [] }));
      await service.stop(); now += 2000;
    }
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
  it('tests and persists a bot without returning its token and reloads without trading hooks', async () => {
    const h = harness(); h.success();
    const result = await h.service.configure({ botToken: token, chatId: '123' });
    expect(result).toMatchObject({ configured: true, botName: 'fake_bot', chatId: '123' });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(h.dir, 'telegram-alert.env'), 'utf8')).toContain(token);
    const reload = new TelegramNotifications(h.dir, vi.fn(), h.fetcher); await reload.initialize();
    expect(reload.status().configured).toBe(true); expect(reload.status().botName).toBe('fake_bot');
  });
  it('preserves working configuration after a rejected replacement or transport failure', async () => {
    const h = harness(); h.success(); await h.service.configure({ botToken: token, chatId: '123' });
    h.fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(h.service.configure({ botToken: '99:invalid', chatId: '456' })).rejects.toThrow('telegram_invalid_token');
    expect(h.service.status().chatId).toBe('123');
    h.fetcher.mockRejectedValueOnce(new Error(`transport https://api.telegram.org/bot${token}/getMe`));
    try { await h.service.configure({ botToken: token, chatId: '456' }); } catch (error) { expect(String(error)).not.toContain(token); }
    expect(h.service.status().chatId).toBe('123');
  });
  it('rejects arbitrary token paths and reports Telegram backoff', async () => {
    const h = harness();
    await expect(h.service.configure({ botToken: 'https://bad/', chatId: '123' })).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
    h.success(); await h.service.configure({ botToken: token, chatId: '123' });
    h.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, parameters: { retry_after: 90 } }), { status: 429 }));
    await expect(h.service.test()).rejects.toThrow('telegram_rate_limited');
    expect(h.service.status().retryAt).not.toBeNull();
  });
});
