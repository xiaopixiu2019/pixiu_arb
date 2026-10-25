import type Database from 'better-sqlite3';
import type { GateAccountBookRecord, GateCrossExTrade } from './crossex-client.js';
import { PerformanceStore } from './performance-store.js';
import { feeBookRecord, strictDecimal, type FeeBinding, type FeeBookRow, type FeeEpoch } from './transaction-fee-model.js';
import { resolveFeeBooks } from './transaction-fee-identity.js';
import { pendingFeeEvidence } from './transaction-fee-coverage.js';

export interface StoredFeeTrade extends GateCrossExTrade { conflict: number }
export interface FeeTask { id: string; created_at: string }
export interface PendingFeeOrder { taskId: string; venue: string; orderId: string; quantity: string | null; symbol: string | null; at: number; fromAt?: number; clientOrderId?: string }
export interface FinancialReadScope { taskIds: string[]; symbols: string[] }
export interface FinancialTaskRow { id: string; status: string; created_at: string; stopped_at: string | null; config_json: string;
  state_json: string | null; filled_left: string; filled_right: string; open_position: string }
interface OrderProof { strategy_id: string | null; credential_profile_id: string | null; created_at: string; fee_phase: string | null; strategy_leg: string | null; client_order_id: string; symbol: string; executed_quantity: string; order_created_at: string }
export class TransactionFeeStore {
  constructor(readonly db: Database.Database, readonly scope?: FinancialReadScope,
    private readonly onRateRead?: (coin: string, at: number, rate: string | null) => void) {}
  reportTasks(profile: string): FinancialTaskRow[] {
    const rows=this.db.prepare(`SELECT s.id,s.status,s.created_at,s.stopped_at,s.config_json,s.filled_left,s.filled_right,s.open_position,m.state_json
      FROM execution_strategies s LEFT JOIN managed_positions m ON m.strategy_id=s.id WHERE s.credential_profile_id=?`).all(profile) as FinancialTaskRow[];
    // Keep the canonical account traversal order for transfer members and decimal accumulation.
    const ids=this.scope?new Set(this.scope.taskIds):null;return ids?rows.filter(r=>ids.has(r.id)):rows;
  }
  begin(key: string, profile: string, at: number): FeeEpoch {
    this.db.prepare('INSERT OR IGNORE INTO fee_epochs VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)').run(key, profile, at, at, at);
    return this.epoch(key)!;
  }
  epoch(key: string): FeeEpoch | null { return this.db.prepare('SELECT * FROM fee_epochs WHERE account_key = ?').get(key) as FeeEpoch | undefined ?? null; }
  fail(key: string, kind: 'book' | 'trade', reason: string): void {
    this.db.prepare(kind === 'book' ? 'UPDATE fee_epochs SET book_reason = ? WHERE account_key = ?' : 'UPDATE fee_epochs SET trade_reason = ? WHERE account_key = ?').run(reason, key);
  }
  rates(key: string, at: number, rates: Record<string, string>): void {
    const payload = JSON.stringify(Object.fromEntries(Object.entries(rates).sort(([a], [b]) => a.localeCompare(b))));
    this.db.prepare(`INSERT INTO fee_rates VALUES (?,?,?) ON CONFLICT(account_key,at) DO UPDATE SET payload=excluded.payload
      WHERE payload IS NOT excluded.payload`).run(key, at, payload);
  }
  recheckWindow(key: string, profile: string, index: number): { from: number; to: number } | null {
    const trades = this.trades(key), rows = resolveFeeBooks(this.book(key), this.bindings(key), trades);
    const pending = pendingFeeEvidence(rows, trades, this.coverageOrders(key, profile)).filter((o) => o.at >= this.epoch(key)!.started_at);
    if (!pending.length) return null;
    const order = pending[index % pending.length];
    const times = trades.filter((t) => t.exchange_type === order.venue && t.order_id === order.orderId).map((t) => Number(t.create_time));
    const start = Math.max(this.epoch(key)!.started_at, Math.min(order.fromAt ?? order.at, ...times) - 1000);
    const end = Math.max(start, Math.max(order.at, ...times) + 1000);
    const parts = Math.max(1, Math.ceil((end - start) / 60_000));
    const from = start + (Math.floor(index / pending.length) % parts) * 60_000;
    return { from, to: Math.min(end, from + 60_000) };
  }
  revalueUnpriced(key: string): void {
    const rows = this.book(key).filter((r) => r.usd === null && !r.conflict);
    this.db.transaction(() => { for (const row of rows) {
      const rate = this.rateAt(key, row.coin, row.at);
      if (rate !== null) this.db.prepare('UPDATE fee_book SET usd = ?, rate = ? WHERE account_key = ? AND id = ? AND usd IS NULL AND conflict = 0')
        .run(strictDecimal(row.cost).mul(rate).toFixed(), rate, key, row.id);
    } })();
  }
  rateAt(key: string, coin: string, at: number): string | null {
    const rate = this.lookupRate(key, coin, at); this.onRateRead?.(coin, at, rate); return rate;
  }
  private lookupRate(key: string, coin: string, at: number): string | null {
    if (coin === 'USDT') return '1';
    const rows = this.db.prepare('SELECT payload FROM fee_rates WHERE account_key = ? AND at BETWEEN ? AND ? ORDER BY ABS(at - ?)').all(key, at - 90_000, at + 90_000, at) as Array<{ payload: string }>;
    for (const row of rows) { const rate = (JSON.parse(row.payload) as Record<string, string>)[coin]; if (rate && strictDecimal(rate).gt(0)) return rate; }
    return new PerformanceStore(this.db).rateAt(key, coin, at);
  }
  saveBook(key: string, records: GateAccountBookRecord[], to: number, advanceCoverage = true): void {
    const epoch = this.epoch(key)!;
    const rows = records.filter((r) => r.statement_type === 'TRADING_FEE' && Number(r.create_time) >= epoch.started_at)
      .map((r) => feeBookRecord(r, this.rateAt(key, r.coin, Number(r.create_time))));
    this.db.transaction(() => {
      for (const r of rows) {
        const old = this.db.prepare('SELECT payload FROM fee_book WHERE account_key = ? AND id = ?').get(key, r.id) as { payload: string } | undefined;
        if (old && old.payload !== r.payload) { this.db.prepare('UPDATE fee_book SET conflict = 1 WHERE account_key = ? AND id = ?').run(key, r.id); continue; }
        this.db.prepare('INSERT OR IGNORE INTO fee_book VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)').run(key, r.id, r.at, r.venue, r.order_id, r.coin, r.cost, r.usd, r.rate, r.payload);
        if (r.usd !== null) this.db.prepare('UPDATE fee_book SET usd = ?, rate = ? WHERE account_key = ? AND id = ? AND usd IS NULL AND conflict = 0').run(r.usd, r.rate, key, r.id);
      }
      if (advanceCoverage) this.db.prepare('UPDATE fee_epochs SET covered_to = MAX(covered_to, ?), checked_at = ?, book_reason = NULL WHERE account_key = ?').run(to, to, key);
    })();
    this.revalueUnpriced(key);
  }
  saveTrades(key: string, profile: string, trades: GateCrossExTrade[], to: number, advanceCoverage = true): void {
    this.db.transaction(() => {
      for (const t of trades) {
        const payload = JSON.stringify(t), at = Number(t.create_time);
        if (!Number.isSafeInteger(at) || at < 0 || !t.transaction_id || !t.order_id) throw new Error('invalid_fee_trade');
        strictDecimal(t.fee); strictDecimal(t.qty);
        const old = this.db.prepare('SELECT payload FROM fee_trades WHERE account_key = ? AND venue = ? AND id = ?').get(key, t.exchange_type, t.transaction_id) as { payload: string } | undefined;
        if (old && old.payload !== payload) {
          this.db.prepare('UPDATE fee_trades SET conflict = 1 WHERE account_key = ? AND venue = ? AND id = ?').run(key, t.exchange_type, t.transaction_id);
          this.db.prepare('DELETE FROM fee_order_bindings WHERE account_key = ? AND venue = ? AND order_id IN (?, ?)')
            .run(key, t.exchange_type, t.order_id, (JSON.parse(old.payload) as GateCrossExTrade).order_id);
          continue;
        }
        this.db.prepare('INSERT OR IGNORE INTO fee_trades VALUES (?, ?, ?, ?, ?, 0, ?)').run(key, t.exchange_type, t.transaction_id, t.order_id, at, payload);
        this.bind(key, profile, t);
      }
      const pending = this.db.prepare(`SELECT DISTINCT t.payload FROM fee_trades t JOIN execution_orders e ON e.remote_order_id = t.order_id AND e.venue = t.venue
        LEFT JOIN fee_order_bindings b ON b.account_key=t.account_key AND b.venue=t.venue AND b.order_id=t.order_id
        LEFT JOIN fee_binding_coverage c ON c.account_key=b.account_key AND c.venue=b.venue AND c.order_id=b.order_id
        WHERE t.account_key = ? AND t.conflict = 0 AND (b.order_id IS NULL OR c.symbol IS NULL OR c.quantity IS NULL OR c.order_at IS NULL OR c.quantity <> e.executed_quantity)`)
        .all(key) as Array<{ payload: string }>;
      for (const item of pending) this.bind(key, profile, JSON.parse(item.payload) as GateCrossExTrade);
      if (advanceCoverage) this.db.prepare('UPDATE fee_epochs SET trade_reason = NULL, trades_to = MAX(trades_to, ?) WHERE account_key = ?').run(to, key);
    })();
  }
  private bind(key: string, profile: string, trade: GateCrossExTrade): void {
    if (!trade.text || this.db.prepare('SELECT 1 FROM fee_trades WHERE account_key = ? AND venue = ? AND order_id = ? AND conflict = 1 LIMIT 1').get(key, trade.exchange_type, trade.order_id)) return;
    const matches = this.db.prepare(`SELECT e.strategy_id, s.credential_profile_id, s.created_at, e.fee_phase, e.strategy_leg, e.client_order_id, e.symbol, e.executed_quantity, e.created_at AS order_created_at
      FROM execution_orders e JOIN execution_strategies s ON s.id = e.strategy_id
      WHERE e.remote_order_id = ? AND e.client_order_id = ? AND e.venue = ? AND e.symbol = ?
      AND s.credential_profile_id = ?`)
      .all(trade.order_id, trade.text, trade.exchange_type, trade.symbol, profile) as OrderProof[];
    if (matches.length !== 1 || !matches[0].strategy_id || !Number.isFinite(Date.parse(matches[0].created_at))) return;
    const order = matches[0], phase = ['entry', 'exit', 'adjustment'].includes(order.fee_phase ?? '') ? order.fee_phase : 'unknown';
    this.db.prepare(`INSERT OR IGNORE INTO fee_order_bindings (account_key,venue,order_id,task_id,task_started_at,phase,leg,client_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, trade.exchange_type, trade.order_id, order.strategy_id, Date.parse(order.created_at), phase, order.strategy_leg, order.client_order_id);
    this.db.prepare(`INSERT INTO fee_binding_coverage (account_key,venue,order_id,symbol,quantity,order_at)
      SELECT account_key,venue,order_id,?,?,? FROM fee_order_bindings WHERE account_key=? AND venue=? AND order_id=? AND task_id=? AND client_order_id=?
      ON CONFLICT(account_key,venue,order_id) DO UPDATE SET symbol=excluded.symbol,quantity=excluded.quantity,order_at=excluded.order_at`)
      .run(order.symbol, order.executed_quantity, Date.parse(order.order_created_at), key, trade.exchange_type, trade.order_id, order.strategy_id, order.client_order_id);
  }
  book(key: string): FeeBookRow[] {
    return this.db.prepare(`SELECT * FROM fee_book WHERE account_key = ? ${this.scope ? `AND
      (COALESCE(json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'),'')='' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol') IN (SELECT value FROM json_each(?))
      OR order_id IN (SELECT order_id FROM fee_order_bindings WHERE account_key=? AND task_id IN (SELECT value FROM json_each(?))))` : ''} ORDER BY at,id`)
      .all(...(this.scope ? [key, JSON.stringify(this.scope.symbols), key, JSON.stringify(this.scope.taskIds)] : [key])) as FeeBookRow[];
  }
  trades(key: string): StoredFeeTrade[] {
    return (this.db.prepare(`SELECT payload,conflict FROM fee_trades WHERE account_key=? ${this.scope ? `AND
      (json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol') IN (SELECT value FROM json_each(?)) OR order_id IN
      (SELECT order_id FROM fee_order_bindings WHERE account_key=? AND task_id IN (SELECT value FROM json_each(?))))` : ''} ORDER BY at,id`)
      .all(...(this.scope ? [key, JSON.stringify(this.scope.symbols), key, JSON.stringify(this.scope.taskIds)] : [key])) as Array<{ payload: string; conflict: number }>)
      .map((r) => ({ ...JSON.parse(r.payload) as GateCrossExTrade, conflict: r.conflict }));
  }
  bindings(key: string): FeeBinding[] {
    const rows=this.db.prepare(`SELECT b.*,c.symbol,c.quantity,c.order_at FROM fee_order_bindings b
      LEFT JOIN fee_binding_coverage c ON c.account_key=b.account_key AND c.venue=b.venue AND c.order_id=b.order_id WHERE b.account_key=?`).all(key) as FeeBinding[];
    const ids=this.scope?new Set(this.scope.taskIds):null;return ids?rows.filter(r=>ids.has(r.task_id)):rows;
  }
  tasks(profile: string): FeeTask[] { return this.db.prepare(`SELECT id,created_at FROM execution_strategies WHERE credential_profile_id=?
    ${this.scope ? 'AND id IN (SELECT value FROM json_each(?))' : ''}`)
    .all(...(this.scope ? [profile, JSON.stringify(this.scope.taskIds)] : [profile])) as FeeTask[]; }
  pendingOrders(profile: string): PendingFeeOrder[] {
    const rows = this.db.prepare(`SELECT e.strategy_id AS taskId, e.venue, e.remote_order_id AS orderId, e.executed_quantity AS quantity, e.symbol, e.updated_at AS created_at, e.created_at AS first_at, e.client_order_id AS clientOrderId
      FROM execution_orders e JOIN execution_strategies s ON s.id = e.strategy_id
      WHERE s.credential_profile_id = ? AND CAST(e.executed_quantity AS REAL) > 0
      ${this.scope ? 'AND s.id IN (SELECT value FROM json_each(?))' : ''}`)
      .all(...(this.scope ? [profile, JSON.stringify(this.scope.taskIds)] : [profile])) as Array<Omit<PendingFeeOrder, 'at'> & { created_at: string; first_at: string }>;
    return rows.map(({ created_at, first_at, ...row }) => ({ ...row, at: Date.parse(created_at), fromAt: Date.parse(first_at) }));
  }
  coverageOrders(key: string, profile: string): PendingFeeOrder[] {
    const local = this.pendingOrders(profile), known = new Set(local.map((o) => JSON.stringify([o.venue, o.orderId])));
    const retained = this.bindings(key).filter((b) => !known.has(JSON.stringify([b.venue, b.order_id])));
    return [...local, ...retained.map((b) => ({ taskId: b.task_id, venue: b.venue, orderId: b.order_id,
      quantity: b.quantity ?? null, symbol: b.symbol ?? null, at: b.order_at ?? b.task_started_at, fromAt: b.order_at ?? b.task_started_at, clientOrderId: b.client_order_id }))];
  }
}
