import type { FeeBinding, FeeBookRow } from './transaction-fee-model.js';
import type { StoredFeeTrade } from './transaction-fee-store.js';

const SHARED_USDT_VENUES = new Set(['GATE', 'BINANCE', 'OKX', 'BYBIT']);

/** Resolve a ledger pool using retained, account-scoped order/fill proof; never rewrite evidence. */
export function resolveFeeBooks(rows: FeeBookRow[], bindings: FeeBinding[], trades: StoredFeeTrade[]): FeeBookRow[] {
  const proofKey = (venue: string, order: string, client: string) => JSON.stringify([venue, order, client]);
  const proofs = new Map<string, Set<string>>();
  for (const trade of trades) {
    if (trade.conflict || !trade.text) continue;
    const key = proofKey(trade.exchange_type, trade.order_id, trade.text);
    const symbols = proofs.get(key) ?? new Set<string>(); symbols.add(trade.symbol); proofs.set(key, symbols);
  }
  const byOrder = new Map<string, FeeBinding[]>();
  for (const binding of bindings) { const group = byOrder.get(binding.order_id) ?? []; group.push(binding); byOrder.set(binding.order_id, group); }
  return rows.map((row) => {
    const symbol = (JSON.parse(row.payload) as { symbol?: string | null }).symbol;
    const possible = byOrder.get(row.order_id) ?? [];
    const candidates = possible.filter((binding) => {
      const symbols = proofs.get(proofKey(binding.venue, binding.order_id, binding.client_order_id));
      return symbols?.size === 1 && (!binding.symbol || symbols.has(binding.symbol)) && (!symbol || symbols.has(symbol));
    });
    if (row.venue !== 'CROSSEX') {
      const exact = possible.find((binding) => binding.venue === row.venue);
      return symbol && exact && !candidates.includes(exact) ? { ...row, conflict: 1 } : row;
    }
    const eligible = candidates.filter((binding) => SHARED_USDT_VENUES.has(binding.venue));
    if (!symbol || row.coin !== 'USDT' || !symbol.endsWith('_USDT') || eligible.length !== 1) return row;
    return { ...row, venue: eligible[0].venue };
  });
}
