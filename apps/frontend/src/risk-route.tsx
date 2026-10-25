import { useEffect, useRef, useState } from 'react';
import { ContinuousProtectionSettings } from './risk-continuous-protection.js';
import { type MarginSnapshot } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { riskApi } from './risk-api.js';
import { MarginProtectionStatus } from './margin-protection-status.js';
import { RiskEvents } from './risk-events.js';
import { RiskSettings } from './risk-settings.js';
import { RiskNotifications } from './risk-notifications.js';
import { riskExecutionStatus, type RiskExecutionTask } from './risk-execution-status.js';
import { protectionCopy, riskAmount as amount, riskFresh, riskReason, riskTime } from './risk-presentation.js';
import './risk.css';
import { useRiskClock } from './use-risk-clock.js';

type Props = { snapshot: MarginSnapshot | null; onSnapshot: (s: MarginSnapshot) => void; tasks?: readonly RiskExecutionTask[] };
export function RiskManagementView(props: Props) {
  return <RiskWorkspace key={props.snapshot?.accountId ?? 'no-account'} {...props} />;
}
function RiskWorkspace({ snapshot, onSnapshot, tasks }: Props) {
  const { language } = useLanguage(), zh = language === 'zh';
  const [settings, setSettings] = useState(false);
  useRiskClock(snapshot);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const fresh = riskFresh(snapshot, Date.now()), accountId = snapshot?.accountId ?? null;
  const accept = (next: MarginSnapshot) => { if (active.current && next.accountId === accountId) onSnapshot(next); };
  const refresh = async () => {
    setBusy(true); setError('');
    try { const next = await riskApi.snapshot(); if (active.current) { if (accountId && next.accountId !== accountId) setError('margin_account_changed'); else onSnapshot(next); } }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'risk_request_failed'); }
    finally { if (active.current) setBusy(false); }
  };
  const openSettings = () => { setSettings(true); requestAnimationFrame(() => document.getElementById('risk-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  return <main className="risk-page">
    <header className="risk-heading"><div><span className="risk-eyebrow">ACCOUNT / RISK</span><div className="risk-title-row"><h1>{zh ? '风险管理' : 'Risk management'}</h1><p>{snapshot?.accountLabel || (zh ? '等待账户连接' : 'Waiting for account')} / {snapshot?.metrics?.accountMode === 'CROSS_EXCHANGE' ? (zh ? '跨交易所全仓' : 'Cross-exchange margin') : snapshot?.metrics?.accountMode ?? '—'}</p></div></div>
      <div className="risk-heading-actions"><span className="risk-updated">{zh ? '更新于' : 'Observed'} {riskTime(snapshot?.sampledAt)}</span><button disabled={busy} onClick={() => void refresh()}>{zh ? '刷新数据' : 'Refresh'}</button></div></header>
    {error && <p className="risk-notice error" role="alert">{riskReason(error, zh)}</p>}
    <ExecutionNotice snapshot={snapshot} fresh={fresh} tasks={tasks} zh={zh} />
    <RiskStatus snapshot={snapshot} fresh={fresh} zh={zh} onSaved={accept} />
    <RiskMetrics snapshot={snapshot} fresh={fresh} zh={zh} />
    {snapshot && <ContinuousProtectionSettings key={snapshot.accountId} snapshot={snapshot} zh={zh} />}
    {snapshot?.protection && <MarginProtectionStatus snapshot={snapshot} />}
    <div className="risk-workspace-grid"><RiskEvents key={accountId} accountId={accountId} /><ProtectionSummary snapshot={snapshot} fresh={fresh} zh={zh} onSettings={openSettings} /></div>
    {snapshot && <RiskSettings snapshot={snapshot} onSaved={accept} fresh={fresh} open={settings} onToggle={setSettings} />}
    <AccountDetails snapshot={snapshot} fresh={fresh} zh={zh} />
    <p className="risk-caption risk-bottom-note">{zh ? '未触发预警不等于无风险。自动减仓受授权、持仓模式、行情及可执行数量约束。' : 'No alert is not a safety guarantee. Reduction depends on authority, margin mode, quotes and executable size.'}</p>
  </main>;
}
function ExecutionNotice({ snapshot, fresh, tasks, zh }: { snapshot: MarginSnapshot | null; fresh: boolean; tasks?: readonly RiskExecutionTask[]; zh: boolean }) {
  const execution = riskExecutionStatus(snapshot, fresh, tasks);
  if (execution.state === 'enabled') return null;
  const unknown = execution.state === 'unavailable';
  const title = unknown ? (zh ? '执行状态待核实' : 'Execution status unverified')
    : execution.paused.length ? (zh ? `${execution.paused.length} 个托管任务已风险暂停` : `${execution.paused.length} managed tasks are risk paused`)
      : (zh ? '实盘执行已锁定' : 'Live execution is locked');
  return <section className="risk-execution-notice" data-state={execution.state} role={unknown ? 'status' : 'alert'}>
    <h2>{title}</h2>
    <p>{unknown ? (zh ? '等待新鲜账户证据，不能据旧状态判断保护已恢复。' : 'Await fresh account evidence; previous state cannot confirm restored protection.')
      : snapshot?.continuousProtection?.enabled ? (zh ? '普通策略保持暂停；已授权的账户保护独立核对并按条件减仓，详见持续保护状态。' : 'Ordinary strategies remain paused. Authorized account protection reconciles independently; inspect its current state below.')
      : execution.locked ? (zh ? '自动下单与自动减仓已停止；保证金数据正常不代表任务正在执行。' : 'Automatic orders and reductions are stopped. Healthy margin does not mean tasks are executing.')
        : (zh ? '实盘模式已启用，但这些暂停任务的自动执行尚未恢复。请逐一核对任务。' : 'Live mode is enabled, but these paused tasks have not resumed. Review each task.')}</p>
    {!!execution.paused.length && <ul>{execution.paused.map(task => <li key={task.id}><strong>{task.asset} · {task.id}</strong> — {task.reason ? riskReason(task.reason, zh) : (zh ? '请在任务详情核实暂停原因' : 'Inspect task details for the pause reason')}</li>)}</ul>}
    {!unknown && <p>{zh ? '需核对持仓与订单后明确恢复；本提示不会解除任何锁或启动任务。' : 'Reconcile holdings and orders before explicit resume. This notice does not clear locks or start tasks.'}</p>}
  </section>;
}
const statusLabels = {
  clear: ['当前未触发保证金预警', 'No margin warning triggered'], warning: ['保证金触发预警，新增仓位已暂停', 'Margin warning · new exposure blocked'],
  reducing: ['减仓事件正在处理', 'Reduction incident in progress'], recovered: ['保证金已回到恢复线，等待人工复核', 'Margin recovered · review required'],
  blocked: ['风险处理受阻，需要核实原因', 'Risk handling blocked · inspect the cause'], unavailable: ['保证金数据待核实，新增仓位已暂停', 'Margin data unverified · new exposure blocked'],
};
function RiskStatus({ snapshot, fresh, zh, onSaved }: { snapshot: MarginSnapshot | null; fresh: boolean; zh: boolean; onSaved: Props['onSnapshot'] }) {
  const status = fresh && snapshot ? snapshot.status : 'unavailable';
  const confirming = status === 'reducing' && snapshot?.protection?.stage === 'confirming_recovery';
  const detail = !fresh ? (zh ? '数据不可用或已过期；下方旧值仅供参考。' : 'Data unavailable or stale; previous values below are reference only.')
    : snapshot?.reason ? riskReason(snapshot.reason, zh) : status === 'clear' ? (zh ? '这里只反映保证金状态；任务执行情况请查看执行提示与任务详情。' : 'This describes margin only. See execution notices and task details for trading status.')
      : status === 'recovered' ? (zh ? '停止继续减仓不代表恢复交易。复核后只解除保证金增仓锁。' : 'Stopping reduction does not restore trading. Review clears only the margin entry lock.')
        : (zh ? '系统持续核对账户与订单；处理进度和原因会在下方显示。' : 'The system continues to reconcile account and orders; progress and reasons are shown below.');
  return <section className={`risk-status ${status}`} aria-label={zh ? '当前风险状态' : 'Current risk status'}><div className="risk-status-icon" aria-hidden="true">◇</div>
    <div className="risk-status-copy"><h2>{confirming ? (zh ? '保证金恢复核对中' : 'Verifying margin recovery') : statusLabels[status][zh ? 0 : 1]}</h2><p>{detail}</p>
      {!!snapshot?.costAccounting?.pendingBatches && <p>{zh ? '费用明细待对账，已预留约 ' : 'Fee details pending; reserved approximately '}{amount(snapshot.costAccounting.reserved)} USDT</p>}
      {snapshot && ['recovered', 'blocked'].includes(status) && <EntryReview key={`${snapshot.incidentId}:${snapshot.status}:${snapshot.reason}`} snapshot={snapshot} fresh={fresh} zh={zh} onSaved={onSaved} />}</div>
    <div className="risk-health"><span>{zh ? '新增仓位' : 'New exposure'}</span><strong>{!fresh || snapshot?.entryBlocked ? (zh ? '已阻止' : 'Blocked') : !snapshot?.liveEnabled ? (zh ? '实盘锁定' : 'Trading locked') : snapshot.groups.some(g => ['RISK_PAUSED', 'PAUSED'].includes(g.phase)) ? (zh ? '按任务限制' : 'Task restrictions apply') : (zh ? '逐单校验' : 'Checked per order')}</strong><small>{fresh ? (zh ? '数据有效' : 'Fresh data') : (zh ? '等待有效数据' : 'Awaiting data')}</small></div>
  </section>;
}
function EntryReview({ snapshot, fresh, zh, onSaved }: { snapshot: MarginSnapshot; fresh: boolean; zh: boolean; onSaved: Props['onSnapshot'] }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const review = async () => {
    setBusy(true); setMessage('');
    try { onSaved(await riskApi.resume(snapshot.accountId)); setConfirm(false); }
    catch (e) { setMessage(riskReason(e instanceof Error ? e.message : 'risk_request_failed', zh)); }
    finally { setBusy(false); }
  };
  return <div className="risk-review"><button disabled={!fresh || busy} onClick={() => setConfirm(true)}>{zh ? '查看并复核' : 'Review entry lock'}</button>
    {confirm && <div className="risk-notice" role="group" aria-label={zh ? '确认风险复核' : 'Confirm risk review'}><p>{zh ? '请先核实订单与持仓。只有两项保证金恢复条件及服务端核对通过，才能解除增仓锁；其他风险锁和策略状态保持不变。' : 'Reconcile orders and holdings first. Both recovery thresholds and server checks must pass. Other locks and strategy state remain unchanged.'}</p>
      <button disabled={!fresh || busy} onClick={() => void review()}>{zh ? '确认风险已复核，解除新增锁' : 'Reviewed: clear entry lock'}</button><button disabled={busy} onClick={() => setConfirm(false)}>{zh ? '取消' : 'Cancel'}</button></div>}
    {message && <p role="alert">{message}</p>}</div>;
}
function RiskMetrics({ snapshot, fresh, zh }: { snapshot: MarginSnapshot | null; fresh: boolean; zh: boolean }) {
  const m = snapshot?.metrics, p = snapshot?.effectivePolicy;
  return <section className={`risk-metrics ${fresh ? '' : 'stale'}`} aria-label={zh ? '保证金概览' : 'Margin overview'}>
    <article><div className="risk-metric-label"><span>{zh ? '起始保证金率' : 'Initial margin ratio'}</span><small>IMR</small></div><div className="risk-metric-value"><strong>{amount(m?.initialPct)}<em>{m?.initialPct == null ? '' : '%'}</em></strong><span>{zh ? '预警' : 'Warn'} &lt; {p?.initial.warn ?? '—'}%</span></div><footer>{zh ? '低于 100%：交易所自动撤单' : 'Below 100%: exchange cancellations'}</footer></article>
    <article><div className="risk-metric-label"><span>{zh ? '维持保证金率' : 'Maintenance margin ratio'}</span><small>MMR</small></div><div className="risk-metric-value"><strong>{amount(m?.maintenancePct)}<em>{m?.maintenancePct == null ? '' : '%'}</em></strong><span>{zh ? '预警' : 'Warn'} &lt; {p?.maintenance.warn ?? '—'}%</span></div><footer>{zh ? '不高于 100%：存在强平风险' : 'At or below 100%: liquidation risk'}</footer></article>
    <article><div className="risk-metric-label"><span>{zh ? '保证金余额' : 'Margin balance'}</span><small>USDT</small></div><div className="risk-metric-value"><strong>{amount(m?.marginBalance)}</strong></div><footer className="risk-available"><span>{zh ? '可用保证金' : 'Available margin'}</span><b>{amount(m?.availableMargin)}</b></footer></article>
  </section>;
}
function ProtectionSummary({ snapshot, fresh, zh, onSettings }: { snapshot: MarginSnapshot | null; fresh: boolean; zh: boolean; onSettings: () => void }) {
  const copy = protectionCopy(snapshot, fresh, zh), policy = snapshot?.effectivePolicy;
  const debts = snapshot?.metrics?.assets.filter(a => Number(a.liability) > 0) ?? [];
  return <aside className="risk-panel risk-sidebar"><h2>{zh ? '保护与通知' : 'Protection and notifications'}</h2><p className="risk-caption">{zh ? '保护范围、规则和通知，一处查看。' : 'Scope, rules and delivery in one place.'}</p>
    <div className="risk-side-item"><div className="risk-section-heading"><h3>{zh ? '自动减仓范围' : 'Automatic reduction scope'}</h3><button disabled={!snapshot} className="risk-text-button" onClick={onSettings}>{zh ? '管理 ›' : 'Manage ›'}</button></div>
      <strong className={`risk-scope-status ${copy.tone}`}>{copy.title}</strong><p>{copy.detail}</p>
      <p>{snapshot ? snapshot.liveEnabled ? (zh ? '实盘权限已启用' : 'Live permission enabled') : snapshot.continuousProtection?.enabled ? (zh ? '普通交易锁定；持续保护按独立授权执行' : 'Ordinary trading locked; continuous protection has separate authority') : (zh ? '无实盘权限，不执行自动减仓' : 'Trading locked · no automatic reduction') : (zh ? '实盘权限待核实' : 'Live permission unverified')}</p>
      {!!snapshot?.uncoveredSymbols.length && <details><summary>{zh ? `${snapshot.uncoveredSymbols.length} 个合约未被运行中的托管组覆盖` : `${snapshot.uncoveredSymbols.length} contracts outside active managed coverage`}</summary><p>{snapshot.uncoveredSymbols.join(', ')}</p></details>}
      {!!debts.length && <p className="risk-inline-warning">{zh ? '存在币种负债，相关组可能无法形成减仓计划。请查看账户明细。' : 'Currency liabilities may prevent reduction plans for affected groups. Inspect account details.'}</p>}</div>
    <div className="risk-side-item"><div className="risk-section-heading"><h3>{zh ? '保护阈值' : 'Protection thresholds'}</h3><button disabled={!snapshot} className="risk-text-button" onClick={onSettings}>{zh ? '设置 ›' : 'Settings ›'}</button></div>
      <dl className="risk-policy-summary">{(['initial', 'maintenance'] as const).map((key, index) => <div key={key}><dt>{index ? 'MMR' : 'IMR'}</dt><dd>{policy ? `${policy[key].warn} / ${policy[key].reduce} / ${policy[key].recover}%` : '—'}</dd></div>)}</dl><p>{zh ? '依次为：预警 / 减仓 / 停止减仓恢复值' : 'Warning / reduction / recovery target'}</p>
      {snapshot && snapshot.policy.revision !== policy?.revision && <p className="risk-inline-warning">{zh ? '显示当前事件有效阈值；新设置将在事件结束后生效。' : 'Showing active incident thresholds; new settings apply after it ends.'}</p>}</div>
    <RiskNotifications zh={zh} />
  </aside>;
}
function AccountDetails({ snapshot, fresh, zh }: { snapshot: MarginSnapshot | null; fresh: boolean; zh: boolean }) {
  const m = snapshot?.metrics;
  return <details className="risk-panel risk-account-details"><summary><strong>{zh ? '账户负债与保证金明细' : 'Account liabilities and margin details'}</strong><span>{zh ? '按币种查看资金占用' : 'Inspect requirements by currency'}</span></summary>
    {!fresh && <p className="risk-inline-warning">{zh ? '数据不可用或已过期，以下旧值仅供参考。' : 'Data unavailable or stale; previous values are reference only.'}</p>}
    {(snapshot?.units?.length ?? 0) > 1 && <><h3>{zh ? '分所风险单元（不相加）' : 'Independent venue risk units'}</h3><p className="risk-caption">{zh ? '上方显示起始率最低的单元；分所模式仅监控，不自动减仓。' : 'Summary shows the lowest IMR unit. Split-exchange mode is monitoring only.'}</p><div className="risk-table-wrap"><table><thead><tr><th>{zh ? '交易所' : 'Venue'}</th><th>IMR %</th><th>MMR %</th><th>IM</th><th>MM</th></tr></thead><tbody>{snapshot?.units?.map(u => <tr key={u.exchangeType}><td>{u.exchangeType}</td><td>{amount(u.metrics?.initialPct)}</td><td>{amount(u.metrics?.maintenancePct)}</td><td>{amount(u.metrics?.initialMargin)}</td><td>{amount(u.metrics?.maintenanceMargin)}</td></tr>)}</tbody></table></div></>}
    <h3>{zh ? '币种负债与额外保证金占用' : 'Currency liabilities and borrowing margin'}</h3>
    {!m ? <p>{zh ? '账户数据不可用。' : 'Account data unavailable.'}</p> : !m.assets.length ? <p>{zh ? '当前没有币种明细，不能据此推断负债为零。' : 'No currency detail available; this does not establish zero debt.'}</p> : <div className="risk-table-wrap"><table><thead><tr>{(zh ? ['交易所 / 币种', '权益', '负债', '借币起始保证金', '借币维持保证金'] : ['Venue / currency', 'Equity', 'Liability', 'Borrowing IM', 'Borrowing MM']).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{m.assets.map(a => <tr key={`${a.venue}:${a.coin}`}><td>{a.venue} / {a.coin}</td><td>{amount(a.equity)}</td><td className={Number(a.liability) > 0 ? 'risk-debt' : ''}>{amount(a.liability)}</td><td>{amount(a.borrowingInitialMargin)}</td><td>{amount(a.borrowingMaintenanceMargin)}</td></tr>)}</tbody></table></div>}
    <p className="risk-caption">{zh ? '币种明细使用原始币种单位，不能直接相加。保证金无占用显示“—”。' : 'Rows use native currency units and cannot be summed. No requirement displays —.'}</p>
    <p className="risk-caption">{zh ? '距预警静态缓冲' : 'Static warning buffer'}: IMR {amount(m?.initialHeadroom)} USDT · MMR {amount(m?.maintenanceHeadroom)} USDT<br />{zh ? '按保证金占用不变计算，不是固定可承受亏损。' : 'Assumes unchanged requirements; not a fixed loss allowance.'}</p>
  </details>;
}
