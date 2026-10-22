import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { managedReasonMessage } from './strategy-error-message.js';

export const riskAmount = (value: string | number | null | undefined) => value == null || String(value).trim() === '' || !Number.isFinite(Number(value))
  ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const riskTime = (value: number | null | undefined) => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '—';
export const RISK_FRESHNESS_MS = 5000;
export const riskFresh = (s: MarginSnapshot | null, now: number) => Boolean(s?.fresh && s.accountId && s.metrics && s.status !== 'unavailable'
  && s.sampledAt != null && now >= s.sampledAt && now - s.sampledAt <= RISK_FRESHNESS_MS);
type Copy = { title: string; action: string; label: string; tone: 'green' | 'amber' | 'red' | 'neutral' };
const events: Record<string, [string, string, string, string, string, string, Copy['tone']]> = {
  clear: ['本次检查未触发预警', '没有触发保证金规则；不代表没有风险。', '普通检查', 'No alert at this check', 'No margin rule was triggered. This is not a safety guarantee.', 'Routine', 'neutral'],
  warning: ['保证金触发预警', '已阻止新增仓位，继续监控保证金变化。', '已预警', 'Margin warning', 'New exposure blocked; margin monitoring continues.', 'Warning', 'amber'],
  reduction_triggered: ['保证金达到减仓条件', '等待核实授权与执行条件，尚不代表已成交。', '已触发', 'Reduction threshold crossed', 'Awaiting authorization and execution checks; no fill implied.', 'Triggered', 'amber'],
  reducing: ['减仓事件处理中', '正在核对执行条件与处理进度，成交结果另行确认。', '处理中', 'Reduction incident active', 'Checking execution conditions and progress; fills require confirmation.', 'In progress', 'amber'],
  batch_started: ['开始处理一批减仓', '已登记本批任务，订单与成交结果仍需核实。', '处理中', 'Reduction batch started', 'Batch registered; orders and fills still require reconciliation.', 'In progress', 'amber'],
  batch_completed: ['本批双腿减仓完成', '本批已核对平衡；账户风险是否恢复需另行确认。', '本批完成', 'Paired reduction batch completed', 'Batch balanced; account recovery is checked separately.', 'Batch complete', 'green'],
  recovered: ['保证金已回到恢复线', '已停止继续减仓；增仓仍锁定，等待人工复核。', '待复核', 'Margin recovery confirmed', 'Further reduction stopped; new exposure remains locked pending review.', 'Review needed', 'amber'],
  entry_reviewed: ['已人工复核', '保证金增仓锁已解除；其他交易限制仍单独校验。', '已复核', 'Margin entry lock reviewed', 'Margin entry lock cleared; other trading restrictions still apply.', 'Reviewed', 'green'],
  blocked: ['风险处理需要关注', '自动处理条件未满足，请查看原因并核实当前状态。', '处理受阻', 'Risk handling needs attention', 'Automatic handling conditions are unmet; inspect the reason and current state.', 'Blocked', 'red'],
  protection_blocked: ['自动保护处理受阻', '保留未清风险责任，请核对订单与仓位后处理。', '需处理', 'Automatic protection blocked', 'Unresolved responsibility is retained. Reconcile orders and positions.', 'Action needed', 'red'],
  unavailable: ['保证金数据不可用', '已阻止新增仓位；旧值仅供参考。', '数据中断', 'Margin data unavailable', 'New exposure blocked; previous values are reference only.', 'Unavailable', 'red'],
  policy_updated: ['保护规则已更新', '正在处理的减仓事件保留其原有效阈值与授权范围。', '已保存', 'Protection settings updated', 'Active incidents retain their effective thresholds and scope.', 'Saved', 'neutral'],
};
export function riskEventCopy(kind: string, zh: boolean): Copy {
  const e = events[kind];
  if (!e) return { title: zh ? '其他风险记录' : 'Other risk record', action: zh ? '请展开详情核实原始记录，处理结果未知。' : 'Inspect the original record; outcome unknown.', label: zh ? '查看详情' : 'Inspect', tone: 'neutral' };
  return { title: e[zh ? 0 : 3], action: e[zh ? 1 : 4], label: e[zh ? 2 : 5], tone: e[6] };
}
export function riskReason(reason: string, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    margin_no_authorized_groups: ['尚无符合条件的授权组，无法自动减仓。', 'No eligible authorized group can reduce automatically.'],
    margin_no_executable_plan: ['缺少可执行减仓计划；请核对负债、交易规则、行情和保证金数据。', 'No executable plan. Review debt, trading rules, quotes and margin evidence.'],
    margin_data_stale: ['保证金数据已过期，新增仓位已阻止。', 'Margin data is stale. New exposure is blocked.'],
    margin_projection_parameters_missing: ['借币、扣费池或估值规则尚未核实，自动减仓暂不可规划。', 'Verified borrowing, fee pool and valuation rules are missing.'],
    margin_fee_collection_unavailable: ['费用账务采集尚未就绪，不能确认借币减仓后的结算。', 'Fee accounting collection is unavailable for borrowing settlement verification.'],
    margin_projection_parameters_expired: ['已核实的风险规则已过期，需重新核实。', 'Verified risk rules expired.'],
    margin_projection_account_mismatch: ['风险规则与当前账户不一致，不能用于减仓。', 'Risk rules do not match this account.'],
    margin_projection_pool_unverified: ['结算或扣费资金池尚未核实。', 'Settlement or fee pool is unverified.'],
    margin_projection_invalid_number: ['账户或持仓金额数据不完整，暂不生成减仓计划。', 'Account or position amounts are incomplete; planning is unavailable.'],
    margin_position_calibration_failed: ['持仓保证金与当前交易规则不相容，需核实。', 'Position margin does not reconcile with current trading rules.'],
    margin_projection_evidence_invalid: ['规划数据尚未完整核实，继续等待有效数据。', 'Planning evidence is incomplete; awaiting valid data.'],
    margin_borrowing_calibration_failed: ['借币规则与当前账户保证金读数不一致，暂不下单。', 'Borrowing rules do not reconcile with current account margins.'],
    margin_projection_account_changed: ['规划与账户采样时点不一致，停止下单并重新核实。', 'Planning and account snapshot anchors differ.'],
    margin_projection_account_calibration_failed: ['已核实的保证金项目与账户总额不一致，暂不下单。', 'Verified requirements do not reconcile with the account total.'],
    margin_account_settlement_unverified: ['成交后的仓位或账户状态尚未核实，已暂停新批次，需人工复核。', 'Post-fill position or account state is unverified; new batches are paused for review.'],
    margin_execution_cost_exceeded: ['实际成交成本超过本批预算，已暂停交易，需核对成交。', 'Execution cost exceeded the batch budget; trading paused for review.'],
    margin_fx_depeg_unverified: ['已发现明显汇率偏离，当前估值不可用，暂不使用1:1近似。', 'A material FX deviation was observed and current valuation is unavailable.'],
    margin_projection_position_tier_invalid: ['剩余仓位的风险档位会产生非法保证金需求，停止规划并核实交易规则。', 'The remaining position tier produces invalid margin requirements. Verify trading rules.'],
    margin_borrowing_range_unverified: ['预计负债超出已核实的规则范围，需人工复核。', 'Projected debt exceeds the verified rule range.'],
    margin_borrowing_settlement_unverified: ['减仓后的借币或费用结算未确认，已停止新保护批次，需人工复核。', 'Post-reduction borrowing or fee settlement is unconfirmed; new protection batches are stopped.'],
    margin_collateral_range_unverified: ['预计权益超出已核实的抵押规则范围。', 'Projected equity exceeds the verified collateral range.'],
    margin_projection_no_safe_improvement: ['当前批次无法证明风险安全改善，暂不下单。', 'This batch cannot prove a safe risk improvement.'],
    margin_projection_evidence_changed: ['风险参数已变化，停止新批次并重新核实。', 'Risk parameters changed; new batches require verification.'],
    margin_no_legal_quantity: ['现有预算不足以形成满足两腿交易规则的减仓批次。', 'No paired quantity fits the current budget and trading rules.'],
    margin_projection_market_evidence_unavailable: ['规划所需行情、费率或风险档位证据暂不可用。', 'Planning market, fee or risk-tier evidence is unavailable.'],
    margin_projection_search_limit: ['当前规则跨度超出已验证规划范围，需人工复核。', 'Rule complexity exceeds the verified planning range.'],
    margin_entry_borrowing_projection_unverified: ['账户存在负债，新增风险的借币投影尚未验证；只减仓不受此项限制。', 'Borrowing projection for new exposure is unverified; reduce-only remains separate.'],
    margin_reduction_not_needed: ['当前已达到恢复线，等待订单、持仓和结算核实。', 'Recovery thresholds are reached; awaiting reconciliation.'],
    position_margin_mode_unverified: ['持仓全仓模式尚未核实。', 'Cross-margin position mode is unverified.'],
  };
  return messages[reason]?.[zh ? 0 : 1] ?? managedReasonMessage(reason, zh ? 'zh' : 'en');
}
export function protectionCopy(s: MarginSnapshot | null, fresh: boolean, zh: boolean): { title: string; detail: string; tone: string } {
  if (!s || !fresh) return { title: zh ? '保护状态待核实' : 'Protection unverified', detail: zh ? '等待有效账户数据。' : 'Awaiting fresh account data.', tone: 'amber' };
  if (!s.liveEnabled) return { title: zh ? '未启用实盘执行' : 'Live execution disabled', detail: zh ? '监控仍运行，不执行自动减仓。' : 'Monitoring continues; no automatic reduction.', tone: 'amber' };
  if (s.metrics && s.metrics.accountMode !== 'CROSS_EXCHANGE') return { title: zh ? '分所模式，仅监控' : 'Separate venues: monitoring only', detail: zh ? '当前账户模式不支持自动减仓。' : 'Automatic reduction is unsupported in this mode.', tone: 'amber' };
  const authorized = s.groups.filter(g => g.authorized), eligible = authorized.filter(g => g.eligible);
  if (!authorized.length) return { title: zh ? '未授权自动减仓' : 'Automatic reduction not authorized', detail: zh ? '仅监控与拦截新增；请在保护设置中选择托管组。' : 'Monitoring and entry checks only. Select groups in settings.', tone: 'amber' };
  if (!eligible.length) return { title: zh ? '授权组暂不可执行' : 'Authorized groups cannot execute', detail: zh ? '核对任务状态、控制权与全仓模式。' : 'Check task state, ownership and margin mode.', tone: 'amber' };
  const blocked = eligible.find(g => !g.readiness || g.readiness.status !== 'ready');
  if (blocked) return { title: zh ? '已授权，规划证据待核实' : 'Authorized: planning evidence unverified',
    detail: blocked.readiness?.reason ? riskReason(blocked.readiness.reason, zh) : (zh ? '等待完整规划证据。' : 'Awaiting complete planning evidence.'), tone: 'amber' };
  if (eligible.some(g => g.readiness?.approximate)) return { title: zh ? `${eligible.length} 个授权组可按估算减仓` : `${eligible.length} authorized groups ready for estimated reduction`,
    detail: zh ? '美元计价币种按约1:1估算；逐批核对真实成交与交易所保证金率。' : 'Dollar currencies use approximate parity; fills and exchange margin ratios are checked after each batch.', tone: 'neutral' };
  return { title: zh ? `${eligible.length} 个组已授权且具备资格` : `${eligible.length} eligible authorized groups`, detail: zh ? '触发时仍须核实行情、负债和可执行数量；授权不保证成交。' : 'Quotes, debt and executable size are checked at trigger time; authorization is not a fill guarantee.', tone: 'neutral' };
}
