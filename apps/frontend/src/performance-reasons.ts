export function performanceReason(reason: string | null | undefined, zh: boolean): string {
  if (!reason) return '';
  const messages: Record<string, [string, string]> = {
    account_unavailable: ['等待账户数据', 'Waiting for account data'], account_changed: ['正在核对当前账户', 'Verifying current account'],
    account_identity_missing: ['账户身份未核实', 'Account identity unverified'], waiting_for_baseline: ['等待首份可信快照', 'Waiting for baseline'],
    balance_coverage_missing: ['资产覆盖不完整', 'Incomplete asset coverage'], account_coverage_missing: ['账户覆盖未核实', 'Account coverage unverified'],
    invalid_balances: ['资产数据待核对', 'Invalid asset data'], missing_fx: ['缺少币种换算价格', 'Missing currency valuation'],
    missing_historical_fx: ['缺少资金流时点估值', 'Missing cash-flow valuation'], ledger_unavailable: ['流水暂不可用', 'Ledger unavailable'],
    ledger_incomplete: ['流水覆盖不完整', 'Incomplete ledger coverage'], ledger_pagination_incomplete: ['历史流水未完整取得', 'History pagination incomplete'],
    unclassified_ledger: ['存在待分类的账务变动', 'Unclassified ledger entries'], unreconciled_transfer: ['资金划转尚未对账', 'Unreconciled transfers'],
    pending_transfer: ['存在未确认的划转', 'Pending transfer'], insufficient_day_history: ['统计期不足', 'Insufficient daily history'],
    invalid_ledger: ['流水时间或金额无效', 'Invalid ledger time or amount'], ledger_page_changed: ['分页期间流水发生变化，等待重核', 'Ledger changed while paging; rechecking'],
    ledger_range_unverified: ['流水时间范围未核实', 'Unverified ledger time range'],
    partial_day: ['仅覆盖部分自然日', 'Partial calendar day'], stale_snapshot: ['上次快照 · 等待更新', 'Last snapshot · awaiting update'],
    return_coverage_missing: ['收益率数据不完整', 'Incomplete return data'], invalid_return_basis: ['收益率基准无效', 'Invalid return basis'],
    missing_equity: ['净权益数据缺失', 'Missing equity'],
  };
  return (messages[reason] ?? ['数据待核实', 'Data requires verification'])[zh ? 0 : 1];
}
