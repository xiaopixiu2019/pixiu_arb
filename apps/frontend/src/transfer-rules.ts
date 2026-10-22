import type { CrossExTransferAccount } from './api.js';

const TRANSFER_ACCOUNTS: CrossExTransferAccount[] = [
  'SPOT',
  'CROSSEX',
  'CROSSEX_BINANCE',
  'CROSSEX_OKX',
  'CROSSEX_GATE',
  'CROSSEX_BYBIT',
  'CROSSEX_KRAKEN',
  'CROSSEX_HYPERLIQUID',
  'CROSSEX_DERIBIT',
];

const USDC_WITHDRAWAL_FEES_TO_GATE_SPOT: Partial<Record<CrossExTransferAccount, string>> = {
  CROSSEX_BINANCE: '0.6',
  CROSSEX_OKX: '0.17',
  CROSSEX_BYBIT: '0.8',
  CROSSEX_GATE: '0.999',
  CROSSEX_HYPERLIQUID: '1',
  CROSSEX_DERIBIT: '5',
};

export function transferAccountsFor(coin: string, accountMode: string | undefined): CrossExTransferAccount[] {
  if (coin === 'USDT' && accountMode !== 'ISOLATED_EXCHANGE') return ['SPOT', 'CROSSEX'];
  return TRANSFER_ACCOUNTS.filter((account) => account !== 'CROSSEX'
    && (coin === 'USDC' || account !== 'CROSSEX_HYPERLIQUID')
    && (coin === 'USDT' || account !== 'CROSSEX_KRAKEN'));
}

export function transferFeeForRoute(
  coin: string,
  from: CrossExTransferAccount,
  to: CrossExTransferAccount,
  fallbackFee: string,
): string {
  if (coin.toUpperCase() !== 'USDC' || to !== 'SPOT') return fallbackFee;
  return USDC_WITHDRAWAL_FEES_TO_GATE_SPOT[from] ?? fallbackFee;
}
