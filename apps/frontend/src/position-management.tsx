import { useId } from 'react';
import { FieldHelp } from './field-help.js';
import type { StrategyRecord } from '@gate-crossex/shared-types';
import type { ManagementDraft } from './position-management-config.js';
import './position-management.css';
import { managedReasonMessage } from './strategy-error-message.js';
import { ManagementExitDetails } from './hedge-execution-summary.js';

export function ManagementSettings({ value, onChange, entryQuantity, language }: {
  value: ManagementDraft; onChange: (value: ManagementDraft) => void; entryQuantity: string; language: string;
}) {
  const settingsId = useId();
  const zh = language === 'zh', label = (cn: string, en: string) => zh ? cn : en;
  const field = (key: keyof ManagementDraft, title: string, placeholder?: string) => <label htmlFor={`${settingsId}-${key}`}>
    <span>{title}<FieldHelp label={title}>{managementExplanation(key, zh)}</FieldHelp></span><input id={`${settingsId}-${key}`} aria-label={title} inputMode="decimal" value={String(value[key])} placeholder={placeholder}
      onChange={(e) => onChange({ ...value, [key]: e.target.value })} /></label>;
  return <fieldset className="position-management-settings" data-management-enabled={value.enabled}>
    <legend><span className="hedge-step-number">02</span>{label('建仓后配置', 'After-entry settings')}</legend>
    <label className="management-toggle"><input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
      <span>{label('持续监控与自动退出', 'Keep monitoring and exit automatically')}</span><FieldHelp label={label('持续监控与自动退出', 'Keep monitoring and exit automatically')}>{managementExplanation('enabled', zh)}<br />{label('确认失衡时优先市价只减仓；手动停止可选择保留或平仓。', 'Confirmed imbalance uses market reduce-only protection, including a full exit. Manual Stop offers keep or close.')}</FieldHelp></label>
    {value.enabled && <>
      <label className="management-toggle"><input type="checkbox" checked={value.adoptExisting === true}
        onChange={(e) => onChange({ ...value, adoptExisting: e.target.checked })} />
        <span>{label('接管所选两腿的平衡旧仓，并统一管理新增仓位', 'Adopt balanced holdings on these two legs and manage additions together')}</span><FieldHelp label={label('接管所选两腿的平衡旧仓，并统一管理新增仓位', 'Adopt balanced holdings on these two legs and manage additions together')}>{managementExplanation('adoptExisting', zh)}<br />{value.adoptExisting ? label('本次数量为新增量；所选两腿的新老仓位统一管理。未知订单阻止启动。', 'This target adds to adopted holdings; rules cover old and new positions. Unknown orders block launch.') : label('只管理本次从空仓建立的两腿，已有仓位会阻止启动。', 'Start from empty legs; existing holdings block launch.')}</FieldHelp></label>
      <div className="management-fields">
        {field('spreadBps', label('价差低于（bps）', 'Spread below (bps)'))}
        {field('fundingAprPct', label('净资金费率年化低于（%）', 'Net funding APR below (%)'))}
        <label htmlFor={`${settingsId}-condition`}><span>{label('触发关系', 'Trigger rule')}<FieldHelp label={label('触发关系', 'Trigger rule')}>{managementExplanation('condition', zh)}</FieldHelp></span><select id={`${settingsId}-condition`} aria-label={label('触发关系', 'Trigger rule')} value={value.condition} onChange={(e) => onChange({ ...value, condition: e.target.value as 'AND' | 'OR' })}>
          <option value="AND">{label('同时满足', 'Both conditions')}</option><option value="OR">{label('任一满足', 'Either condition')}</option></select></label>
        {field('durationSeconds', label('持续时间（秒）', 'Confirmation duration (seconds)'))}
      </div>
      <ManagementExitDetails value={value} zh={zh}>
        <div className="management-fields">
          {field('quantity', label('退出每批数量', 'Exit clip quantity'), entryQuantity || label('沿用建仓数量', 'Use entry quantity'))}
          {field('intervalSeconds', label('批次间隔（秒）', 'Batch interval (seconds)'))}
          {field('makerWaitSeconds', label('挂单等待（秒）', 'Maker wait (seconds)'))}
          <label htmlFor={`${settingsId}-makerLeg`}><span>{label('退出挂单腿', 'Exit maker leg')}<FieldHelp label={label('退出挂单腿', 'Exit maker leg')}>{managementExplanation('makerLeg', zh)}</FieldHelp></span><select id={`${settingsId}-makerLeg`} aria-label={label('退出挂单腿', 'Exit maker leg')} value={value.makerLeg} onChange={(e) => onChange({ ...value, makerLeg: e.target.value as ManagementDraft['makerLeg'] })}>
            <option value="entry">{label('沿用建仓选择', 'Use entry selection')}</option><option value="left">A</option><option value="right">B</option></select></label>
        </div>
        <label className="management-toggle"><input type="checkbox" checked={value.marketFallback} onChange={(e) => onChange({ ...value, marketFallback: e.target.checked })} />
          <span>{label('挂单超时后允许市价分批退出', 'Allow market clips after maker timeout')}</span><FieldHelp label={label('挂单超时后允许市价分批退出', 'Allow market clips after maker timeout')}>{managementExplanation('marketFallback', zh)}</FieldHelp></label>
      </ManagementExitDetails>

    </>}
  </fieldset>;
}
export function ManagedPositionStatus({ strategy, language, tradingMode }: { strategy: StrategyRecord; language: string; tradingMode?: string | null }) {
  const state = strategy.management;
  if (!state) return null;
  const phases = { OPENING: '新增建仓中 · 总仓位保护', VERIFYING: '核对持仓中', MONITORING: '持仓监控中', BALANCING: '市价平衡处理中', EXITING: '分批退出中', RISK_PAUSED: '风险暂停 · 待人工复核', COMPLETED: '清仓完成', STOPPING: '正在停止 · 核对订单', STOPPED: '已停止 · 仓位保留', TRANSFERRED: '已交接给追加任务' };
  const zh = language === 'zh';
  const observingSignals = state.phase === 'MONITORING' || state.phase === 'OPENING';
  const displayedReason = state.phase === 'COMPLETED' ? 'positions_flat'
    : !observingSignals && /^(managed_quote_unavailable|managed_funding_unavailable)(:|$)/.test(state.reason ?? '') ? null : state.reason;
  const number = (v: string | null, suffix = '') => v === null ? '—' : `${Number(v).toFixed(2)}${suffix}`;
  return <details className="managed-position-status"><summary>{state.reason === 'managed_account_rechecking'
    ? (zh ? '账户核实中 · 暂停新交易' : 'Rechecking account · new trades blocked')
    : tradingMode !== undefined && tradingMode !== 'live' && !['COMPLETED', 'STOPPED', 'TRANSFERRED'].includes(state.phase)
    ? (zh ? '等待恢复交易权限' : 'Awaiting live reactivation') : zh ? phases[state.phase] : state.phase}</summary>
    <span>{zh ? phases[state.phase] : state.phase}</span>
    <span>A {state.leftQuantity ?? '—'} / B {state.rightQuantity ?? '—'} {strategy.config.asset}</span>
    {state.adoptedLeft !== undefined && <span>{zh ? '接管' : 'Adopted'}: {state.adoptedLeft} / {state.adoptedRight} · {zh ? '本次成交' : 'Entry fills'}: {strategy.filledLeft} / {strategy.filledRight}</span>}
    {state.phase === 'STOPPED' && <span>{zh ? '自动监控和退出已停止，仓位仍有市场风险。' : 'Monitoring and automatic exits are stopped; holdings remain exposed.'}</span>}
    {state.transferredTo && <span>{zh ? '当前任务' : 'Current task'}: {state.transferredTo}</span>}
    <span>{zh ? '未对冲' : 'Unhedged'}: {state.leftQuantity === null || state.rightQuantity === null ? '—' : Math.abs(Number(state.leftQuantity) - Number(state.rightQuantity))}</span>
    {observingSignals && <span>{number(state.spreadBps, ' bps')} · {number(state.fundingAprPct, '% APR')}</span>}
    {observingSignals && <span>{zh ? '触发计时' : 'Dwell'}: {state.conditionSince === null || !state.checkedAt ? '—' : `${Math.max(0, Math.floor((Date.parse(state.checkedAt) - state.conditionSince) / 1000))}s / ${strategy.config.management?.durationSeconds}s`}</span>}
    <span>{zh ? '持仓核对' : 'Position checked'}: {state.checkedAt ? new Date(state.checkedAt).toLocaleTimeString() : '—'}</span>
    {observingSignals && <span>{zh ? '费率取数' : 'Funding checked'}: {state.fundingCheckedAt ? new Date(state.fundingCheckedAt).toLocaleTimeString() : '—'}</span>}
    <span>{zh ? '未结束订单' : 'Unfinished orders'}: {state.pendingOrderIds.length}</span>
    {displayedReason && <span>{managedReasonMessage(displayedReason, language)}</span>}
    {observingSignals && state.signalReason && state.signalReason !== state.reason && <span>{managedReasonMessage(state.signalReason, language)}</span>}
  </details>;
}

function managementExplanation(key: keyof ManagementDraft, zh: boolean): string {
  const messages: Partial<Record<keyof ManagementDraft, [string, string]>> = {
    enabled: ['建仓后持续核对两腿并按条件退出；关闭后保持原单次执行行为。', 'Keeps monitoring both legs and exits by the configured rules; off retains the existing one-shot behavior.'],
    adoptExisting: ['仅接管所选账户和两腿的平衡旧仓；本次数量是新增量。未知订单阻止启动。', 'Only balanced holdings on this account and pair are adopted. The target is additional quantity; unknown orders block launch.'],
    spreadBps: ['价差低于此阈值时满足该退出条件；允许负值。', 'This exit condition is met below the spread threshold; signed values are allowed.'],
    fundingAprPct: ['沿用当前托管策略的净资金费率年化口径，不是账户总年化收益率。', 'The managed pair funding APR, not the account-wide portfolio APR.'],
    condition: ['同时满足要求两个条件均成立；任一满足只需一个成立。', 'AND requires both conditions; OR requires either one.'],
    durationSeconds: ['条件必须持续满足指定秒数，不是仅触碰一次。', 'The condition must remain satisfied for this duration, not a single tick.'],
    quantity: ['空值沿用建仓每笔数量。只控制退出批次，不改变建仓目标。', 'Empty inherits the entry clip size; this only controls exit clips.'],
    intervalSeconds: ['退出批次之间的等待秒数，沿用原有效范围。', 'Seconds between exit clips, using existing validation.'],
    makerWaitSeconds: ['挂单等待上限；超时后的行为由市价回退设置决定。', 'Maker wait limit; the fallback setting controls behavior after timeout.'],
    makerLeg: ['沿用建仓选择，或显式选择 A/B 作为退出挂单腿。', 'Inherit the entry maker leg, or explicitly choose A or B for exits.'],
    marketFallback: ['勾选后允许挂单超时转为市价分批退出；否则按原流程重新挂单。', 'Allows market exit clips after maker timeout; otherwise retains the existing requote flow.'],
  };
  return (messages[key] ?? ['', ''])[zh ? 0 : 1];
}
