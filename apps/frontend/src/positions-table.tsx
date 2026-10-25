import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMarginValuation } from './use-margin-valuation.js';
import { AdlIndicators } from './adl-indicator.js';
import { ExecutionPagination } from './execution-pagination-control.js';
import { executionPageWindow } from './execution-pagination.js';
import { useLanguage } from './i18n.js';
import { marketSymbol } from './market-symbol.js';
import { PositionPriceCell } from './position-prices.js';
import {
  calculatePortfolioFundingYield,
  calculatePositionFundingYield,
  type PositionFundingYield,
} from './position-funding-yield.js';
import { formatAmount, signedAmount, VenueCell, exchanges } from './route-shared.js';
import { groupPositionRows, type PositionTableRow } from './strategy-positions.js';
import { usePositionFundingOverview } from './use-position-funding-overview.js';
import { convertedTotal } from './position-money.js';

interface PositionsTableProps {
  dataStale?: boolean;
  profileId?: string | null;
  rows: readonly PositionTableRow[];
  accountMarginBalance?: number | null;
  onClose: (rows: PositionTableRow[]) => void;
  closeAction?: (rows: PositionTableRow[]) => { disabled: boolean; reason?: string; label?: string; submitted?: boolean };
}

function VenueFromCode({ code }: { code: string }) {
  const exchange = exchanges.find((item) => item.id === code.toLowerCase());
  return <VenueCell id={code.toLowerCase()} name={exchange?.name ?? code} short={exchange?.short ?? code.slice(0, 2)} />;
}

function pnlText(value: number | null, quote: string): string {
  if(value===null)return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)} ${quote}`;
}

function optionalAmount(value: number | null, quote: string): string {
  return value === null ? '—' : `${signedAmount(value)} ${quote}`;
}

function realizedAmount(value: number | null, quote: string): string {
  return value === null ? '—' : `${value.toFixed(2)} ${quote}`;
}

function amountTone(value: number | null): string {
  return value !== null && value > 0 ? 'positive' : value !== null && value < 0 ? 'negative' : '';
}

function fundingPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function expectedFunding(value: number): string {
  const digits = Math.abs(value) >= 1 ? 2 : 3;
  return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(digits)}`;
}

function FundingYieldCell({ value, detail, reportedLeverage, t }: {
  value: PositionFundingYield | null;
  detail: 'group' | 'leg';
  reportedLeverage?: string | null;
  t: (value: string) => string;
}) {
  if (!value) return <td className="funding-yield-cell funding-missing"><strong>—</strong><small>{t('Awaiting fresh funding and margin data')}</small></td>;
  const leverage = reportedLeverage && Number.isFinite(Number(reportedLeverage)) && Number(reportedLeverage) > 0
    ? `${reportedLeverage}×`
    : `≈${value.effectiveLeverage.toFixed(2)}×`;
  const secondary = detail === 'group'
    ? `${t('Est. 8h')} ${expectedFunding(value.expected8h)}`
    : `${leverage} · ${t('Margin')} $${formatAmount(value.initialMargin)}`;
  const explanation = `${t('Current rates projected without compounding; excludes price PnL, fees and slippage')} · ${t('Est. 8h')} ${expectedFunding(value.expected8h)}`;
  return <td className={`funding-yield-cell ${amountTone(value.aprPercent)}`} title={explanation}>
    <strong>{fundingPercent(value.aprPercent)}</strong><small>{secondary}</small>
  </td>;
}

function PortfolioFundingSummary({ value, t }: {
  value: PositionFundingYield | null;
  t: (value: string) => string;
}) {
  const tone = amountTone(value?.aprPercent ?? null);
  return <section className="position-funding-overview" aria-label={t('Position funding outlook')}>
    <div className="position-funding-kpi">
      <span>{t('All positions funding APR')}</span>
      <strong className={tone}>{value ? fundingPercent(value.aprPercent) : '—'}</strong>
      <small>{value ? t('On account margin balance') : t('Awaiting fresh funding and margin data')}</small>
    </div>
    <div className="position-funding-kpi">
      <span>{t('Estimated 8h funding')}</span>
      <strong className={tone}>{value ? expectedFunding(value.expected8h) : '—'}</strong>
      <small>{value ? t('At current rates') : t('All position legs are required')}</small>
    </div>
  </section>;
}

/** The canonical position table shared by Trade, Strategies, and Portfolio. */
export function PositionsTable({ rows, profileId, accountMarginBalance, onClose, closeAction, dataStale = false }: PositionsTableProps) {
  const { t } = useLanguage();
  const observedValuation = useMarginValuation(profileId, rows.length > 0 && !dataStale);
  const valuation = dataStale ? undefined : observedValuation;
  const [page, setPage] = useState(1);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const groups = useMemo(() => groupPositionRows(rows,valuation), [rows,valuation]);
  const fundingOverview = usePositionFundingOverview(rows.length > 0 && !dataStale, rows.map((row) => row.symbol));
  const portfolioFundingYield = useMemo(
    () => calculatePortfolioFundingYield(rows, fundingOverview, accountMarginBalance, valuation),
    [accountMarginBalance, fundingOverview, rows, valuation],
  );
  const window = executionPageWindow(groups.length, page);

  useEffect(() => {
    setPage((current) => executionPageWindow(groups.length, current).page);
  }, [groups.length]);

  return <>
    <PortfolioFundingSummary value={portfolioFundingYield} t={t} />
    <div className="positions-table table-wrap"><table>
      <thead><tr><th>{t('Contract')}</th><th>{t('Exchange')}</th><th>{t('Size')}</th><th>{t('Position notional')}</th><th><span className="funding-yield-heading"><strong>{t('Current funding APR')}</strong></span></th><th>{t('Entry price')}</th><th>{t('Mark price')}</th><th>{t('ADL indicator')}</th><th>{t('Unrealized PnL')}</th><th>{t('Realized PnL')}</th><th>{t('Funding fee')}</th><th>{t('Close position')}</th></tr></thead>
      <tbody>{groups.slice(window.start, window.end).map((group) => {
        if (group.legs.length === 1) {
          const position = group.legs[0];
          const progress = closeAction?.(group.legs);
          const ranks = [{ key: position.id, venue: position.venue, crossExRank: position.crossExAdlRank, exchangeRank: position.exchangeAdlRank }];
          return <tr key={group.key}>
            <td><strong>{marketSymbol(position.asset, position.quote, 'perpetual')}</strong><small className={position.quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(position.quantity >= 0 ? 'Long' : 'Short')}</small></td>
            <td><VenueFromCode code={position.venue} /></td>
            <td>{position.quantity.toFixed(4)} {position.asset}</td>
            <td>{position.valueAvailable===false?'—':`${formatAmount(position.value)} ${position.quote}`}</td>
            <FundingYieldCell value={calculatePositionFundingYield([position], fundingOverview, valuation)} detail="group" reportedLeverage={position.leverage} t={t} />
            <PositionPriceCell rows={[position]} kind="entry" />
            <PositionPriceCell rows={[position]} kind="mark" />
            <td><AdlIndicators ranks={ranks} /></td>
            <td className={position.unrealizedAvailable===false?'':amountTone(position.unrealizedPnl)}>{pnlText(position.unrealizedAvailable===false?null:position.unrealizedPnl, position.quote)}</td>
            <td>{realizedAmount(position.realizedPnl, position.quote)}</td>
            <td className={amountTone(position.fundingFee)}>{optionalAmount(position.fundingFee, position.quote)}</td>
            <td>{progress?.submitted && <span role="status">{progress.label}{progress.reason && <small>{progress.reason}</small>}</span>}</td>
          </tr>;
        }

        const expanded = expandedPosition === group.key;
        const aggregateQuote = 'USDT';
        const realizedPnl = convertedTotal(group.legs,(_,i)=>group.legs[i].realizedPnl,valuation);
        const fundingFee = convertedTotal(group.legs,(_,i)=>group.legs[i].fundingFee,valuation);
        const groupFundingYield = calculatePositionFundingYield(group.legs, fundingOverview, valuation);
        return <Fragment key={group.key}>
          <tr className="aggregate-row">
            <td><button type="button" className={expanded ? 'expand-position expanded' : 'expand-position'} aria-expanded={expanded} aria-label={`${t('Positions')} · ${group.label}`} onClick={() => setExpandedPosition(expanded ? null : group.key)}>›</button><strong>{group.label} PERP</strong><small className={group.fullyHedged ? 'hedged-tag' : group.quantity >= 0 ? 'long-tag' : 'short-tag'}>{t(group.fullyHedged ? 'Hedged' : group.quantity >= 0 ? 'Long' : 'Short')}</small></td>
            <td><span className="venue-group"><strong>{group.venueCount} {t(group.venueCount === 1 ? 'exchange' : 'exchanges')}</strong></span></td>
            <td>{group.mixedAssets ? '—' : `${group.quantity.toFixed(4)} ${group.asset}`}</td>
            <td>{group.grossNotional===null?'—':`${formatAmount(group.grossNotional)} USDT`}</td>
            <FundingYieldCell value={groupFundingYield} detail="group" t={t} />
            <PositionPriceCell rows={group.legs} kind="entry" mixedAssets={group.mixedAssets} groupLabel={group.label}
              expanded={expanded} onToggle={() => setExpandedPosition(expanded ? null : group.key)} />
            <PositionPriceCell rows={group.legs} kind="mark" mixedAssets={group.mixedAssets} groupLabel={group.label}
              expanded={expanded} onToggle={() => setExpandedPosition(expanded ? null : group.key)} />
            <td>—</td>
            <td className={amountTone(group.unrealizedPnl)}>{pnlText(group.unrealizedPnl, aggregateQuote)}</td>
            <td>{realizedAmount(realizedPnl, aggregateQuote)}</td>
            <td className={amountTone(fundingFee)}>{optionalAmount(fundingFee, aggregateQuote)}</td>
            <td><button className="row-action close-position-action" disabled={closeAction?.(group.legs).disabled ?? true}
              title={closeAction?.(group.legs).reason} onClick={() => onClose(group.legs)}>{closeAction?.(group.legs).label ?? t('Close all')}</button>
              {closeAction?.(group.legs).reason && <small>{closeAction(group.legs).reason}</small>}</td>
          </tr>
          {expanded && group.legs.map((position) => <tr className="position-leg" key={position.id}>
            <td><span className="leg-branch">↳</span><strong>{marketSymbol(position.asset, position.quote, 'perpetual')}</strong><small>{t('Venue leg')}</small></td>
            <td><VenueFromCode code={position.venue} /></td>
            <td>{position.quantity.toFixed(4)} {position.asset}</td>
            <td>{position.valueAvailable===false?'—':`${formatAmount(position.value)} ${position.quote}`}</td>
            <FundingYieldCell value={calculatePositionFundingYield([position], fundingOverview, valuation)} detail="leg" reportedLeverage={position.leverage} t={t} />
            <PositionPriceCell rows={[position]} kind="entry" />
            <PositionPriceCell rows={[position]} kind="mark" />
            <td><AdlIndicators ranks={[{ key: position.id, venue: position.venue, crossExRank: position.crossExAdlRank, exchangeRank: position.exchangeAdlRank }]} /></td>
            <td className={position.unrealizedAvailable===false?'':amountTone(position.unrealizedPnl)}>{pnlText(position.unrealizedAvailable===false?null:position.unrealizedPnl, position.quote)}</td>
            <td>{realizedAmount(position.realizedPnl, position.quote)}</td>
            <td className={amountTone(position.fundingFee)}>{optionalAmount(position.fundingFee, position.quote)}</td>
            <td />
          </tr>)}
        </Fragment>;
      })}</tbody>
    </table></div>
    <ExecutionPagination itemCount={groups.length} page={window.page} onPageChange={setPage} />
  </>;
}
