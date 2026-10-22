import { useEffect, useRef, useState } from 'react';
import type { MarginRiskEvent } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { riskApi } from './risk-api.js';
import { riskAmount, riskEventCopy, riskReason, riskTime } from './risk-presentation.js';

const merge = (a: MarginRiskEvent[], b: MarginRiskEvent[]) => [...new Map([...a, ...b].map(e => [e.id, e])).values()].sort((x, y) => y.id - x.id);
type Page = { events: MarginRiskEvent[]; hasMore: boolean; loaded: boolean; generation: number };
function useEvents(accountId: string | null) {
  const [page, setPage] = useState<Page>({ events: [], hasMore: false, loaded: false, generation: 0 });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef(false), paging = useRef(false);
  useEffect(() => {
    active.current = true; let cancelled = false, polling = false;
    const poll = async () => {
      if (!accountId || polling || paging.current) return;
      polling = true;
      try {
        const next = await riskApi.events(accountId);
        if (!cancelled) {
          setPage(old => {
            const overlap = !old.events.length || next.events.some(e => e.id === old.events[0].id);
            return old.loaded && old.events.length > 0 && overlap ? { ...old, events: merge(next.events, old.events) } : { ...next, loaded: true, generation: old.generation + 1 };
          }); setError('');
        }
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : 'risk_request_failed'); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 30000);
    return () => { cancelled = true; active.current = false; clearInterval(timer); };
  }, [accountId]);
  const more = async () => {
    if (!accountId || paging.current || !page.hasMore) return;
    paging.current = true; setBusy(true); const version = page.generation;
    try {
      const next = await riskApi.events(accountId, page.events.at(-1)?.id);
      if (active.current) { setPage(old => version === old.generation ? { ...old, events: merge(old.events, next.events), hasMore: next.hasMore, loaded: true } : old); setError(''); }
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'risk_request_failed'); }
    finally { paging.current = false; if (active.current) setBusy(false); }
  };
  return { ...page, error, busy, more };
}

export function RiskEvents({ accountId }: { accountId: string | null }) {
  const { language } = useLanguage(), zh = language === 'zh';
  const page = useEvents(accountId), [all, setAll] = useState(false);
  const visible = page.events.filter(e => all || e.kind !== 'clear');
  return <section className="risk-panel risk-records" aria-label={zh ? '风险与处理' : 'Risk and actions'}>
    <div className="risk-section-heading"><div><h2>{zh ? '风险与处理' : 'Risk and actions'}</h2><p>{zh ? '看清发生了什么，以及系统采取的措施。' : 'What happened and how the system responded.'}</p></div>
      <div className="risk-tabs" aria-label={zh ? '记录筛选' : 'Event filter'}>{[false, true].map(value => <button key={String(value)} aria-pressed={all === value} onClick={() => setAll(value)}>{value ? (zh ? '全部记录' : 'All records') : (zh ? '重要记录' : 'Important')}</button>)}</div></div>
    {page.error && <p className="risk-notice error" role="alert">{zh ? '记录加载失败，不能据此判断没有风险。' : 'Records could not load; this does not mean no risk.'} {riskReason(page.error, zh)}</p>}
    {!accountId ? <p className="risk-empty">{zh ? '连接账户后查看记录。' : 'Connect an account to view records.'}</p>
      : !page.loaded && !page.error ? <p className="risk-empty">{zh ? '正在读取风险记录…' : 'Loading risk records…'}</p>
        : page.loaded && !visible.length && !page.error ? <div className="risk-empty"><strong>{zh ? '已加载记录中暂无此类事项' : 'No matching items in loaded records'}</strong><p>{zh ? '普通检查可在“全部记录”中查看；更早记录按需加载。' : 'Routine checks are in All records; older records can be loaded below.'}</p></div> : null}
    {!!visible.length && <><div className="risk-event-columns" aria-hidden="true"><span>{zh ? '时间' : 'Time'}</span><span>{zh ? '发生事项 / 系统动作' : 'Event / system action'}</span><span>{zh ? '当时状态' : 'Status then'}</span></div>
      <ol className="risk-events">{visible.map(event => <EventRow key={event.id} event={event} zh={zh} />)}</ol></>}
    <div className="risk-events-footer"><span>{zh ? '历史状态不代表当前仍需处理。' : 'Historical status does not imply current action is needed.'}</span>
      {page.hasMore && <button disabled={page.busy} onClick={() => void page.more()}>{page.busy ? (zh ? '加载中…' : 'Loading…') : (zh ? '加载更早记录' : 'Load older events')}</button>}</div>
  </section>;
}
function EventRow({ event, zh }: { event: MarginRiskEvent; zh: boolean }) {
  const copy = riskEventCopy(event.kind, zh), [open, setOpen] = useState(false), id = `risk-event-${event.id}`;
  return <li><div className="risk-event-row"><time dateTime={Number.isFinite(new Date(event.at).getTime()) ? new Date(event.at).toISOString() : undefined}>{riskTime(event.at)}</time>
    <div className="risk-event-copy"><strong><i className={copy.tone} aria-hidden="true" />{copy.title}</strong><p>{copy.action}</p></div>
    <span className={`risk-badge ${copy.tone}`}>{copy.label}</span><button className="risk-text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{open ? (zh ? '收起' : 'Hide') : (zh ? '详情' : 'Details')} <span aria-hidden="true">{open ? '−' : '›'}</span></button></div>
    {open && <div id={id} className="risk-event-detail"><EventDetail event={event} zh={zh} /></div>}</li>;
}
function EventDetail({ event, zh }: { event: MarginRiskEvent; zh: boolean }) {
  const evidence = event.evidence, policy = evidence?.effectivePolicy;
  return <><h3>{zh ? '当时的指标与依据' : 'Evidence at the time'}</h3>
    {evidence?.metrics ? <p>IMR {riskAmount(evidence.metrics.initialPct)}{evidence.metrics.initialPct == null ? '' : '%'} · MMR {riskAmount(evidence.metrics.maintenancePct)}{evidence.metrics.maintenancePct == null ? '' : '%'}</p> : <p>{zh ? '该记录未附带有效指标，不能据此推断成交或恢复。' : 'No valid metrics attached; execution or recovery cannot be inferred.'}</p>}
    {policy && <p>{zh ? '当时有效阈值（预警 / 减仓 / 恢复）' : 'Effective thresholds (warn / reduce / recover)'}<br />IMR {policy.initial.warn} / {policy.initial.reduce} / {policy.initial.recover}% · MMR {policy.maintenance.warn} / {policy.maintenance.reduce} / {policy.maintenance.recover}%</p>}
    {event.detail !== event.kind && <p>{riskReason(event.detail, zh)}</p>}
    <details><summary>{zh ? '原始记录' : 'Original record'}</summary><p>{event.kind} · v{event.revision}</p><p>{event.detail}</p></details></>;
}
