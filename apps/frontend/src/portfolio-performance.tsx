import { useMemo, useState, type ReactNode } from 'react';
import type { PerformanceMetric, PerformanceRange } from '@gate-crossex/shared-types';
import type { AuthenticatedPortfolioSnapshot, TradingSnapshot } from './api.js';
import { useLanguage } from './i18n.js';
import { FieldHelp } from './field-help.js';
import { PerformanceChart } from './performance-chart.js';
import { performanceReason } from './performance-reasons.js';
import { useAccountPerformance } from './use-account-performance.js';
import { useTransactionFees } from './use-transaction-fees.js';
import { feeAmount, feeReason } from './transaction-fee-format.js';
import { prepareStrategyPositions, freshPortfolioMarginBalance } from './strategy-positions.js';
import { calculatePortfolioFundingYield } from './position-funding-yield.js';
import { usePositionFundingOverview } from './use-position-funding-overview.js';
import { useMarginValuation } from './use-margin-valuation.js';
import './portfolio-performance.css';

function amount(metric?: PerformanceMetric, signed = false): string {
  if (metric?.value == null) return '—';
  return Number(metric.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: signed ? 'exceptZero' : 'auto' });
}
function Metric({ title, value, metric, help, children, tone }: {
  title: string; value: string; metric?: PerformanceMetric; help: string; children?: ReactNode; tone?: string;
}) {
  const { language } = useLanguage(), zh = language === 'zh';
  return <article className="performance-kpi"><div className="performance-kpi-label">{title}<FieldHelp label={title}>{help}
    {metric?.from && <p>{new Date(metric.from).toLocaleString(language, { timeZone: 'Asia/Shanghai' })} → {metric.to && new Date(metric.to).toLocaleString(language, { timeZone: 'Asia/Shanghai' })}</p>}</FieldHelp></div>
    <strong className={tone ?? (metric?.value && Number(metric.value) < 0 ? 'negative' : value.startsWith('+') ? 'positive' : '')}>{value}</strong>{children}
    {metric?.reason && <small className="performance-warning">{performanceReason(metric.reason, zh)}</small>}</article>;
}
export function PortfolioPerformance({ profileId, portfolio, tradingSnapshot }: {
  profileId: string | null; portfolio: AuthenticatedPortfolioSnapshot | null; tradingSnapshot: TradingSnapshot | null;
}) {
  const { language, theme } = useLanguage(), zh = language === 'zh';
  const [range, setRange] = useState<PerformanceRange>('30d');
  const { data, error } = useAccountPerformance(profileId, range), fees = useTransactionFees(profileId);
  const positions = useMemo(() => prepareStrategyPositions(portfolio, tradingSnapshot), [portfolio, tradingSnapshot]);
  const symbols = useMemo(() => positions.rows.map((p) => p.symbol), [positions.rows]);
  const funding = usePositionFundingOverview(positions.status === 'fresh' && symbols.length > 0, symbols);
  const valuation = useMarginValuation(profileId, positions.status === 'fresh' && symbols.length > 0);
  const apr = useMemo(() => positions.status === 'fresh' ? calculatePortfolioFundingYield(positions.rows, funding, freshPortfolioMarginBalance(portfolio), valuation) : null, [positions, funding, portfolio, valuation]);
  const pnlHelp = zh ? '净权益变化扣除净外部流入，包含实际费用和浮盈变化；按 UTC+8 日界线。证据不足不计算。' : 'Equity change minus net external inflows, including actual fees and unrealized PnL. UTC+8 days; incomplete evidence prevents calculation.';
  return <>
    {(error || fees.error) && <p role="status" className="performance-warning">{zh ? '统计更新失败，正在重试；已有数值为上次确认值。' : 'Statistics refresh failed; retrying. Showing last confirmed values.'}</p>}
    <section className="performance-kpis" aria-label={zh ? '账户收益概览' : 'Account performance summary'}>
      <Metric title={zh ? '净资产 / USDT' : 'Net assets / USDT'} value={amount(data?.totalEquity)} metric={data?.totalEquity} help={zh ? '当前 CrossEx 账户可核实净权益，不含 Gate 现货，按真实币价换算，负债与浮盈不重复计算。' : 'Verified CrossEx net equity, excluding Gate Spot; observed FX, no double-counting debt or PnL.'}><span>{zh ? '账户净权益' : 'Account net equity'}</span></Metric>
      <Metric title={zh ? '累计收益率' : 'Cumulative return'} value={data?.cumulativeReturn.value == null ? '—' : `${amount(data.cumulativeReturn, true)}%`} metric={data?.cumulativeReturn} help={zh ? `${pnlHelp} 按资金流时间调整的日度 Modified Dietz 收益率逐日连乘；图表周期不重置基准。` : `${pnlHelp} Cash-flow-time-adjusted daily Modified Dietz returns, compounded; chart range does not reset baseline.`}>
        <span>{zh ? '累计收益' : 'Cumulative PnL'} {amount(data?.cumulativeProfit, true)} USDT</span>
        {data?.cumulativeProfit.reason && <small className="performance-warning">{performanceReason(data.cumulativeProfit.reason, zh)}</small>}
        {data?.baselineAt && <small>{zh ? '起算' : 'Since'} {new Date(data.baselineAt).toLocaleDateString(language, { timeZone: 'Asia/Shanghai' })}</small>}</Metric>
      <Metric title={zh ? '当前资金费年化' : 'Current funding APR'} value={apr ? `${apr.aprPercent >= 0 ? '+' : ''}${apr.aprPercent.toFixed(2)}%` : '—'} tone={apr ? apr.aprPercent < 0 ? 'negative' : 'positive' : undefined} help={zh ? '全部持仓按当前资金费率简单年化，除以账户保证金余额；非历史收益年化，不含未来价格盈亏、手续费和滑点。必要数据缺失即不可用。' : 'All-position current funding annualized over account margin; not historical return, excludes future price PnL, fees and slippage. Every leg must have verified data.'}>
        <span>{zh ? '当前费率预估' : 'Current-rate estimate'}</span><small>{apr ? `${zh ? '预计 8h' : 'Est. 8h'} ${apr.expected8h.toFixed(3)} USDT` : zh ? '等待完整持仓、费率与保证金' : 'Waiting for positions, funding and margin'}</small></Metric>
      <Metric title={zh ? '今日收益 / USDT' : 'Today PnL / USDT'} value={amount(data?.todayProfit, true)} metric={data?.todayProfit} help={pnlHelp}><span>UTC+8 · {zh ? '当日持续更新' : 'Updating today'}</span></Metric>
      <Metric title={zh ? '昨日收益 / USDT' : 'Yesterday PnL / USDT'} value={amount(data?.yesterdayProfit, true)} metric={data?.yesterdayProfit} help={pnlHelp}><span>UTC+8 · {zh ? '上一自然日' : 'Previous calendar day'}</span></Metric>
      <Metric title={zh ? '累计交易手续费' : 'Cumulative trading fees'} value={`${feeAmount(fees.data?.total.amount, zh)}${fees.data?.total.amount == null ? '' : ' USDT'}`} help={zh ? '当前账户费用统计起算后已确认的交易费用净额，支出减返佣/退费；不含资金费、利息及划转费。缺失不是零。' : 'Confirmed account net trading fees since fee baseline, charges minus rebates/refunds; excludes funding, interest and transfers. Missing is not zero.'}>
        <span>{zh ? '收益已包含，不重复扣减' : 'Included in PnL; do not deduct twice'}</span>
        {fees.data?.since && <small>{zh ? '起算' : 'Since'} {new Date(fees.data.since).toLocaleDateString(language, { timeZone: 'Asia/Shanghai' })}</small>}
        {fees.data && Boolean(fees.data.total.reason || fees.data.total.pending) && <small className="performance-warning">{fees.data.total.pending ? `${fees.data.total.pending} ${zh ? '项待核对 · ' : 'pending · '}` : ''}{feeReason(fees.data.total.reason, zh)}</small>}</Metric>
    </section>
    <section className="performance-trend terminal-panel"><header><div><p className="eyebrow">{zh ? '收益表现' : 'Account performance'}</p><h2>{zh ? '净资产走势' : 'Net asset trend'}</h2></div><div role="group" aria-label={zh ? '统计周期' : 'Performance range'}>{(['24h', '7d', '30d', 'all'] as const).map((r) => <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>{r === 'all' ? zh ? '全部' : 'All' : r.toUpperCase()}</button>)}</div></header>
      <PerformanceChart points={data?.points ?? []} language={language} theme={theme} /></section>
  </>;
}
