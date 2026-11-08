import { DEFAULT_MARGIN_POLICY, type MarginSnapshot } from '@gate-crossex/shared-types';
import { useLanguage } from './i18n.js';
import { useRiskPolicyEditor, type RiskPolicyEditor } from './use-risk-policy-editor.js';
import { policyDraft } from './risk-policy-draft.js';
import { RiskParameterMatrix } from './risk-parameter-matrix.js';
import { RiskPolicyScope } from './risk-policy-scope.js';
import { RiskPolicyPreview } from './risk-policy-preview.js';
import { ContinuousProtectionSettings } from './risk-continuous-protection.js';
import { RiskNotifications } from './risk-notifications.js';

export function RiskSettings({ snapshot, onSaved, fresh }: { snapshot: MarginSnapshot; onSaved: (s: MarginSnapshot) => void; fresh: boolean }) {
  const { language } = useLanguage(), zh = language === 'zh';
  const model = useRiskPolicyEditor(snapshot, fresh, onSaved, zh);
  const confirmed = model.editor?.confirmed && !model.conflict && fresh && ['editing', 'saving'].includes(model.editor.phase);
  return <section id="risk-settings" className="risk-settings risk-config-grid">
    <article className="risk-panel risk-parameters">
      <header className="risk-parameter-heading"><div><h2>{zh ? '保护参数' : 'Protection parameters'}</h2><p>{zh ? '六项规则常驻展示 · 修改后先预览，再确认' : 'Six visible rules · preview changes before confirming'}</p></div>
        {model.editor ? <span className="risk-draft-badge">{zh ? '编辑草稿' : 'Editing draft'}</span>
          : <button className="risk-primary" disabled={!snapshot.accountId} onClick={() => void model.enter()}>{zh ? '修改参数' : 'Edit parameters'}</button>}</header>
      {!fresh && <p role="alert" className="risk-notice error">{zh ? '数据无效或已过期；旧值仅供参考，预览和保存已阻止。' : 'Data unavailable or stale. Old values are reference only; preview and save are blocked.'}</p>}
      {snapshot.policy.revision !== snapshot.effectivePolicy.revision && <p className="risk-notice risk-effective-notice">{zh ? '当前事件仍使用原有效参数；已保存的新配置用于后续事件。' : 'The active incident still uses its effective rules. Saved changes apply to later incidents.'}</p>}
      <RiskParameterMatrix snapshot={snapshot} model={model} zh={zh} />
      <div className="risk-rule-caption"><strong>{zh ? '阈值顺序' : 'Threshold order'}</strong><span>100% &lt; {zh ? '减仓 < 预警 < 恢复' : 'reduce < warn < recover'}</span>
        <small>{zh ? '两项均达到恢复目标才结束事件；不会自动恢复其他风险锁。' : 'Both recovery targets must be met; other risk locks are not automatically cleared.'}</small></div>
      {model.editor && <button className="risk-text-button" disabled={model.editor.phase !== 'editing'} onClick={() => model.change({ ...model.editor!.draft,
        initial: policyDraft(DEFAULT_MARGIN_POLICY).initial, maintenance: policyDraft(DEFAULT_MARGIN_POLICY).maintenance })}>{zh ? '填入默认阈值（仅草稿）' : 'Fill default thresholds (draft only)'}</button>}
      {model.conflict && <div className="risk-notice error" role="alert"><strong>{zh ? '配置已有新版本，草稿已保留；请重新核对。' : 'A newer policy exists. Draft retained; review again.'}</strong>
        <p>{zh ? '服务端最新（预警 / 减仓 / 恢复）' : 'Latest saved (warn / reduce / recover)'}: IMR {snapshot.policy.initial.warn} / {snapshot.policy.initial.reduce} / {snapshot.policy.initial.recover}% · MMR {snapshot.policy.maintenance.warn} / {snapshot.policy.maintenance.reduce} / {snapshot.policy.maintenance.recover}%</p>
        <button disabled={model.busy} onClick={() => void model.enter()}>{zh ? '放弃草稿并载入最新' : 'Discard draft and load latest'}</button></div>}
      {model.message && <p role="status" className="risk-notice">{model.message}</p>}
      {(model.editor?.phase === 'uncertain' || model.editor?.phase === 'read-failed') && <button onClick={() => void (model.editor?.phase === 'read-failed' ? model.enter() : model.reconcile())}>{zh ? '核实最新配置' : 'Reconcile latest settings'}</button>}
      {confirmed && <RiskPolicyPreview snapshot={snapshot} model={model} zh={zh} />}
    </article>
    <aside className="risk-sidebar risk-config-sidebar" aria-label={zh ? '保护范围与通知' : 'Protection and notifications'}>
      <RiskPolicyScope snapshot={snapshot} model={model} fresh={fresh} zh={zh} />
      <ContinuousProtectionSettings key={snapshot.accountId} snapshot={snapshot} zh={zh} />
      <NotificationPolicy snapshot={snapshot} model={model} zh={zh} />
    </aside>
    {model.editor && <div className="risk-draft-actions"><div><strong>{zh ? `${model.changes.length} 项修改尚未保存` : `${model.changes.length} unsaved changes`}</strong>
      <small>{model.busy ? (zh ? '正在核实，请等待结果' : 'Verifying; await the result') : zh ? '编辑与预览不改变当前配置' : 'Editing and preview do not change the current policy'}</small></div>
      <div><button disabled={model.busy} onClick={model.discard}>{zh ? '放弃修改' : 'Discard changes'}</button>
        <button className="risk-primary" disabled={!model.ready || model.busy} onClick={() => confirmed ? void model.save() : model.preview()}>
          {model.editor.phase === 'saving' ? (zh ? '保存中…' : 'Saving…') : confirmed ? (zh ? '确认保存并应用' : 'Confirm and apply') : (zh ? '预览修改效果' : 'Preview changes')}</button></div></div>}
  </section>;
}

function NotificationPolicy({ snapshot, model, zh }: { snapshot: MarginSnapshot; model: RiskPolicyEditor; zh: boolean }) {
  const draft = model.editor?.draft ?? policyDraft(snapshot.policy), enabled = model.editor?.phase === 'editing';
  const minutes = Number(draft.reminderMinutes), invalid = !draft.reminderMinutes.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440;
  return <section className="risk-panel risk-notification-policy"><h2>{zh ? '通知设置' : 'Notification settings'}</h2>
    <label className="risk-group"><input type="checkbox" checked={draft.notificationsEnabled} disabled={!enabled}
      onChange={e => model.change({ ...draft, notificationsEnabled: e.target.checked })} />{zh ? '发送保证金 Telegram 通知' : 'Send margin Telegram alerts'}</label>
    <label className="risk-reminder">{zh ? '持续异常重复提醒间隔（分钟）' : 'Persistent alert interval (minutes)'}<input type="text" inputMode="numeric" readOnly={!enabled}
      value={draft.reminderMinutes} aria-invalid={invalid} onChange={e => model.change({ ...draft, reminderMinutes: e.target.value })} /></label>
    {invalid && <p className="risk-field-error">{zh ? '请输入1至1440的整数分钟。' : 'Enter whole minutes from 1 to 1440.'}</p>}
    <RiskNotifications zh={zh} />
  </section>;
}
