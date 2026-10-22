interface StrategyFailure { code: string; label?: string; message?: string }
interface SizeDetail { symbol?: string; quantity?: string; minimum?: string; step?: string; notional?: string }

function detailFrom(label?: string): SizeDetail {
  if (!label) return {};
  try {
    const parsed: unknown = JSON.parse(label);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
      ['symbol', 'quantity', 'minimum', 'step', 'notional'].includes(key) && typeof value === 'string'));
  } catch { return { symbol: label }; }
}

export function strategyErrorMessage(error: StrategyFailure, language: string): string {
  const zh = language === 'zh', detail = detailFrom(error.label);
  if (error.code === 'hyperliquid_price_rules_unavailable') return zh ? 'Hyperliquid 价格规则不可用，已阻止下单；请核实合约 tick。' : 'Hyperliquid price rules are unavailable; the order was blocked. Verify the instrument tick.';
  if (error.code === 'hyperliquid_limit_price_invalid') return zh ? 'Hyperliquid 限价不符合价格步长或有效数字规则，已阻止下单，未自动修改价格。' : 'Hyperliquid limit price violates tick or significant-digit rules. The order was blocked without changing its price.';
  const parts = /^(\w+)_FUTURE_([A-Z0-9]+)_([A-Z]+)$/.exec(detail.symbol ?? '');
  const venues: Record<string, string> = { KRAKEN: 'Kraken', GATE: 'Gate.io', BINANCE: 'Binance', OKX: 'OKX', BYBIT: 'Bybit', HYPERLIQUID: 'Hyperliquid', DERIBIT: 'Deribit' };
  const market = parts ? `${venues[parts[1]] ?? parts[1]} ${parts[2]}` : zh ? '所选交易对' : 'Selected market';
  const quantity = detail.quantity ?? '—', minimum = detail.minimum ?? '—', step = detail.step ?? '—';
  const currency = parts?.[3] ?? '';
  const messages: Record<string, string> = {
    managed_close_target_changed: zh ? '账户或托管归属已变化，本次未发起平仓；请关闭窗口并重新核对。' : 'Account or ownership changed. No close was started; dismiss and review the current task.',
    managed_entry_resume_unverified: zh ? '当前持仓、成交或订单记录未能完整核对，任务继续暂停；没有补仓或平仓。' : 'Holdings, fills or orders could not be fully reconciled. The task stays paused without opening or closing positions.',
    managed_resume_action_changed: zh ? '恢复后的执行方向已变化，请刷新任务后确认；本次未执行恢复。' : 'The resume action changed. Refresh and review the task; it was not resumed.',
    margin_data_stale: zh ? '保证金数据尚未核实或已过期，新增风险已阻止。请查看风险管理页面。' : 'Margin data is unverified or stale. New exposure is blocked; check Risk Management.',
    margin_policy_conflict: zh ? '启动准备期间保护设置已变更，本次任务未启动。请核对最新设置后重新确认。' : 'Protection settings changed during preparation. The task was not started; review the current settings and confirm again.',
    margin_launch_context_changed: zh ? '启动准备期间交易权限或账户上下文已变化，本次任务未启动，请重新确认。' : 'Trading permission or account context changed during preparation. The task was not started; confirm again.',
    margin_protection_scope_full: zh ? '保护名单已达100组，本次任务未启动。请在风险管理页核对并移除不再需要的授权。' : 'The protection list has reached 100 groups. The task was not started; review and remove obsolete grants in Risk Management.',
    margin_entry_blocked: zh ? '账户保证金不足或仍有待复核的风险事件，暂不允许增仓。' : 'Margin is low or an incident requires review. New exposure is blocked.',
    margin_projected_below_warning: zh ? '计入本次下单及在途订单后，预计保证金率将低于预警线。请降低数量或补足保证金。' : 'This order and pending exposure would breach the margin warning threshold. Reduce size or add collateral.',
    margin_account_settlement_pending: zh ? '交易所保证金数据尚未覆盖最近成交，正在等待新数据，不能继续增仓。' : 'Account margin has not yet caught up with the last execution. Await fresh accounting before adding exposure.',
    managed_positions_settlement_pending: zh ? '成交已回报，正在核对交易所持仓更新；尚未确认本批结束。' : 'Fills have been reported; reconciling the exchange position update before completing this batch.',
    margin_no_authorized_groups: zh ? '保证金已触线，但没有可自动减仓的授权托管组。请在保护参数中选择托管组或人工处理。' : 'A threshold was crossed but no eligible group is authorized. Select protection scope or intervene manually.',
    margin_unit_unavailable: zh ? '部分交易所保证金数据不可用，已阻止增仓并继续重试。' : 'Some venue risk data is unavailable. Entry is blocked while reads retry.',
    margin_partial_untradeable: zh ? '减仓部分成交后无法在批次限额内配平，已全局暂停，请核对两腿持仓。' : 'A partial reduction cannot be paired within its batch cap. Trading is paused; reconcile both legs.',
    margin_cancel_exposure_changed: zh ? '撤单期间出现单腿成交，已全局暂停，请核对真实仓位。' : 'A cancellation raced a one-sided fill. Trading is paused; reconcile actual holdings.',
    margin_batch_below_minimum: zh ? '减仓批次数量不足交易所最低要求，需要人工处理。' : 'The bounded reduction batch is below exchange minimums; manual intervention is required.',
    margin_account_changed: zh ? '当前账户已切换，请刷新风险管理页面后重试。' : 'The active account changed. Refresh Risk Management before retrying.',
    margin_recovery_not_confirmed: zh ? '保证金或持仓、订单尚未满足恢复条件，新增锁仍保留。' : 'Margin, positions or orders have not met recovery conditions. The entry lock remains.',
    manual_exit: zh ? '手动平仓请求已生效，正在按退出设置执行。' : 'Manual close is active; execution follows the configured exit settings.',
    exit_in_progress: zh ? '退出已触发，正在分批执行。' : 'Exit is active and is executing in clips.',
    positions_flat: zh ? '已核实两腿清仓，且无未结束订单。' : 'Both legs are confirmed flat with no unfinished orders.',
    managed_exit_quote_unavailable: zh ? '当前退出挂单腿的报价缺失或过期，等待有效报价后继续退出；不需要重复提交平仓。' : 'The exit maker quote is missing or stale. Exit will continue with a valid quote; do not resubmit the close request.',
    managed_existing_position: zh ? '已有仓位；请启用接管平衡旧仓后重新核对。' : 'Existing holdings require explicit adoption.',
    managed_adoption_unbalanced: zh ? '所选两腿旧仓数量不平衡，无法接管并新增建仓。' : 'Existing legs are unbalanced; adoption and entry are blocked.',
    managed_adoption_unknown_order: zh ? '存在无法核实归属或状态的订单，请先处理后再接管。' : 'An order has unknown ownership or state; reconcile it before adoption.',
    managed_adoption_unresolved_orders: zh ? '旧订单尚未确认结束，新增建仓已停止，请核对订单。' : 'Old orders are not confirmed terminal. New entry is blocked pending review.',
    managed_adoption_changed: zh ? '准备期间持仓发生变化，请重新核对后启动。' : 'Holdings changed during preparation; reconcile before retrying.',
    managed_position_owned: zh ? '所选合约正在被其他任务或启动流程控制，暂不能接管。' : 'Another task or launch controls this contract.',
    managed_group_transferred: zh ? '仓位已交接给新的追加任务，请操作当前任务。' : 'Holdings were transferred to the new task; use its controls.',
    managed_group_released: zh ? '此任务已释放或移交仓位控制权，不能恢复；请操作当前任务。' : 'This task no longer owns the positions and cannot resume; use the current task.',
    managed_adoption_interrupted: zh ? '旧任务已停止或需要优先保护，追加建仓已中止。' : 'The original task stopped or requires protection; additional entry was interrupted.',
    managed_account_changed: zh ? '当前账户与任务账户不一致，已阻止操作。' : 'The active account does not match the task; the action is blocked.',
    managed_stop_in_progress: zh ? '正在核实停止结果，请等待当前操作结束。' : 'Stop reconciliation is in progress; wait for its result.',
    managed_restart_position_mismatch: zh ? '重启核对发现仓位与任务记录不符，需人工复核后恢复。' : 'Restart reconciliation found a position mismatch; review before resuming.',
    managed_group_direction_conflict: zh ? '所选方向与已有托管仓位不一致，无法合并接管。' : 'The selected direction conflicts with the managed group.',
    managed_stop_reconcile_failed: zh ? '停止意图已保存，但持仓或订单尚未核实完成，请复核。' : 'Stop intent is saved; positions or orders still require reconciliation.',
    manual_stop_keep: zh ? '仓位保留，自动监控和退出已停止。' : 'Holdings retained; monitoring and automatic exits stopped.',
    managed_account_rechecking: zh ? '账户持仓和挂单正在重新核实；暂不接受新的交易操作。' : 'Account positions and orders are being rechecked; new trading actions are temporarily blocked.',
    managed_global_risk_paused: zh ? '托管持仓已风险暂停，需核对持仓和挂单后明确恢复。' : 'Managed positions are risk paused. Reconcile positions and orders before explicit resume.',
    managed_quote_unavailable: zh ? '退出报价缺失或过期，正在重连；退出条件计时已重置。' : 'Exit quote is missing or stale; reconnecting and resetting confirmation timing.',
    managed_funding_unavailable: zh ? '退出资金费率缺失或过期，正在重取；退出条件计时已重置。' : 'Exit funding is missing or stale; refreshing and resetting confirmation timing.',
    strategy_market_data_unavailable: zh ? '实时行情尚未就绪或已过期，暂不能执行；数量未被判定为不足。' : 'Live quotes are unavailable or stale. Execution is blocked; this is not a quantity rejection.',
    managed_market_data_unavailable: zh ? '实时行情尚未就绪或已过期，无法核实最低交易金额；不会因此扩大减仓数量。' : 'Live quotes are unavailable or stale, so minimum notional cannot be verified. The reduction will not be enlarged.',
    managed_constraints_unavailable: zh ? '交易规则暂不可用，暂不能执行。' : 'Instrument constraints are unavailable. Execution is blocked.',
    managed_order_invalid_quantity: zh ? `数量 ${quantity} 无效，必须大于 0。` : `Quantity ${quantity} is invalid; it must be positive.`,
    managed_order_below_minimum_size: zh ? `数量 ${quantity} 低于最小数量 ${minimum}。` : `Quantity ${quantity} is below the minimum ${minimum}.`,
    managed_order_invalid_lot_size: zh ? `数量 ${quantity} 不符合步长要求，必须是 ${step} 的整数倍。` : `Quantity ${quantity} must be a multiple of the lot size ${step}.`,
    managed_order_below_minimum_notional: zh ? `当前估算金额 ${detail.notional ?? '—'} ${currency}，低于最低 ${minimum} ${currency}。` : `Estimated notional ${detail.notional ?? '—'} ${currency} is below the minimum ${minimum} ${currency}.`,
  };
  return messages[error.code] ? `${market}：${messages[error.code]}` : error.message ?? error.code;
}

export function managedReasonMessage(reason: string, language: string): string {
  if (reason === 'Five consecutive maker quotes were rejected; check credentials, balances, and venue status') return language === 'zh'
    ? '连续五次 Maker 报价被拒绝，已触发风险暂停；请查看任务订单中的具体拒绝原因。'
    : 'Five consecutive maker quotes were rejected; risk paused. Inspect the task orders for the specific rejection reason.';
  if (reason === 'managed_market_data_unavailable') return language === 'zh'
    ? '行情或资金费率数据暂不可用，退出条件计时已重置。'
    : 'Quote or funding data is unavailable. Exit confirmation timing has been reset.';
  const separator = reason.indexOf(':');
  return strategyErrorMessage({ code: separator < 0 ? reason : reason.slice(0, separator),
    label: separator < 0 ? undefined : reason.slice(separator + 1), message: reason }, language);
}
