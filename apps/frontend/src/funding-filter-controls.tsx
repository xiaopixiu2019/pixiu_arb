import type { FundingAssetClass, FundingOverviewResponse } from './api.js';

export type FundingAssetClassFilterValue = 'ALL' | FundingAssetClass;

const ASSET_CLASS_OPTIONS: Array<{ value: FundingAssetClassFilterValue; label: string }> = [
  { value: 'ALL', label: 'All assets' },
  { value: 'STOCK', label: 'Stocks' },
  { value: 'CRYPTO_BLUE_CHIP', label: 'Blue-chip crypto' },
  { value: 'CRYPTO_ALTCOIN', label: 'Altcoins' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNCLASSIFIED', label: 'Unclassified' },
];

const ASSET_CLASS_LABELS: Record<FundingAssetClass, string> = {
  STOCK: 'Stocks',
  CRYPTO_BLUE_CHIP: 'Blue-chip crypto',
  CRYPTO_ALTCOIN: 'Altcoins',
  OTHER: 'Other',
  UNCLASSIFIED: 'Unclassified',
};

function classNameFor(value: FundingAssetClass): string {
  return value.toLowerCase().replaceAll('_', '-');
}

function assetTagTitle(value: FundingAssetClass, label: string, t: (value: string) => string): string {
  if (value === 'STOCK') return t('Equity-linked perpetual contract; not spot-share ownership');
  if (value === 'CRYPTO_BLUE_CHIP') {
    return t('CoinGecko market-cap top 20 excluding stablecoins; classification is not a safety rating');
  }
  return label;
}

export function FundingAssetClassFilter({ value, onChange, t }: {
  value: FundingAssetClassFilterValue;
  onChange: (value: FundingAssetClassFilterValue) => void;
  t: (value: string) => string;
}) {
  return <div className="asset-class-filter" role="group" aria-label={t('Asset class')}>
    <span>{t('Asset class')}</span>
    {ASSET_CLASS_OPTIONS.map((option) => <button
      key={option.value}
      className={value === option.value ? 'selected' : ''}
      aria-pressed={value === option.value}
      onClick={() => onChange(option.value)}
    >{t(option.label)}</button>)}
  </div>;
}

export function FundingAssetTag({ value, t }: {
  value: FundingAssetClass;
  t: (value: string) => string;
}) {
  const label = t(ASSET_CLASS_LABELS[value]);
  const title = assetTagTitle(value, label, t);
  return <em className={`funding-asset-tag ${classNameFor(value)}`} title={title}>{label}</em>;
}

export function FundingClassificationSource({ classification, language, t }: {
  classification: FundingOverviewResponse['classification'] | undefined;
  language: string;
  t: (value: string) => string;
}) {
  const fetchedAt = Date.parse(classification?.fetchedAt ?? '');
  const timestamp = Number.isFinite(fetchedAt)
    ? new Date(fetchedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '—';
  const cached = classification?.status !== 'fresh';
  return <span>
    {t('Blue-chip crypto uses CoinGecko market-cap top 20 excluding stablecoins · refreshed every 4h')}
    {' · '}{t('Ranking at')} {timestamp}{cached ? ` · ${t('Cached ranking')}` : ''}
    {' · '}<a href="https://www.coingecko.com/en/api" target="_blank" rel="noreferrer">{t('Powered by CoinGecko')}</a>
  </span>;
}
