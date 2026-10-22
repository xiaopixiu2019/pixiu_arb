import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FeeDetail, FeeMetric } from '@gate-crossex/shared-types';
import { api } from './api.js';
import { FieldHelp } from './field-help.js';
import { useDialogFocus } from './route-shared.js';
import './transaction-fees.css';
import { feeAmount, feeReason } from './transaction-fee-format.js';

function useFeeDetail(profileId: string | null, taskId: string | null, page: number) {
  const [data, setData] = useState<FeeDetail | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(false);
    let loading = false;
    const refresh = async () => { if (loading) return; loading = true; try {
      const response = await api.transactionFeeDetail(taskId, page, controller.signal);
      if (controller.signal.aborted) return;
      if (response.profileId === profileId && response.taskId === taskId) { setData(response); setError(false); } else { setData(null); setError(true); }
    } catch { if (!controller.signal.aborted) setError(true); } finally { loading = false; } };
    void refresh(); const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileId, taskId, page, retry]);
  return { data, error, refresh: () => setRetry((n) => n + 1) };
}
export function TaskFeeCell({ metric, expanded, onClick, language, stale }: { metric?: FeeMetric; expanded: boolean; onClick(): void; language: string; stale?: boolean }) {
  const zh = language === 'zh';
  return <span className="task-fee-cell"><button type="button" className="task-fee-button" aria-expanded={expanded} aria-label={zh ? '查看任务手续费明细' : 'View task fee details'} onClick={onClick}>
    {feeAmount(metric?.amount, zh)} <small>USDT</small><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button>
    <small className={stale || metric?.status !== 'ready' ? 'fee-pending' : ''}>{stale ? zh ? '上次确认值' : 'Last confirmed' : metric?.pending ? `${metric.pending} ${zh ? '项待核对' : 'pending items'}`
      : metric?.reason ? feeReason(metric.reason, zh) : metric ? zh ? '已确认 · 点击查看明细' : 'Confirmed · view details' : zh ? '等待归属与费用数据' : 'Waiting for attribution'}</small></span>;
}
function FeeBreakdown({ data, zh }: { data: FeeDetail; zh: boolean }) {
  return <>
    <div className="fee-breakdown">{([
      [zh ? '建仓费用' : 'Entry fees', data.entry], [zh ? '平仓费用' : 'Exit fees', data.exit],
      [zh ? '调仓 / 保护' : 'Adjustment / protection', data.adjustment], [zh ? '返佣 / 退费' : 'Rebates / refunds', data.rebates],
      [zh ? '净手续费' : 'Net fees', data.metric.amount],
    ] as const).map(([title, value]) => <div key={title}><span>{title}</span><strong>{feeAmount(value, zh)} <small>USDT</small></strong></div>)}</div>
    {(data.unknown === null || Number(data.unknown) !== 0) && <p className="fee-pending">{zh ? '待分类支出（已包含在净手续费）' : 'Unclassified charges (included in net fees)'}: {feeAmount(data.unknown, zh)} USDT</p>}
    <div className="fee-table-scroll"><table><thead><tr><th>{zh ? '交易所' : 'Venue'}</th><th>{zh ? '费用记录' : 'Fee entries'}</th><th>{zh ? '原币净手续费' : 'Native net fees'}</th><th>{zh ? '折合 USDT' : 'USDT value'}</th><th>{zh ? '数据状态' : 'Data status'}</th></tr></thead>
      <tbody>{data.venues.map((v) => <tr key={`${v.venue}:${v.coin}`}><td>{v.venue}</td><td>{v.count}</td><td>{v.native ?? '—'} {v.coin}</td><td>{feeAmount(v.converted, zh)}</td><td className={v.pending ? 'fee-pending' : ''}>{v.pending ? `${v.pending} ${zh ? '项待核对' : 'pending'}` : zh ? '账本已确认' : 'Ledger confirmed'}</td></tr>)}</tbody></table></div>
  </>;
}
export function TaskFeeDetails({ taskId, profileId, language }: { taskId: string; profileId: string | null; language: string }) {
  const { data, error, refresh } = useFeeDetail(profileId, taskId, 1), [records, setRecords] = useState(false), zh = language === 'zh';
  return <section className="task-fee-details" aria-label={zh ? `手续费明细 ${taskId}` : `Fee details ${taskId}`}>
    <header><strong>{zh ? '手续费明细' : 'Fee details'} · {taskId}</strong><small>{zh ? '仅含已确认部分，不预估未来平仓费用' : 'Confirmed fees only; future exit fees are not estimated'}</small>
      <button type="button" onClick={() => setRecords(true)}>{zh ? '查看原始成交 →' : 'Original fills →'}</button></header>
    {!data && <p role="status">{error ? zh ? '明细暂不可用或归属待核对' : 'Details unavailable or attribution unverified' : zh ? '正在读取费用明细…' : 'Loading fee details…'}{error && <button type="button" onClick={refresh}>{zh ? '重试' : 'Retry'}</button>}</p>}
    {data && <><FeeBreakdown data={data} zh={zh} /><small className="fee-pending">{feeReason(data.metric.reason, zh)}{data.metric.pending ? ` · ${data.metric.pending} ${zh ? '项待核对' : 'pending'}` : ''}</small></>}
    {data && error && <p role="status" className="fee-pending">{zh ? '明细更新失败，显示上次确认值。' : 'Details refresh failed; showing last confirmed values.'}</p>}
    {records && <FeeStatementDialog profileId={profileId} taskId={taskId} language={language} initialView="fills" onClose={() => setRecords(false)} />}
  </section>;
}
function FeeEvidenceTable({ data, fills, language }: { data: FeeDetail; fills: boolean; language: string }) {
  const zh = language === 'zh', time = (at: number) => new Date(at).toLocaleString(language, { timeZone: 'Asia/Shanghai' });
  return <div className="fee-table-scroll fee-evidence-table"><table><thead><tr><th>{zh ? '时间 · UTC+8' : 'Time · UTC+8'}</th><th>{zh ? '交易所 / 记录标识' : 'Venue / record ID'}</th><th>{zh ? '订单标识' : 'Order ID'}</th><th>{zh ? '原币费用' : 'Native fee'}</th><th>{fills ? zh ? '角色 / 成交量' : 'Role / quantity' : zh ? '折算 / 归属' : 'Valuation / attribution'}</th></tr></thead>
    <tbody>{fills ? data.fills.map((f) => <tr key={`${f.venue}:${f.id}`}><td>{time(f.at)}</td><td>{f.venue}<small>{f.id}</small></td><td>{f.orderId}<small>{f.symbol}</small></td><td>{f.fee} {f.coin || '—'}</td><td>{f.role}<small>{f.quantity}</small></td></tr>)
      : data.entries.map((f) => <tr key={f.id}><td>{time(f.at)}</td><td>{f.venue}<small>{f.id}</small></td><td>{f.orderId}</td><td>{f.native} {f.coin}</td><td>{feeAmount(f.converted, zh)} USDT<small>{f.taskId ?? (zh ? '未归属任务' : 'Unassigned')} · {f.rate ?? '—'}</small><small className="fee-pending">{feeReason(f.reason, zh)}</small></td></tr>)}</tbody></table>
    {(fills ? data.fills : data.entries).length === 0 && <p>{zh ? '当前页暂无已取得记录；以覆盖状态为准。' : 'No retrieved records on this page; check coverage status.'}</p>}</div>;
}
export function FeeStatementDialog({ profileId, taskId, language, onClose, initialView = 'ledger' }: { profileId: string | null; taskId: string | null; language: string; onClose(): void; initialView?: 'ledger' | 'fills' }) {
  const [view, setView] = useState(initialView), [page, setPage] = useState(1), zh = language === 'zh';
  const { data, error, refresh } = useFeeDetail(profileId, taskId, page), ref = useDialogFocus(true, onClose);
  const count = data ? view === 'fills' ? data.totalFills : data.totalEntries : 0, pages = Math.max(1, Math.ceil(count / 25));
  return createPortal(<div className="fee-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={zh ? '费用账单' : 'Fee statement'} className="fee-dialog">
    <header><div><h2>{zh ? '费用账单' : 'Fee statement'} {taskId && `· ${taskId}`}</h2><small>{zh ? '当前账户 · 实际费用；不改收益口径' : 'Current account · actual fees; PnL accounting unchanged'}</small></div><button type="button" data-dialog-autofocus aria-label={zh ? '关闭费用账单' : 'Close fee statement'} onClick={onClose}>×</button></header>
    <div className="fee-dialog-tools"><button type="button" aria-pressed={view === 'ledger'} onClick={() => { setView('ledger'); setPage(1); }}>{zh ? '账本费用' : 'Ledger fees'}</button><button type="button" aria-pressed={view === 'fills'} onClick={() => { setView('fills'); setPage(1); }}>{zh ? '原始成交' : 'Original fills'}</button>
      <FieldHelp label={zh ? '费用证据口径' : 'Fee evidence'}>{zh ? '账本借记是支出，贷记是返佣或退费。原始成交仅用于核对归属，不能与账本再次相加。每笔按费用时点附近的可信汇率折算；缺失显示待核对。' : 'Ledger debits are charges; credits are rebates/refunds. Fills reconcile ownership and are never added again. FX uses verified observations near the fee time; missing evidence stays pending.'}</FieldHelp></div>
    {data ? <>{error && <p role="status" className="fee-pending">{zh ? '账单更新失败，显示上次确认值。' : 'Statement refresh failed; showing last confirmed values.'}</p>}<p className="fee-dialog-total">{zh ? '已确认净手续费' : 'Confirmed net fees'} <strong>{feeAmount(data.metric.amount, zh)} USDT</strong><span className="fee-pending">{feeReason(data.metric.reason, zh)}</span></p><FeeEvidenceTable data={data} fills={view === 'fills'} language={language} />
      <footer><span>{zh ? '共' : 'Total'} {count} · {page}/{pages}</span><button type="button" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>{zh ? '上一页' : 'Previous'}</button><button type="button" disabled={page >= pages} onClick={() => setPage((n) => n + 1)}>{zh ? '下一页' : 'Next'}</button></footer></>
      : <p role="status">{error ? zh ? '费用数据暂不可用' : 'Fee details unavailable' : zh ? '正在读取…' : 'Loading…'}{error && <button type="button" onClick={refresh}>{zh ? '重试' : 'Retry'}</button>}</p>}
  </section></div>, document.body);
}
