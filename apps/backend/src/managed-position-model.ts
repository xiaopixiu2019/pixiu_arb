import { Decimal } from 'decimal.js';
import type { PositionManagementConfig } from '@gate-crossex/shared-types';

export interface ManagedLeg { symbol: string; side: 'BUY' | 'SELL' }
export interface PositionFact { symbol: string; position_side: string; position_qty: string }
export function managedExitSignal(config: PositionManagementConfig, legs: ManagedLeg[],
  quotes: Array<Parameters<typeof freshManagedQuote>[0]>, funding: Array<{ rate8h: string; fetchedAt: number } | null>,
  previous: { conditionSince: number | null; signalReason?: string | null; signalMissingSince?: number | null }, now: number) {
  const missingQuote = quotes.findIndex(quote => !freshManagedQuote(quote, now));
  const missingFunding = funding.findIndex(item => !item || !Number.isFinite(item.fetchedAt) || item.fetchedAt > now
    || now - item.fetchedAt > 60000 || typeof item.rate8h !== 'string' || item.rate8h.trim() === '' || !Number.isFinite(Number(item.rate8h)));
  const valid = missingQuote < 0 && missingFunding < 0;
  const sell = legs[0].side === 'SELL' ? 0 : 1, buy = 1 - sell;
  const spread = valid ? new Decimal(quotes[sell]!.bidPrice).minus(quotes[buy]!.askPrice).div(quotes[buy]!.askPrice).mul(10000).toString() : null;
  const apr = valid ? new Decimal(funding[sell]!.rate8h).minus(funding[buy]!.rate8h).mul(109500).toString() : null;
  const conditionSince = exitCondition(config, spread, apr) ? previous.conditionSince ?? now : null;
  const trigger = conditionSince !== null && now - conditionSince >= config.durationSeconds * 1000;
  const signalReason = missingQuote >= 0 ? `managed_quote_unavailable:${legs[missingQuote].symbol}`
    : missingFunding >= 0 ? `managed_funding_unavailable:${legs[missingFunding].symbol}` : null;
  return { spread, apr, conditionSince, trigger, signalReason,
    signalMissingSince: signalReason ? previous.signalReason ? previous.signalMissingSince ?? now : now : null,
    fundingCheckedAt: valid ? new Date(Math.min(...funding.map(f => f!.fetchedAt))).toISOString() : null };
}
export function pairedQuantities(positions: PositionFact[], legs: ManagedLeg[]): [string, string] {
  const values = legs.map((leg) => {
    const rows = positions.filter((p) => p.symbol === leg.symbol && !new Decimal(p.position_qty).isZero());
    if (rows.length > 1) throw new Error('managed_position_ambiguous');
    if (!rows.length) return '0';
    const row = rows[0];
    let qty = new Decimal(row.position_qty);
    if (!qty.isFinite() || !['LONG', 'SHORT', 'NONE'].includes(row.position_side)) throw new Error('managed_position_invalid');
    if (row.position_side === 'SHORT') qty = qty.abs().neg();
    if (row.position_side === 'LONG') qty = qty.abs();
    if ((qty.gt(0) ? 'BUY' : 'SELL') !== leg.side) throw new Error('managed_position_direction_changed');
    return qty.abs().toString();
  });
  return [values[0], values[1]];
}

export function reductionPlan(left: string, right: string, leftLot: string, rightLot: string): { leg: 'left' | 'right'; quantity: string } | null {
  const a = new Decimal(left), b = new Decimal(right);
  if (a.eq(b)) return null;
  const leg = a.gt(b) ? 'left' : 'right';
  const lot = new Decimal(leg === 'left' ? leftLot : rightLot);
  if (!lot.isFinite() || lot.lte(0)) throw new Error('managed_constraints_unavailable');
  const quantity = a.minus(b).abs().div(lot).ceil().mul(lot);
  if (quantity.gt(Decimal.max(a, b))) throw new Error('managed_untradeable_dust');
  return { leg, quantity: quantity.toString() };
}

export function exitCondition(config: Pick<PositionManagementConfig, 'spreadBps' | 'fundingAprPct' | 'condition'>, spread: string | null, apr: string | null): boolean {
  if (spread === null || apr === null) return false;
  const s = new Decimal(spread).lt(config.spreadBps), f = new Decimal(apr).lt(config.fundingAprPct);
  return config.condition === 'AND' ? s && f : s || f;
}

export function freshManagedQuote(quote: { bidPrice: string; askPrice: string; source: string; updatedAt: string; receivedAt: string; nativeSymbol?: string; nativeValidUntil?: number } | null, now: number): boolean {
  if (!quote || !['gate_crossex_websocket', 'native_venue'].includes(quote.source)) return false;
  if (quote.source === 'native_venue' && (!quote.nativeSymbol || !Number.isFinite(quote.nativeValidUntil) || quote.nativeValidUntil! <= now)) return false;
  const source = Date.parse(quote.updatedAt), received = Date.parse(quote.receivedAt);
  const bid = Number(quote.bidPrice), ask = Number(quote.askPrice);
  return Number.isFinite(source) && Number.isFinite(received) && source <= now + 2000
    && now - source <= 15000 && received - source <= 3000 && received <= now + 2000
    && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;
}
