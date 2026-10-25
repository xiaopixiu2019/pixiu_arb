import { describe, expect, it } from 'vitest';
import type { AuthenticatedPortfolioSnapshot, TradingSnapshot } from './api.js';
import { groupStrategyPositions, prepareStrategyPositions, prepareExecutionPositionRows, type StrategyPositionRow } from './strategy-positions.js';

function portfolio(
  overrides: Partial<AuthenticatedPortfolioSnapshot> = {},
): AuthenticatedPortfolioSnapshot {
  return {
    dataStatus: 'fresh',
    remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin: '0', marginBalance: '0', initialMargin: '0', maintenanceMargin: '0',
        initialMarginRate: '0', maintenanceMarginRate: '0', positionMode: '', accountMode: '',
        exchangeType: '', remoteUpdatedAt: '2026-07-31T00:00:00.000Z',
      },
      balances: [],
      futuresPositions: [],
      marginPositions: [],
      openOrders: [],
      recentFills: [],
      fetchedAt: '2026-07-31T00:00:00.000Z',
      source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation', createdAt: '2026-07-31T00:00:00.000Z', status: 'clean',
      previousFetchedAt: null, currentFetchedAt: '2026-07-31T00:00:00.000Z', issues: [],
    },
    ...overrides,
  };
}

function tradingSnapshot(positions: TradingSnapshot['positions']): TradingSnapshot {
  return { mode: 'live', positions, orders: [], fills: [], balances: [] };
}

describe('strategy positions', () => {
  it('retains only the account portfolio cache as explicitly stale display evidence', () => {
    const cached = portfolio({ dataStatus: 'stale', remoteStatus: 'unavailable' });
    cached.snapshot.futuresPositions = [{ positionId: 'held', symbol: 'GATE_FUTURE_HYPE_USDT', positionSide: 'LONG',
      quantity: '2', entryPrice: '50', markPrice: '51', value: '102', unrealizedPnl: '2', unrealizedPnlRate: '0',
      initialMargin: '10', maintenanceMargin: '1', leverage: '1', maxLeverage: '20', riskLimit: '1', fee: '0',
      fundingFee: '0', fundingTime: '', createdAt: '', updatedAt: '', realizedPnl: '0' }];
    const before = structuredClone(cached);
    const view = prepareStrategyPositions(cached, tradingSnapshot([]), { retainStalePortfolio: true });
    expect(view.status).toBe('stale'); expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ quantity: 2, rawEntryPrice: '50', rawMarkPrice: '51', marginMode: null });
    expect(cached).toEqual(before);
    expect(prepareStrategyPositions(null, tradingSnapshot([]), { retainStalePortfolio: true })).toEqual({ status: 'unavailable', rows: [] });
    expect(prepareStrategyPositions(portfolio(), tradingSnapshot([]), { retainStalePortfolio: true })).toEqual({ status: 'fresh', rows: [] });
  });
  it('retains missing price evidence without changing the existing numeric model', () => {
    const positions = tradingSnapshot([{ position_id: 'missing', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT',
      quantity: '1', entry_price: '', mark_price: '', realized_pnl: '0', updated_at: '' }]);
    expect(prepareExecutionPositionRows(positions, null)[0]).toMatchObject({
      rawEntryPrice: '', rawMarkPrice: '', entryPrice: 0, markPrice: 0, valueAvailable: false, unrealizedAvailable: false,
    });
  });
  it('does not label an unverified execution cache as fresh', () => {
    expect(prepareStrategyPositions(null,tradingSnapshot([])).status).toBe('stale');
    expect(prepareStrategyPositions(portfolio({dataStatus:'stale'}),tradingSnapshot([])).status).toBe('stale');
  });
  it('does not return rows from an unavailable or stale account snapshot', () => {
    expect(prepareStrategyPositions(null)).toEqual({ status: 'unavailable', rows: [] });
    expect(prepareStrategyPositions(portfolio({ dataStatus: 'stale' }))).toEqual({ status: 'stale', rows: [] });
    expect(prepareStrategyPositions(portfolio({ remoteStatus: 'unavailable' }))).toEqual({ status: 'stale', rows: [] });
  });

  it('maps non-zero fresh futures positions and sorts them by value', () => {
    const snapshot = portfolio();
    snapshot.snapshot.futuresPositions = [
      {
        positionId: 'small', symbol: 'GATE_FUTURE_SKHYNIX_USDT', positionSide: 'SHORT',
        initialMargin: '0', maintenanceMargin: '0', quantity: '-1.3', value: '1546.7',
        unrealizedPnl: '-4.2', unrealizedPnlRate: '0', entryPrice: '1185', markPrice: '1189.77',
        leverage: '3', maxLeverage: '20', riskLimit: '0', fee: '0', fundingFee: '0', fundingTime: '',
        createdAt: '', updatedAt: '', realizedPnl: '0',
      },
      {
        positionId: 'large', symbol: 'BINANCE_FUTURE_SKHY_USDT', positionSide: 'LONG',
        initialMargin: '0', maintenanceMargin: '0', quantity: '20', value: '3187.6',
        unrealizedPnl: '12.5', unrealizedPnlRate: '0', entryPrice: '158', markPrice: '159.38',
        leverage: '5', maxLeverage: '20', riskLimit: '0', fee: '0', fundingFee: '0', fundingTime: '',
        createdAt: '', updatedAt: '', realizedPnl: '0',
      },
      {
        positionId: 'flat', symbol: 'OKX_FUTURE_BTC_USDT', positionSide: 'LONG',
        initialMargin: '0', maintenanceMargin: '0', quantity: '0', value: '0',
        unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '0', markPrice: '0', leverage: '',
        maxLeverage: '20', riskLimit: '0', fee: '0', fundingFee: '0', fundingTime: '',
        createdAt: '', updatedAt: '', realizedPnl: '0',
      },
    ];

    expect(prepareStrategyPositions(snapshot)).toEqual({
      status: 'fresh',
      rows: [
        expect.objectContaining({ id: 'BINANCE:large', asset: 'SKHY', side: 'Long', value: 3187.6, rawEntryPrice: '158', rawMarkPrice: '159.38' }),
        expect.objectContaining({ id: 'GATE:small', asset: 'SKHYNIX', side: 'Short', value: 1546.7, rawEntryPrice: '1185', rawMarkPrice: '1189.77' }),
      ],
    });
  });

  it('shows the execution positions used by the trading page when the portfolio snapshot is empty', () => {
    const snapshot = tradingSnapshot([
      {
        position_id: 'bybit-hype', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT',
        quantity: '100', entry_price: '51.7998', mark_price: '51.768', realized_pnl: '0',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      {
        position_id: 'deribit-hype', symbol: 'DERIBIT_FUTURE_HYPE_USDC', venue: 'DERIBIT',
        quantity: '-100', entry_price: '51.8383', mark_price: '51.818', realized_pnl: '0',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
    ]);

    expect(prepareStrategyPositions(portfolio(), snapshot)).toEqual({
      status: 'fresh',
      rows: [
        expect.objectContaining({ id: 'DERIBIT:deribit-hype', asset: 'HYPE', quote: 'USDC', side: 'Short', quantity: -100, rawMarkPrice: '51.818' }),
        expect.objectContaining({ id: 'BYBIT:bybit-hype', asset: 'HYPE', quote: 'USDT', side: 'Long', quantity: 100, rawMarkPrice: '51.768' }),
      ],
    });
  });

  it('groups same-asset venue legs with the aggregate values used by the trading page', () => {
    const row = (overrides: Partial<StrategyPositionRow>): StrategyPositionRow => ({
      id: 'row', positionId: 'row', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT', asset: 'HYPE', quote: 'USDT', side: 'Long', quantity: 100,
      value: 5_200, entryPrice: 51, markPrice: 52, leverage: '5', unrealizedPnl: 100,
      realizedPnl: 0, fundingFee: 0,
      ...overrides,
    });

    expect(groupStrategyPositions([
      row({ id: 'long', venue: 'BYBIT' }),
      row({ id: 'short', venue: 'DERIBIT', quote: 'USDC', side: 'Short', quantity: -100, value: 5_100, entryPrice: 52, markPrice: 51, unrealizedPnl: 100 }),
    ], {USDC:'1.2'})).toEqual([expect.objectContaining({
      key: 'HYPE-PERP', quantity: 0, grossQuantity: 200, grossNotional: 11_320,
      weightedEntryPrice: 51.5, weightedMarkPrice: 51.5, unrealizedPnl: 220,
      venueCount: 2, fullyHedged: true, leverage: '5',
    })]);
  });

  it('groups SKHY and SKHYNIX as one expandable premium pair', () => {
    const rows: StrategyPositionRow[] = [
      { id: 'adr', positionId: 'adr', symbol: 'GATE_FUTURE_SKHY_USDT', venue: 'GATE', asset: 'SKHY', quote: 'USDT', side: 'Short', quantity: -1, value: 230, entryPrice: 230, markPrice: 229, leverage: '5', unrealizedPnl: 1, realizedPnl: 0, fundingFee: 0 },
      { id: 'local', positionId: 'local', symbol: 'BINANCE_FUTURE_SKHYNIX_USDT', venue: 'BINANCE', asset: 'SKHYNIX', quote: 'USDT', side: 'Long', quantity: 0.1, value: 170, entryPrice: 1700, markPrice: 1710, leverage: '5', unrealizedPnl: 1, realizedPnl: 0, fundingFee: 0 },
    ];

    expect(groupStrategyPositions(rows)).toEqual([expect.objectContaining({
      key: 'SKHY-SKHYNIX-PERP', label: 'SKHY / SKHYNIX', mixedAssets: true,
      legs: rows, grossNotional: 400, unrealizedPnl: 2, fullyHedged: true,
    })]);
  });

  it('groups a Hyperliquid SKHX alias with SKHYNIX positions', () => {
    const rows: StrategyPositionRow[] = [
      { id: 'gate', positionId: 'gate', symbol: 'GATE_FUTURE_SKHYNIX_USDT', venue: 'GATE', asset: 'SKHYNIX', quote: 'USDT', side: 'Long', quantity: 0.1, value: 170, entryPrice: 1700, markPrice: 1710, leverage: '5', unrealizedPnl: 1, realizedPnl: 0, fundingFee: 0 },
      { id: 'hyperliquid', positionId: 'hyperliquid', symbol: 'HYPERLIQUID_FUTURE_SKHX_USDC', venue: 'HYPERLIQUID', asset: 'SKHX', quote: 'USDC', side: 'Short', quantity: -0.1, value: 171, entryPrice: 1710, markPrice: 1700, leverage: '5', unrealizedPnl: 1, realizedPnl: 0, fundingFee: 0 },
    ];

    expect(groupStrategyPositions(rows)).toEqual([expect.objectContaining({
      key: 'SKHY-SKHYNIX-PERP', asset: 'SKHYNIX', label: 'SKHYNIX', mixedAssets: false,
      legs: rows, venueCount: 2, fullyHedged: true,
    })]);
  });

  it('keeps SKHX on other venues separate because aliases are venue-scoped', () => {
    const rows: StrategyPositionRow[] = [
      { id: 'gate-skhx', positionId: 'gate-skhx', symbol: 'GATE_FUTURE_SKHX_USDT', venue: 'GATE', asset: 'SKHX', quote: 'USDT', side: 'Long', quantity: 1, value: 10, entryPrice: 10, markPrice: 10, leverage: '5', unrealizedPnl: 0, realizedPnl: 0, fundingFee: 0 },
      { id: 'gate-skhynix', positionId: 'gate-skhynix', symbol: 'GATE_FUTURE_SKHYNIX_USDT', venue: 'GATE', asset: 'SKHYNIX', quote: 'USDT', side: 'Short', quantity: -1, value: 10, entryPrice: 10, markPrice: 10, leverage: '5', unrealizedPnl: 0, realizedPnl: 0, fundingFee: 0 },
    ];

    expect(groupStrategyPositions(rows).map((group) => group.key)).toEqual([
      'SKHX-PERP',
      'SKHY-SKHYNIX-PERP',
    ]);
  });
});


it.each(['stale', 'unhealthy'])('never enriches liquidation from %s portfolio, even if old PnL is allowed', (status) => {
  const p = portfolio(status === 'stale' ? { dataStatus: 'stale' } : { remoteStatus: 'unavailable' });
  p.snapshot.futuresPositions = [{ positionId: 'p1', symbol: 'BYBIT_FUTURE_HYPE_USDT', positionSide: 'LONG', initialMargin: '10', maintenanceMargin: '1', quantity: '1', value: '100', unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '100', markPrice: '100', leverage: '2', maxLeverage: '20', riskLimit: '1', fee: '0', fundingFee: '0', fundingTime: '', createdAt: '', updatedAt: '', realizedPnl: '0', marginMode: 'ISOLATED', liquidationPrice: '50', liquidationPriceCheckedAt: new Date().toISOString() }];
  const snapshot = tradingSnapshot([{ position_id: 'p1', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT', quantity: '1', entry_price: '100', mark_price: '100', realized_pnl: '0', updated_at: '' }]);
  const row = prepareExecutionPositionRows(snapshot, p, { allowStalePortfolio: true })[0];
  expect(row.marginMode).toBeUndefined();
  expect(row.liquidationPrice).toBeUndefined();
  expect(row.liquidationPriceCheckedAt).toBeUndefined();
});
