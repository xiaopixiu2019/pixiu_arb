import { useState } from 'react';
import { DEFAULT_MARGIN_POLICY, MarginPolicySchema, type MarginSnapshot, type MarginPolicy } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { riskApi } from './risk-api.js';
import { riskReason } from './risk-presentation.js';

export function RiskSettings({ snapshot, onSaved, fresh, open, onToggle }: { snapshot: MarginSnapshot; onSaved: (s: MarginSnapshot) => void; fresh: boolean; open: boolean; onToggle: (value: boolean) => void }) {
  const { language } = useLanguage(), zh = language === 'zh';
  const [draft, setDraft] = useState<MarginPolicy>(snapshot.policy), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const save = async () => {
    setBusy(true); setMessage('');
    try { const next = await riskApi.save(draft, snapshot.accountId); onSaved(next); setDraft(next.policy); setConfirm(false); setMessage(zh ? '已保存。正在处理的减仓事件保留原配置。' : 'Saved. Active reduction retains its policy version.'); }
    catch (error) { setMessage(riskReason(error instanceof Error ? error.message : 'risk_request_failed', zh)); }
    finally { setBusy(false); }
  };
  const valid = MarginPolicySchema.safeParse(draft).success;
  const initial = Number(snapshot.metrics?.initialPct), maintenance = Number(snapshot.metrics?.maintenancePct);
  const preview = !fresh || !snapshot.metrics ? (zh ? '数据无效，无法预览或应用。' : 'Data unavailable; preview and apply are blocked.') : snapshot.metrics?.initialPct != null && initial < draft.initial.reduce || snapshot.metrics?.maintenancePct != null && maintenance < draft.maintenance.reduce
    ? (zh ? '按当前数据将触发减仓事件；实际执行还需授权组及实盘权限。' : 'Current data would trigger reduction; execution also requires authorized groups and live permission.')
    : (snapshot.metrics?.initialPct != null && initial < draft.initial.warn) || (snapshot.metrics?.maintenancePct != null && maintenance < draft.maintenance.warn) ? (zh ? '按当前数据将预警并阻止增仓。' : 'Current data would warn and block entry.') : (zh ? '当前数据未触及新阈值。' : 'Current data does not cross these thresholds.');
  return <details id="risk-settings" className="risk-panel risk-settings" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}><summary><strong>{zh ? '保护参数与授权范围' : 'Protection settings and scope'}</strong><span>IMR {draft.initial.warn} / {draft.initial.reduce} / {draft.initial.recover}%</span></summary>
    <p className="risk-caption">{zh ? '交易所风险线不可修改。参数须满足：100% < 减仓 < 预警 < 恢复。' : 'Exchange boundaries are fixed. Require 100% < reduce < warn < recover.'}</p>
    <section className="risk-protected-groups">
    <h3>{zh ? '允许自动减仓的托管组' : 'Groups allowed to reduce automatically'}</h3>
    <p className="risk-caption">{zh ? 'MMR优先减少资金费年化低的可执行组；收益未知且已知收益组不可继续时按保证金占用兜底。取消勾选阻止下一批，已成交首腿仍在原上限内配平；KEEP或关闭实盘会立即停止新提交。' : 'MMR reduces lower funding yields first; unavailable yields use disclosed margin fallback. Removing a group blocks its next batch; confirmed fills retain bounded pairing responsibility. KEEP or live revocation stops new submissions.'}</p>
    {!snapshot.groups.length && <p className="risk-caption">{zh ? '暂无托管组；监控仍覆盖账户，自动减仓没有授权范围。' : 'No managed groups. Account monitoring remains active; no automatic reduction scope.'}</p>}
    {snapshot.groups.map((group) => <label key={group.id} className="risk-group"><input type="checkbox" checked={draft.protectedGroupIds.includes(group.id)} disabled={busy || !group.eligible && !draft.protectedGroupIds.includes(group.id)} onChange={(e) => { setConfirm(false); setDraft({ ...draft, protectedGroupIds: e.target.checked ? [...draft.protectedGroupIds, group.id] : draft.protectedGroupIds.filter((id) => id !== group.id) }); }} /><strong>{group.asset}</strong><span>{group.phase} · {group.id}</span><small>{group.reason || group.readiness?.reason ? riskReason(group.reason ?? group.readiness!.reason!, zh) : ''}</small></label>)}
    {!!snapshot.uncoveredSymbols.length && <p className="risk-notice">{zh ? '未被运行中托管组覆盖：' : 'Outside active managed coverage: '}{snapshot.uncoveredSymbols.join(', ')}</p>}
    </section>
    <h3>{zh ? '保护阈值' : 'Protection thresholds'}</h3>
    <div className="risk-settings-grid risk-threshold-grid">{(['initial', 'maintenance'] as const).map((kind) => <fieldset key={kind} disabled={busy}><legend>{kind === 'initial' ? 'IMR' : 'MMR'}</legend>{(['warn', 'reduce', 'recover'] as const).map((level, i) => <label key={level}>{(zh ? ['预警并禁止增仓', '分批市价减仓', '停止减仓恢复值'] : ['Warn and block entry', 'Reduce with market orders', 'Recovery target'])[i]} (%)<input type="number" min="100.01" step="0.01" value={draft[kind][level]} onChange={(e) => { setConfirm(false); setDraft({ ...draft, [kind]: { ...draft[kind], [level]: Number(e.target.value) } }); }} /></label>)}</fieldset>)}</div>
    <div className="risk-settings-grid risk-notification-grid"><label className="risk-group"><input type="checkbox" disabled={busy} checked={draft.notificationsEnabled} onChange={(e) => { setConfirm(false); setDraft({ ...draft, notificationsEnabled: e.target.checked }); }} />{zh ? '发送保证金 Telegram 通知' : 'Send margin Telegram alerts'}</label>
      <label>{zh ? '持续异常重复提醒间隔（分钟）' : 'Persistent alert interval (minutes)'}<input type="number" disabled={busy} min="1" max="1440" value={draft.reminderMinutes} onChange={(e) => { setConfirm(false); setDraft({ ...draft, reminderMinutes: Number(e.target.value) }); }} /></label></div>
    {snapshot.policy.revision !== snapshot.effectivePolicy.revision && <p className="risk-notice">{zh ? '新参数将在当前减仓事件结束后生效。' : 'New settings apply after the active incident ends.'}</p>}
    {message && <p className="risk-notice" role="status">{message}</p>}
    {confirm && <div className="risk-notice"><p>{preview}</p><p>{zh ? '仅处理选中的托管组，采用分批市价，只减仓。市价可能产生滑点；停止保留仓位不自动接管。' : 'Only selected groups may reduce, using market orders. Slippage is possible. KEEP-stopped positions are excluded.'}</p></div>}
    <div className="risk-heading-actions"><button disabled={busy || !valid || !fresh} onClick={() => confirm ? void save() : setConfirm(true)}>{confirm ? (zh ? '确认保存并应用' : 'Confirm and apply') : (zh ? '预览修改效果' : 'Preview changes')}</button>
      <button disabled={busy} onClick={() => { setConfirm(false); setDraft({ ...draft, initial: DEFAULT_MARGIN_POLICY.initial, maintenance: DEFAULT_MARGIN_POLICY.maintenance }); }}>{zh ? '恢复默认阈值' : 'Default thresholds'}</button>
</div>
  </details>;
}
