import { useState } from 'react';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { protectionCopy, riskReason } from './risk-presentation.js';
import type { RiskPolicyEditor } from './use-risk-policy-editor.js';

export function RiskPolicyScope({ snapshot, model, fresh, zh }: { snapshot: MarginSnapshot; model: RiskPolicyEditor; fresh: boolean; zh: boolean }) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [open, setOpen] = useState(false);
  const copy = protectionCopy(snapshot, fresh, zh), selected = model.editor?.draft.protectedGroupIds ?? snapshot.policy.protectedGroupIds;
  const missing = selected.filter(id => !snapshot.groups.some(g => g.id === id));
  const groups = [...snapshot.groups, ...missing.map(id => ({ id, strategyId: id, asset: '—', phase: 'UNVERIFIED', eligible: false,
    authorized: snapshot.policy.protectedGroupIds.includes(id), reason: 'group_evidence_unavailable', readiness: undefined }))]
    .sort((a, b) => Number(b.authorized || b.eligible) - Number(a.authorized || a.eligible));
  const visible = groups.filter(g => `${g.asset} ${g.id}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || filter === 'selected' && selected.includes(g.id) || filter === 'eligible' && g.eligible));
  const debts = snapshot.metrics?.assets.some(a => Number(a.liability) > 0);
  return <section className="risk-panel risk-scope-card">
    <div className="risk-section-heading"><h2>{zh ? '普通减仓授权' : 'Automatic reduction scope'}</h2>
      <button onClick={() => { setOpen(true); if (!model.editor) void model.enter(); }} disabled={model.busy}>{zh ? '管理范围' : 'Manage scope'}</button></div>
    <strong className={`risk-scope-status ${copy.tone}`}>{copy.title}</strong><p className="risk-caption">{copy.detail}</p>
    <p className="risk-caption">{snapshot.liveEnabled ? (zh ? '实盘权限已启用' : 'Live permission enabled') : snapshot.continuousProtection?.enabled
      ? (zh ? '普通交易锁定；持续保护按独立授权执行' : 'Ordinary trading locked; continuous protection has separate authority')
      : (zh ? '无实盘权限，不执行自动减仓' : 'Trading locked · no automatic reduction')}</p>
    {debts && <p className="risk-inline-warning">{zh ? '存在币种负债，相关组可能无法形成减仓计划。' : 'Currency liabilities may prevent reduction plans.'}</p>}
    {!!missing.length && <p className="risk-inline-warning">{zh ? `${missing.length} 个已选择组信息待核实，原名单保留。` : `${missing.length} selected groups are unverified; their identities are retained.`}</p>}
    <details className="risk-protected-groups" open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>{zh ? `托管组与授权范围（${groups.length}）` : `Groups and scope (${groups.length})`}</summary>
      <p className="risk-caption">{zh ? '勾选只是草稿。取消授权会阻止下一批，已成交责任仍须配平。筛选不会修改隐藏组。' : 'Selections are drafts. Revocation blocks the next batch; filled responsibility must reconcile. Filters never edit hidden groups.'}</p>
      <div className="risk-scope-filters"><input aria-label={zh ? '搜索托管组' : 'Search managed groups'} placeholder={zh ? '搜索资产或任务' : 'Asset or task'} value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label={zh ? '托管组筛选' : 'Group filter'} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">{zh ? '全部（含历史/待核实）' : 'All, including history/unverified'}</option><option value="selected">{zh ? '已选择' : 'Selected'}</option><option value="eligible">{zh ? '可授权' : 'Eligible'}</option></select></div>
      {!model.editor && <p className="risk-caption">{zh ? '点击“管理范围”进入编辑。' : 'Choose Manage scope to edit.'}</p>}
      <div className="risk-scope-list">{visible.map(group => <label className="risk-group" key={group.id}><input type="checkbox"
        checked={selected.includes(group.id)} disabled={model.editor?.phase !== 'editing' || !group.eligible && !selected.includes(group.id)}
        onChange={e => { if (model.editor) model.change({ ...model.editor.draft, protectedGroupIds: e.target.checked ? [...selected, group.id] : selected.filter(id => id !== group.id) }); }} />
        <span><strong>{group.asset}</strong> <b>{group.authorized ? (zh ? '已授权' : 'Authorized') : (zh ? '未授权' : 'Not authorized')}</b>
          <small>{group.phase} · {group.id}</small><small>{group.reason === 'group_evidence_unavailable' ? (zh ? '托管组信息暂不可用' : 'Group evidence unavailable') : group.reason || group.readiness?.reason ? riskReason(group.reason ?? group.readiness!.reason!, zh) : ''}</small>
          {selected.includes(group.id) !== snapshot.policy.protectedGroupIds.includes(group.id) && <em>{zh ? '范围修改待保存' : 'Scope change not saved'}</em>}</span></label>)}</div>
      {!visible.length && <p>{zh ? '没有匹配组；筛选不会撤销已有授权。' : 'No matching groups; filtering does not revoke authority.'}</p>}
      {!!snapshot.uncoveredSymbols.length && <p className="risk-notice">{zh ? '未覆盖：' : 'Outside coverage: '}{snapshot.uncoveredSymbols.join(', ')}</p>}
    </details>
  </section>;
}
