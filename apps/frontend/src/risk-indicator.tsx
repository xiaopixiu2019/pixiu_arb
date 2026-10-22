import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { riskFresh } from './risk-presentation.js';
import { riskExecutionStatus } from './risk-execution-status.js';
import { useRiskClock } from './use-risk-clock.js';

export function RiskIndicator({ snapshot, onOpen }: { snapshot: MarginSnapshot | null; onOpen: () => void }) {
  const { language } = useLanguage();
  useRiskClock(snapshot);
  const fresh = riskFresh(snapshot, Date.now());
  const value = fresh && snapshot?.metrics?.initialPct != null ? `${Number(snapshot.metrics.initialPct).toFixed(2)}%` : '—';
  const execution = riskExecutionStatus(snapshot, fresh);
  const blocked = execution.state === 'paused' || execution.state === 'locked';
  const label = execution.paused.length ? (language === 'zh' ? `暂停 ${execution.paused.length}` : `${execution.paused.length} paused`)
    : execution.state === 'locked' ? (language === 'zh' ? '执行锁定' : 'Trading locked') : '';
  const detail = language === 'zh' ? '查看保证金风险与保护状态' : 'View margin risk and protection';
  return <button className={`topbar-navigation-button risk-topbar ${blocked ? 'execution-blocked ' : ''}${fresh ? snapshot?.status : 'unavailable'}`} onClick={onOpen}
    data-execution-state={execution.state}
    title={label ? `${label} · IMR ${value} · ${detail}` : detail} aria-label={label ? `${label} · IMR ${value} · ${detail}` : undefined}>
    <span className="topbar-nav-glyph" aria-hidden="true">◇</span>{label || `IMR ${value}`}</button>;
}
