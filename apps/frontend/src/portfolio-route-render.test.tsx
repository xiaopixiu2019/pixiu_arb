import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPortfolioSnapshot } from './api.js';
import { LanguageContext } from './i18n.js';
import { PortfolioView } from './portfolio-route.js';
import type { ReactNode } from 'react';
import { ManagedCloseReceiptsContext, useManagedCloseReceipts } from './use-managed-close-receipts.js';

function ReceiptSession({ children }: { children: ReactNode }) {
  const receipts = useManagedCloseReceipts([]);
  return <ManagedCloseReceiptsContext.Provider value={receipts}>{children}</ManagedCloseReceiptsContext.Provider>;
}

function portfolio(): AuthenticatedPortfolioSnapshot {
  const timestamp = '2026-08-12T12:00:00.000Z';
  return {
    dataStatus: 'fresh', remoteStatus: 'healthy',
    snapshot: {
      account: {
        availableMargin: '700', marginBalance: '1200', initialMargin: '500', maintenanceMargin: '250',
        initialMarginRate: '2.4', maintenanceMarginRate: '4.8', positionMode: 'SINGLE',
        accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: timestamp,
      },
      balances: [],
      futuresPositions: [{
        positionId: 'position-1', symbol: 'BINANCE_FUTURE_BTC_USDT', positionSide: 'LONG',
        initialMargin: '500', maintenanceMargin: '250', quantity: '0.01', value: '640',
        unrealizedPnl: '20', unrealizedPnlRate: '0.03', entryPrice: '62000', markPrice: '64000',
        leverage: '3', maxLeverage: '20', riskLimit: '1', fee: '0.5', fundingFee: '1.2',
        fundingTime: timestamp, createdAt: timestamp, updatedAt: timestamp, realizedPnl: '4',
        crossExAdlRank: '4', exchangeAdlRank: '3',
      }],
      marginPositions: [], openOrders: [], recentFills: [], fetchedAt: timestamp,
      source: 'gate_crossex_authenticated_rest',
    },
    reconciliation: {
      id: 'reconciliation-1', createdAt: timestamp, status: 'clean', previousFetchedAt: timestamp,
      currentFetchedAt: timestamp, issues: [],
    },
  };
}

describe('portfolio risk rendering', () => {
  it('renders both account-wide rates, their explanations, and the compact ADL signal', () => {
    const html = renderToStaticMarkup(
      <LanguageContext.Provider value={{ language: 'en', theme: 'dark', t: (key) => key, setLanguage: vi.fn() }}>
        <ReceiptSession><PortfolioView
          tradingSnapshot={null}
          balances={{}}
          portfolio={portfolio()}
          accountStream={null}
          tradingMode="readonly"
          onOpenModeDialog={vi.fn()}
          onRefresh={vi.fn(async () => undefined)}
        /></ReceiptSession>
      </LanguageContext.Provider>,
    );

    expect(html).toContain('Current total initial margin ratio');
    expect(html).toContain('240%');
    expect(html).toContain('Above 110%, margin can be transferred out');
    expect(html).toContain('Current total maintenance margin ratio');
    expect(html).toContain('480%');
    expect(html).toContain('At or below 100%, CrossEx force-liquidates positions.');
    expect(html).toContain('Exchange ADL: 4/5 (raw rank 3)');
    expect(html).toContain('CrossEx ADL: 4/5');
    expect(html.match(/adl-signal danger/g)).toHaveLength(1);
    expect(html.match(/class="lit"/g)).toHaveLength(4);
    expect(html).toContain('Current funding APR');
    expect(html).not.toContain('Initial margin basis');
  });
});
