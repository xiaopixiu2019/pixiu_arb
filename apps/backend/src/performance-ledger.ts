import { Decimal } from 'decimal.js';
import type { GateAccountBookRecord, GateTransferRecord } from './crossex-client.js';
import { decimal, type PerformanceFlow } from './performance-math.js';

const ECONOMIC_ENTRIES = new Set(['TRANSACTION', 'TRADING_FEE', 'FUNDING_FEE', 'LIQUIDATION_FEE', 'BANKRUPT_COMPENSATION', 'AUTO_REPAY', 'INTEREST_ISOLATED', 'KRAKEN_CONVERSION']);
export interface ValuedFlow extends PerformanceFlow { id: string; evidence: unknown }
export function ledgerFlows(book: GateAccountBookRecord[], transfers: GateTransferRecord[], from: number, to: number,
  rateAt: (coin: string, at: number) => string | null): ValuedFlow[] {
  if (book.some((r) => !Number.isSafeInteger(Number(r.create_time)) || Number(r.create_time) < 0 || !decimal(r.change))) throw new Error('invalid_ledger');
  const entries = [...new Map(book.map((row) => [row.id, row])).values()].filter((r) => Number(r.create_time) > from && Number(r.create_time) <= to);
  if (transfers.some((t) => t.status === 'PENDING' && t.create_time <= to)) throw new Error('pending_transfer');
  const used = new Set<string>();
  const flows = entries.flatMap((row) => {
    if (ECONOMIC_ENTRIES.has(row.statement_type)) return [];
    if (!['TRANSFER_IN', 'TRANSFER_OUT'].includes(row.statement_type)) throw new Error('unclassified_ledger');
    const incoming = row.statement_type === 'TRANSFER_IN', change = decimal(row.change);
    const matches = transfers.filter((t) => t.status === 'SUCCESS' && t.coin === row.coin
      && (incoming ? t.to_account_type.startsWith('CROSSEX') : t.from_account_type.startsWith('CROSSEX'))
      && Number(row.create_time) >= t.create_time - 30_000 && Number(row.create_time) <= t.update_time + 30_000
      && change?.eq(new Decimal(incoming ? t.actual_receive ?? 'NaN' : t.amount).mul(incoming ? 1 : -1))
      && !used.has(`${t.id}:${incoming}`));
    if (matches.length !== 1) throw new Error('unreconciled_transfer');
    const transfer = matches[0]; used.add(`${transfer.id}:${incoming}`);
    if (transfer.from_account_type.startsWith('CROSSEX') && transfer.to_account_type.startsWith('CROSSEX')) return [];
    const at = Number(row.create_time), rate = rateAt(row.coin, at);
    return [{ id: row.id, at, amount: rate ? new Decimal(row.change).mul(rate).toFixed() : null,
      reason: rate ? null : 'missing_historical_fx', evidence: { book: row, transfer } }];
  });
  for (const t of transfers.filter((t) => t.status === 'SUCCESS' && t.update_time > from && t.update_time <= to)) {
    if ((t.from_account_type.startsWith('CROSSEX') && !used.has(`${t.id}:false`))
      || (t.to_account_type.startsWith('CROSSEX') && !used.has(`${t.id}:true`))) throw new Error('unreconciled_transfer');
  }
  return flows;
}

/** A fixed time window is read to exhaustion. Repeated pages and caps never imply completeness. */
export async function readAllPages<T extends { id: string }>(load: (page: number) => Promise<T[]>, limit = 200): Promise<T[]> {
  const result = new Map<string, T>();
  for (let page = 1; page <= 25; page += 1) {
    const rows = await load(page), previous = result.size;
    for (const row of rows) {
      if (result.has(row.id) && JSON.stringify(result.get(row.id)) !== JSON.stringify(row)) throw new Error('ledger_page_changed');
      result.set(row.id, row);
    }
    if (rows.length < limit) return [...result.values()];
    if (result.size === previous) throw new Error('ledger_pagination_incomplete');
  }
  throw new Error('ledger_pagination_incomplete');
}
