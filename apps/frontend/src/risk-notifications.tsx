import { useEffect, useState } from 'react';
import { type TelegramStatus } from '@gate-crossex/shared-types';
import { riskApi } from './risk-api.js';
import { riskReason } from './risk-presentation.js';

export function RiskNotifications({ zh }: { zh: boolean }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null), [error, setError] = useState('');
  const [feedback, setFeedback] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading) return; loading = true;
      try { const next = await riskApi.telegram(); if (active) { setStatus(next); setError(''); } }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'telegram_status_unavailable'); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 30000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const run = async (remove: boolean) => {
    setBusy(true); setError(''); setFeedback('');
    try { setStatus(await (remove ? riskApi.removeTelegram() : riskApi.testTelegram())); setConfirm(false);
      setFeedback(remove ? (zh ? '已移除全终端通知配置。' : 'Terminal notification settings removed.') : (zh ? 'Telegram 已接受测试消息，请查看目标聊天。' : 'Telegram accepted the test message. Check your chat.')); }
    catch (e) { setError(e instanceof Error ? e.message : 'notification_request_failed'); }
    finally { setBusy(false); }
  };
  return <div className="risk-side-item"><div className="risk-section-heading"><h3>Telegram {zh ? '通知' : 'notifications'}</h3><a href="/secure/telegram">{zh ? '配置通知 ›' : 'Configure ›'}</a></div>
    <p>{error ? (zh ? '通知状态待核实' : 'Notification status unverified') : status === null ? (zh ? '正在读取通知状态…' : 'Loading notification status…') : status.configured ? `@${status.botName ?? 'Telegram'}` : (zh ? '尚未配置 · 不影响风险监控' : 'Not configured · risk monitoring continues')}</p>
    <details className="risk-notification-details"><summary>{zh ? '通知详情与测试' : 'Notification details and test'}</summary>
      <p>{zh ? '整个终端共用；发送成功不代表已阅读。' : 'Shared terminal-wide; acceptance is not a read receipt.'}</p>
      <p>{zh ? '最近成功发送' : 'Last sent'}: {status?.lastSentAt ?? '—'}</p>
      <p>{zh ? '最近测试' : 'Last tested'}: {status?.testedAt ?? '—'}</p>
      {status?.lastError && <p role="alert">{riskReason(status.lastError, zh)}</p>}
      <div className="risk-heading-actions"><a className="risk-button" href="/secure/telegram">{zh ? '安全配置机器人' : 'Configure securely'}</a>
        <button disabled={busy || !status?.configured || !!error} onClick={() => void run(false)}>{zh ? '发送测试消息' : 'Send test'}</button>
        {status?.configured && <button disabled={busy} onClick={() => setConfirm(true)}>{zh ? '移除配置' : 'Remove configuration'}</button>}</div>
      {confirm && <div className="risk-notice"><p>{zh ? '这会关闭整个终端的 Telegram 通知。' : 'This disables Telegram notifications across the terminal.'}</p><button disabled={busy} onClick={() => void run(true)}>{zh ? '确认移除' : 'Confirm removal'}</button><button disabled={busy} onClick={() => setConfirm(false)}>{zh ? '取消' : 'Cancel'}</button></div>}
    </details>{error && <p role="alert" className="risk-inline-error">{riskReason(error, zh)}</p>}{feedback && <p role="status">{feedback}</p>}
  </div>;
}
