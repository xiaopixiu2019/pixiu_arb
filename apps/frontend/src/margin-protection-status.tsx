import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { riskReason } from './risk-presentation.js';
import { useLanguage } from './i18n.js';
export function MarginProtectionStatus({ snapshot }: { snapshot: MarginSnapshot }) {
  const { language } = useLanguage(), zh = language === 'zh', p = snapshot.protection;
  if (!p) return null;
  const stages: Record<string, string> = zh ? { planning: '规划下一批', pairing: '订单核对与双腿配对',
    settlement_pending: '等待成交后账户结算证据', confirming_recovery: '已达恢复线，等待第二次复核', blocked: '已暂停，需人工复核' }
    : { planning: 'Planning', pairing: 'Reconciling orders and pairing', settlement_pending: 'Awaiting settlement evidence',
      confirming_recovery: 'Recovery confirmation pending', blocked: 'Blocked: review required' };
  return <section className="risk-panel risk-protection-progress" aria-label={zh ? '自动保护进度' : 'Protection progress'}>
    <h2>{p.cause} · {stages[p.stage] ?? p.stage}</h2>
    {p.strategyId && <p>{zh ? '当前托管组' : 'Current managed group'}: {p.strategyId}</p>}
    <p>{zh ? '本批配对减仓量' : 'Paired batch quantity'}: {p.plannedQuantity ?? '—'} · {zh ? '估算恢复总量' : 'Estimated recovery target'}: {p.targetQuantity ?? (zh ? '未知 / 本组不足' : 'Unknown / group insufficient')}</p>
    <p>{zh ? '组资金费年化' : 'Group funding APR'}: {p.apr === null ? '—' : `${Number(p.apr).toFixed(2)}%`} · {zh ? '恢复复核' : 'Recovery observations'}: {p.confirmations}/2</p>
    {p.fallback && <p role="status">{zh ? '收益证据缺失，按保证金占用降险' : 'Yield unavailable: margin-occupancy fallback'}</p>}
    {p.reason && <p role="status">{riskReason(p.reason, zh)}</p>}
    <small>{zh ? '订单核实、本批平衡、账户恢复分别确认；估算不是成交或恢复承诺。' : 'Orders, batch balance and account recovery are verified separately. Estimates are not execution guarantees.'}</small>
  </section>;
}
