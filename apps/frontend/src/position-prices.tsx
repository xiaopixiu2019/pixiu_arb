import { useLanguage } from './i18n.js';
import { compactPrice } from './number-format.js';
import type { PositionTableRow } from './strategy-positions.js';
import { reportedPositionPrice, type PriceKind } from './reported-position-price.js';
import './position-prices.css';

interface PositionPriceCellProps {
  rows: readonly PositionTableRow[];
  kind: PriceKind;
  mixedAssets?: boolean;
  groupLabel?: string;
  expanded?: boolean;
  onToggle?: () => void;
}

export function PositionPriceCell({ rows, kind, mixedAssets, groupLabel, expanded, onToggle }: PositionPriceCellProps) {
  const { t } = useLanguage();
  const heading = t(kind === 'entry' ? 'Entry price' : 'Mark price');
  if (rows.length > 2) return <td className="position-price-cell">
    <button type="button" className="position-price-expand" aria-expanded={expanded}
      aria-label={`${groupLabel} · ${heading} · ${t(expanded ? 'Collapse' : 'Expand')}`} onClick={onToggle}>
      {rows.length} {t('leg prices')} · {t(expanded ? 'Collapse' : 'Expand')}
    </button>
  </td>;
  return <td className="position-price-cell">{rows.map(row => {
    const raw = reportedPositionPrice(row, kind);
    const label = `${t(row.side)} · ${row.venue}${mixedAssets ? ` · ${row.asset}` : ''}`;
    return <div className="position-price-line" key={row.id}
      title={`${label} · ${heading}: ${raw === null ? t('Unavailable') : `${raw} ${row.quote}`}`}>
      {rows.length > 1 && <span className="position-price-source">{label} </span>}
      <span className={raw === null ? 'position-price-missing' : 'position-price-value'}>
        {raw === null ? t('Unavailable') : `${compactPrice(Number(raw))} ${row.quote}`}
      </span>
    </div>;
  })}</td>;
}
