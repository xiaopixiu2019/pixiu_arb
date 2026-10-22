import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OneTimeCsrfTokens } from './csrf.js';
import { TelegramInputSchema, safeTelegramError, type TelegramNotifications } from './telegram-notifications.js';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(token: string, message: string, provider: string): { html: string; csp: string } {
  const nonce = randomBytes(18).toString('base64');
  return { csp: `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    html: `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Telegram 安全配置 · PIXIU ARB</title>
<style nonce="${nonce}">:root{color-scheme:dark;font-family:system-ui;background:#0b111a;color:#e3eaf0}body{max-width:580px;margin:8vh auto;padding:24px}h1{font-size:28px}p,small{color:#acb8c8;line-height:1.7}form,label{display:grid;gap:12px}form{gap:22px}input,select,button{padding:13px;background:#141f2c;border:1px solid #3a4d60;color:inherit;border-radius:7px;font:inherit}button{background:#17554d;cursor:pointer}a{color:#78d9c9}.message{padding:14px;border-left:3px solid #e9b76f;background:#19212b}</style>
<h1>Telegram 通知配置</h1><p>整个终端共用。配置成功后向所填接收目标发送保证金风险与现有托管告警。修改此处不会改变交易状态。</p>
${message ? `<p class="message" role="status">${escape(message)}</p>` : ''}
<form method="post" action="/secure/telegram" autocomplete="off"><input type="hidden" name="csrfToken" value="${escape(token)}">
<label>Bot Token<input name="botToken" type="password" required maxlength="200" autocomplete="new-password"></label>
<label>接收目标 Chat ID<input name="chatId" required maxlength="100" placeholder="例如 123456789 或 -1001234567890"></label>
<label>存储方式<select name="provider"><option value="env_file" ${provider === 'env_file' ? 'selected' : ''}>专用数据目录文件（明文，限制文件权限）</option><option value="os_keychain" ${provider === 'os_keychain' ? 'selected' : ''}>本机系统凭据库（服务器可能不可用）</option></select></label>
<button type="submit">保存并发送测试消息</button></form>
<p><a href="https://t.me/BotFather" target="_blank" rel="noreferrer">通过 BotFather 创建机器人</a>；先在 Telegram 向机器人发送 /start，或将机器人加入目标群组。Chat ID 应填写你确认的接收人或群组标识。</p>
<p>Token 只提交至本终端后端，不会返回主页面。验证或发送失败时保留原配置。</p><a href="/risk-management">返回风险管理</a></html>` };
}
export function registerTelegramNotificationRoutes(app: FastifyInstance, service: TelegramNotifications): void {
  const csrf = new OneTimeCsrfTokens();
  app.get('/api/notifications/telegram', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store'); return { ...service.status(), csrfToken: csrf.issue() };
  });
  app.get('/secure/telegram', async (_request, reply) => {
    const content = page(csrf.issue(), '', service.status().storage);
    return reply.type('text/html').header('Cache-Control', 'no-store').header('Content-Security-Policy', content.csp).send(content.html);
  });
  app.post('/secure/telegram', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const form = TelegramInputSchema.extend({ csrfToken: z.string().min(20) }).safeParse(request.body);
    let message = '配置无效或表单已过期，请重新填写。', status = 400;
    if (form.success && csrf.consume(form.data.csrfToken)) {
      try { await service.configure(form.data); message = '配置已保存，Telegram 已接受测试消息。请检查目标聊天。'; status = 200; }
      catch (error) { message = `配置未替换：${safeTelegramError(error)}。请检查 Token、接收目标、机器人权限或网络。`; status = 409; }
    }
    const content = page(csrf.issue(), message, service.status().storage);
    return reply.code(status).type('text/html').header('Cache-Control', 'no-store').header('Content-Security-Policy', content.csp).send(content.html);
  });
  app.post('/api/notifications/telegram/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({ csrfToken: z.string().min(20) }).safeParse(request.body);
    if (request.headers['x-gct-notification-intent'] !== 'test' || !body.success || !csrf.consume(body.data.csrfToken))
      return reply.code(403).send({ error: 'invalid_notification_intent' });
    try { return await service.test(); }
    catch (error) { return reply.code(409).send({ error: safeTelegramError(error) }); }
  });
  app.delete('/api/notifications/telegram', async (request, reply) => {
    const body = z.object({ csrfToken: z.string().min(20), confirm: z.literal(true) }).safeParse(request.body);
    if (request.headers['x-gct-notification-intent'] !== 'remove' || !body.success || !csrf.consume(body.data.csrfToken))
      return reply.code(403).send({ error: 'invalid_notification_intent' });
    try { return await service.remove(); }
    catch (error) { return reply.code(409).send({ error: safeTelegramError(error) }); }
  });
}
