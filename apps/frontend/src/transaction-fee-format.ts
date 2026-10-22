import type { FeeMetric } from '@gate-crossex/shared-types';
export function feeReason(reason: string | null | undefined, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    fee_collecting: ['等待费用账本', 'Waiting for fee ledger'], fee_account_unavailable: ['账户未连接', 'Account unavailable'],
    fee_identity_unverified: ['账户身份待核对', 'Account identity unverified'], fee_account_changed: ['正在切换账户', 'Account changed'],
    fee_history_partial: ['历史覆盖不足', 'Partial task history'], fee_partial_day: ['仅覆盖部分自然日', 'Partial calendar day'],
    fee_evidence_pending: ['费用证据待核对', 'Pending fee evidence'], fee_missing_fx: ['缺少费用时点汇率', 'Missing historical FX'],
    fee_stale: ['上次确认值 · 等待更新', 'Last confirmed · awaiting update'], fee_conflicting_evidence: ['回报冲突，待核对', 'Conflicting evidence'],
    fee_trades_unavailable: ['成交归属待核对', 'Fill attribution unavailable'], fee_book_unavailable: ['账本暂不可用', 'Ledger unavailable'],
    fee_range_unverified: ['费用时间范围待核对', 'Unverified fee time range'], ledger_pagination_incomplete: ['费用历史未完整取得', 'Incomplete fee pagination'],
    ledger_page_changed: ['分页记录变动，等待重核', 'History changed; rechecking'],
  };
  return reason ? (messages[reason] ?? ['费用数据待核对', 'Fee data pending verification'])[zh ? 0 : 1] : '';
}
export function feeAmount(value: string | null | undefined, zh: boolean): string {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const amount = number !== 0 && Math.abs(number) < 0.01 ? '<0.01' : Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return number < 0 ? `${zh ? '净返佣' : 'Net rebate'} ${amount}` : amount;
}

export function sumFeeMetrics(metrics: Array<FeeMetric | undefined>): FeeMetric {
  const known = metrics.flatMap((m) => m?.amount === null || m?.amount === undefined ? [] : [m.amount]);
  const scale = Math.max(0, ...known.map((s) => (s.split('.')[1] ?? '').length));
  const sum = known.reduce((total, s) => {
    const negative = s.startsWith('-'), [whole, fraction = ''] = s.replace(/^-/, '').split('.');
    return total + BigInt(whole + fraction.padEnd(scale, '0')) * (negative ? -1n : 1n);
  }, 0n);
  const raw = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0');
  const fraction = scale ? raw.slice(-scale).replace(/0+$/, '') : '';
  const amount = (sum < 0n ? '-' : '') + (scale ? raw.slice(0, -scale) : raw) + (fraction ? '.' + fraction : '');
  const pending = metrics.reduce((n, m) => n + (m?.pending ?? 1), 0), partial = metrics.some((m) => m?.status !== 'ready');
  return { amount: known.length || !partial ? amount : null, status: partial ? known.length ? 'partial' : 'unavailable' : 'ready', pending,
    reason: partial ? 'fee_evidence_pending' : null };
}
