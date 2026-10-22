import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FundingAssetTag, FundingClassificationSource } from './funding-filter-controls.js';

const t = (value: string) => value;

describe('funding classification controls', () => {
  it('labels equity-linked contracts without implying spot-share ownership', () => {
    const html = renderToStaticMarkup(<FundingAssetTag value="STOCK" t={t} />);

    expect(html).toContain('Stocks');
    expect(html).toContain('Equity-linked perpetual contract; not spot-share ownership');
  });

  it('discloses CoinGecko attribution, snapshot time, and cached state', () => {
    const html = renderToStaticMarkup(<FundingClassificationSource
      classification={{
        source: 'COINGECKO',
        marketCapLimit: 20,
        status: 'stale',
        fetchedAt: '2026-09-05T08:00:00.000Z',
      }}
      language="en"
      t={t}
    />);

    expect(html).toContain('Cached ranking');
    expect(html).toContain('https://www.coingecko.com/en/api');
    expect(html).toContain('Powered by CoinGecko');
  });
});
