import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { GateCrossExPortfolio, GateCrossExTrade } from './crossex-client.js';
import { managedLegs } from './managed-legs.js';
import { pairedQuantities, type ManagedLeg } from './managed-position-model.js';
import { initialManagedState, MANAGED_RECOVERY_WINDOW_MS, readManagedState, writeManagedState, type ManagedState } from './managed-position-store.js';
import { entryOrders, readEntryBudget } from './paired-entry-ledger.js';
import { TradingRuntimeError, type StrategyRecord } from './trading-runtime.js';
import { adoptionBaseline } from './managed-position-adoption.js';

const id = z.string().trim().min(1).max(120);
const signed = z.string().max(32).regex(/^-?\d+(?:\.\d+)?$/);
const leg = z.object({symbol:id, side:z.enum(['BUY','SELL'])}).strict();
export const ReplacementRequest = z.object({
  profileId:id, groupId:id, quantity:signed.refine(v => new Decimal(v).gt(0)),
  legs:z.tuple([leg,leg]), closingOrderIds:z.tuple([id,id]),
  spreadBps:signed, fundingAprPct:signed, condition:z.enum(['OR','AND']),
  durationSeconds:z.number().int().min(1).max(86400),
}).strict();
export type Replacement = z.infer<typeof ReplacementRequest>;
type Trade = Pick<GateCrossExTrade,'transaction_id'|'order_id'|'qty'|'symbol'|'side'|'create_time'|'position_mode'|'position_side'>;
type Review = Pick<NonNullable<ManagedState['protectionReview']>,'before'|'detectedAt'|'protectedAt'>;
function reject(reason: string): never { throw new TradingRuntimeError(reason, 409); }

export function proveReplacementTrades(trades: Trade[], legs: readonly ManagedLeg[], closing: [string,string],
  review: Review, expected: string, now: number): string[] {
  if (closing[0] === closing[1] || ![review.protectedAt,review.detectedAt].every(at => Number.isSafeInteger(at) && at > 0 && at <= now)
    || review.protectedAt < review.detectedAt || !new Decimal(review.before[0]).gt(0)
    || !new Decimal(review.before[0]).eq(review.before[1])) reject('managed_replacement_flat_unverified');
  const scoped = trades.filter(t => legs.some(l => l.symbol === t.symbol));
  if (scoped.some(t => !Number.isSafeInteger(Number(t.create_time)) || Number(t.create_time) <= 0 || Number(t.create_time) > now))
    reject('managed_replacement_fill_time_invalid');
  const closeRows = scoped.filter(t => closing.includes(t.order_id));
  if (!closeRows.length) reject('managed_replacement_close_missing');
  const first = Math.min(...closeRows.map(t => Number(t.create_time)));
  if (first < review.detectedAt - MANAGED_RECOVERY_WINDOW_MS) reject('managed_replacement_close_window_changed');
  const rows = scoped.filter(t => Number(t.create_time) >= first);
  const ids = rows.map(t => t.transaction_id);
  if (ids.some(v => !v) || new Set(ids).size !== ids.length) reject('managed_replacement_fill_identity_invalid');
  for (const [index,l] of legs.entries()) {
    let closed = new Decimal(0), opened = new Decimal(0);
    for (const t of rows.filter(t => t.symbol === l.symbol)) {
      const q = new Decimal(t.qty), at = Number(t.create_time);
      if (!t.order_id || !q.isFinite() || q.lte(0) || t.side !== l.side || t.position_mode !== 'SINGLE' || t.position_side !== 'NONE')
        reject('managed_replacement_fill_conflict');
      if (at <= review.protectedAt) {
        if (t.order_id !== closing[index]) reject('managed_replacement_close_conflict');
        closed = closed.plus(q);
      } else {
        if (closing.includes(t.order_id)) reject('managed_replacement_close_conflict');
        opened = opened.plus(q);
      }
    }
    if (!closed.eq(review.before[index]) || !opened.eq(expected)) reject('managed_replacement_fill_totals_changed');
  }
  return ids.sort();
}

export function replacementSource(db: Database.Database, record: StrategyRecord, request: Replacement) {
  const state = readManagedState(db, record.id), review = state?.protectionReview;
  if (record.accountProfileId !== request.profileId || record.status !== 'PAUSED' || !record.config.management
    || !state || !review || state.phase !== 'RISK_PAUSED' || !state.verified || !state.pauseAfterProtection
    || state.reason !== 'managed_external_reduction' || review.reason !== state.reason
    || state.stopIntent || state.exitRequested || state.protectionIncident || state.marginBatch || state.positionSettlementSince
    || state.makerOrderId || state.pendingOrderId || state.pendingOrderIds.length || state.transferredTo
    || (state.groupId ?? record.id) !== request.groupId
    || ![...review.after,state.leftQuantity,state.rightQuantity,state.maxLeft,state.maxRight].every(q => q === '0'))
    return reject('managed_replacement_source_changed');
  const receipt = db.prepare("SELECT payload_json FROM audit_events WHERE type='managed_external_reduction_protected' AND correlation_id=? AND created_at=?")
    .get(record.id,new Date(review.protectedAt).toISOString()) as {payload_json:string} | undefined;
  const event = receipt && JSON.parse(receipt.payload_json);
  if (event?.strategyId !== record.id || ['before','after','observedReductions'].some(key =>
    JSON.stringify(event[key]) !== JSON.stringify(review[key as 'before'|'after'|'observedReductions'])))
    reject('managed_replacement_flat_receipt_changed');
  const old = managedLegs(record.config);
  if (!old.every((l,i) => request.legs[i].symbol === l.symbol && request.legs[i].side !== l.side))
    reject('managed_replacement_direction_conflict');
  const claims = db.prepare('SELECT symbol,account_id FROM managed_position_claims WHERE strategy_id=?').all(record.id) as {symbol:string;account_id:string}[];
  if (claims.length !== 2 || !old.every(l => claims.some(c => c.account_id === request.profileId && c.symbol === l.symbol))
    || db.prepare('SELECT 1 FROM managed_position_reservations WHERE symbol IN (?,?)').get(old[0].symbol,old[1].symbol))
    reject('managed_replacement_claim_changed');
  const budget = readEntryBudget(db, record.id);
  const orders = entryOrders(db, record.id);
  if ((budget && !budget.released) || orders.some(o => !o.remote_order_id || !['FILLED','CANCELLED'].includes(o.state))
    || db.prepare('SELECT 1 FROM margin_cost_reservations WHERE settled_at IS NULL LIMIT 1').get())
    reject('managed_replacement_unsettled');
  return {state,review};
}

export function replacementPositionEvidence(positions: GateCrossExPortfolio['positions'], request: Replacement, flatAt: number, now: number): string {
  const quantities = pairedQuantities(positions,request.legs);
  if (quantities.some(q => !new Decimal(q).eq(request.quantity))) reject('managed_replacement_holdings_changed');
  return JSON.stringify(request.legs.map(l => {
    const p = positions.find(row => row.symbol === l.symbol && !new Decimal(row.position_qty).isZero())!;
    const created = Number(p.create_time), price = new Decimal(p.entry_price);
    if (p.margin_mode !== 'CROSS' || p.position_side !== 'NONE' || !p.position_id || !price.isFinite() || price.lte(0)
      || !Number.isSafeInteger(created) || created <= flatAt || created > now)
      reject('managed_replacement_position_unverified');
    return [p.symbol,p.position_id,p.create_time,p.position_qty,p.entry_price];
  }));
}

export function commitReplacement(db: Database.Database, donor: StrategyRecord, request: Replacement,
  facts: GateCrossExPortfolio, fills: string[], now: number): string {
  const {state} = replacementSource(db,donor,request);
  const [left,right] = pairedQuantities(facts.positions,request.legs);
  if (facts.openOrders.length || ![left,right].every(q => new Decimal(q).eq(request.quantity))) reject('managed_replacement_holdings_changed');
  const next = 'PAIR-' + randomUUID().replaceAll('-','').slice(0,8).toUpperCase(), at = new Date(now).toISOString();
  const {spreadBps,fundingAprPct,condition,durationSeconds} = request;
  const management = {...donor.config.management!,adoptExisting:true,monitorOnly:true,spreadBps,fundingAprPct,condition,durationSeconds};
  // Older rollback readers require a positive position target. Their persisted MONITORING intent
  // and verified adoption baseline prohibit entry. Current readers expose the zero additional target.
  const stored = {...donor.config, leftSide:request.legs[0].side, rightSide:request.legs[1].side, totalAmount:left, management};
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,progress,filled_quantity,filled_left,filled_right,
    open_position,credential_profile_id,credential_profile_label,created_at,updated_at)
    VALUES (?,'position','live','PAUSED',?,100,'0','0','0',?,?,?,?,?)`).run(next,JSON.stringify(stored),left,request.profileId,donor.accountLabel,at,at);
  const managed: ManagedState = {...initialManagedState(),phase:'RISK_PAUSED',entryIntent:'MONITORING',verified:true,
    groupId:request.groupId, reason:'managed_replacement_reviewed',adoptedAt:at,checkedAt:at,adoptedLeft:left,adoptedRight:right,
    leftQuantity:left,rightQuantity:right,maxLeft:left,maxRight:right,adoptionBaseline:adoptionBaseline(facts.positions,request.legs)};
  db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run(next,request.profileId,JSON.stringify(managed),at);
  writeManagedState(db,donor.id,{...state,phase:'TRANSFERRED',transferredTo:next,conditionSince:null});
  db.prepare("UPDATE execution_strategies SET status='STOPPED',open_position='0',updated_at=?,stopped_at=? WHERE id=?").run(at,at,donor.id);
  if (db.prepare('UPDATE managed_position_claims SET strategy_id=? WHERE account_id=? AND strategy_id=?').run(next,request.profileId,donor.id).changes !== 2)
    reject('managed_replacement_claim_changed');
  db.prepare('INSERT INTO audit_events(id,created_at,type,correlation_id,payload_json) VALUES (?,?,?,?,?)')
    .run(randomUUID(),at,'managed_replacement_verified',next,JSON.stringify({source:donor.id,...request,additionalQuantity:'0',fills}));
  return next;
}
