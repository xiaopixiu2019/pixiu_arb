import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageContext } from './i18n.js';
import { PositionsTable } from './positions-table.js';
import { reportedPositionPrice } from './reported-position-price.js';
import type { PositionTableRow } from './strategy-positions.js';

function row(overrides: Partial<PositionTableRow>): PositionTableRow {
  return {
    id: 'position',
    positionId: 'position',
    symbol: 'BYBIT_FUTURE_HYPE_USDT',
    venue: 'BYBIT',
    asset: 'HYPE',
    quote: 'USDT',
    side: 'Long',
    quantity: 10,
    value: 520,
    entryPrice: 51,
    markPrice: 52,
    leverage: '5',
    unrealizedPnl: 10,
    realizedPnl: 2,
    fundingFee: -0.4,
    crossExAdlRank: '2',
    exchangeAdlRank: '1',
    ...overrides,
  };
}

function priceCells(rows: PositionTableRow[]): string[] {
  const html = renderToStaticMarkup(<LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: key => key, setLanguage: vi.fn() }}>
    <PositionsTable rows={rows} onClose={vi.fn()} />
  </LanguageContext.Provider>);
  const firstRow = html.match(/<tbody><tr[^>]*>([\s\S]*?)<\/tr>/)![1];
  return [...firstRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(5, 7)
    .map(match => match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' '));
}

describe('shared positions table', () => {
  it.each(['', ' ', 'NaN', 'Infinity', '-1', '1e999', '0x10', undefined])('does not disguise invalid raw price %s as numeric zero', raw => {
    const position = row({ rawEntryPrice: raw, rawMarkPrice: raw, entryPrice: 0, markPrice: 0 });
    expect(reportedPositionPrice(position, 'entry')).toBeNull();
    expect(reportedPositionPrice(position, 'mark')).toBeNull();
    expect(priceCells([position])).toEqual(['Unavailable', 'Unavailable']);
  });
  it('preserves full source precision and explicit mark zero', () => {
    expect(reportedPositionPrice(row({ rawMarkPrice: '0' }), 'mark')).toBe('0');
    expect(reportedPositionPrice(row({ rawEntryPrice: '0.00000123456789' }), 'entry')).toBe('0.00000123456789');
    expect(reportedPositionPrice(row({ rawMarkPrice: '1.5e-7' }), 'mark')).toBe('1.5e-7');
    expect(priceCells([row({ rawMarkPrice: '0' })])[1]).toBe('0 USDT');
  });
  it('renders a valid peer leg when the other leg is missing and respects side rather than absolute quantity', () => {
    const positions = [row({ id: 'long', rawMarkPrice: '' }), row({ id: 'short', side: 'Short', quantity: 10, markPrice: 53 })];
    const before = structuredClone(positions);
    const cell = priceCells(positions)[1];
    expect(cell).toContain('Unavailable'); expect(cell).toContain('Short'); expect(cell).toContain('53 USDT');
    expect(positions).toEqual(before);
  });
  it.each(['USDT', 'USDC'])('shows each leg price and its own unit when the short is quoted in %s', quote => {
    const cells = priceCells([row({ id: 'long', entryPrice: 100, markPrice: 101 }),
      row({ id: 'short', positionId: 'short', symbol: `DERIBIT_FUTURE_HYPE_${quote}`, venue: 'DERIBIT', quote,
        side: 'Short', quantity: -10, entryPrice: 110, markPrice: 109 })]);
    expect(cells[0]).toContain('100 USDT'); expect(cells[0]).toContain(`110 ${quote}`);
    expect(cells[1]).toContain('101 USDT'); expect(cells[1]).toContain(`109 ${quote}`);
    for (const cell of cells) { expect(cell).toContain('Long'); expect(cell).toContain('Short'); expect(cell).toContain('BYBIT'); expect(cell).toContain('DERIBIT'); }
  });
  it('identifies different base units instead of displaying a synthetic cross-asset mean', () => {
    const cells = priceCells([row({ asset: 'SKHY', symbol: 'GATE_FUTURE_SKHY_USDT', venue: 'GATE', entryPrice: 100 }),
      row({ id: 'local', positionId: 'local', asset: 'SKHYNIX', symbol: 'BINANCE_FUTURE_SKHYNIX_USDT', venue: 'BINANCE', entryPrice: 900 })]);
    expect(cells[0]).toContain('SKHY'); expect(cells[0]).toContain('SKHYNIX');
    expect(cells[0]).toContain('100 USDT'); expect(cells[0]).toContain('900 USDT');
  });
  it('discloses three price entries and offers expansion rather than selecting two as the whole group', () => {
    const cells = priceCells([row({ id: 'one' }), row({ id: 'two', venue: 'GATE' }), row({ id: 'three', venue: 'DERIBIT' })]);
    for (const cell of cells) { expect(cell).toContain('3'); expect(cell).toContain('Expand'); expect(cell).not.toContain('51 USDT'); }
  });
  it('keeps explicit reported zero distinct from empty source data', () => {
    expect(priceCells([row({ entryPrice: 0, rawEntryPrice: '' })])[0]).toContain('Unavailable');
    expect(priceCells([row({ entryPrice: 0, rawEntryPrice: '0' })])[0]).toContain('0 USDT');
  });
  it('renders the trading-page columns and grouped close action', () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <PositionsTable rows={[
          row({ id: 'long' }),
          row({
            id: 'short', positionId: 'short', symbol: 'DERIBIT_FUTURE_HYPE_USDC', venue: 'DERIBIT',
            quote: 'USDC', side: 'Short', quantity: -10, value: 515, entryPrice: 52, markPrice: 51.5,
          }),
        ]} onClose={vi.fn()} />
      </LanguageContext.Provider>,
    );

    expect(html).toContain('Position notional');
    expect(html).toContain('ADL indicator');
    expect(html).toContain('Realized PnL');
    expect(html).toContain('Funding fee');
    expect(html).toContain('HYPE PERP');
    expect(html).toContain('Close all');
    expect(html).not.toContain('>Close position</button>');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<th>Leverage</th>');
  });
  it('does not offer an action for an unpaired position', () => {
    const html = renderToStaticMarkup(<LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: key => key, setLanguage: vi.fn() }}>
      <PositionsTable rows={[row({})]} onClose={vi.fn()} />
    </LanguageContext.Provider>);
    expect(html).not.toContain('close-position-action');
  });
});
