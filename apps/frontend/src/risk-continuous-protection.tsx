import { useEffect, useState } from 'react';
import type { ContinuousProtectionResponse, MarginSnapshot } from '@gate-crossex/shared-types';
import { riskApi } from './risk-api.js';

function protectionReason(reason: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    protection_keep: ['已保留仓位并停止保护', 'KEEP stopped protection'],
    protection_readonly: ['明确只读已关闭保护', 'Explicit read-only disabled protection'],
    protection_not_authorized: ['尚未授权或已撤权', 'Not enrolled or revoked'],
    protection_group_not_enrolled: ['此组尚未登记，请核实并授权', 'Group not enrolled; review and authorize'],
    protection_scope_changed: ['控制权或执行范围需核对', 'Ownership or execution scope needs reconciliation'],
    protection_entry_in_progress: ['建仓中，等待实际持仓核实', 'Entry in progress; awaiting verified holdings'],
    protection_holdings_pending: ['已登记，尚无可核实持仓', 'Enrolled; no verified holdings yet'],
    protection_observation_stale: ['保护核对已过期，等待新数据', 'Protection evidence expired; awaiting fresh data'],
  };
  return labels[reason]?.[zh ? 0 : 1] ?? reason;
}

export function ContinuousProtectionSettings({ snapshot, zh }: { snapshot: MarginSnapshot; zh: boolean }) {
  const [status, setStatus] = useState<ContinuousProtectionResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const coverageIdentity = snapshot.continuousProtection?.coverage?.map(g => `${g.groupId}:${g.enrolled}`).join('|');
  useEffect(() => {
    let alive = true;
    void riskApi.protection().then(value => {
      if (!alive) return;
      setStatus(value); setSelected(value.authorization?.groupIds ?? []);
    }).catch(() => { if (alive) setError(zh ? '持续保护状态读取失败。' : 'Protection status unavailable.'); });
    return () => { alive = false; };
  }, [snapshot.accountId, coverageIdentity, zh]);
  const apply = async (enabled: boolean) => {
    if (!status || !snapshot.accountId) return;
    setBusy(true); setError('');
    try {
      const value = await riskApi.saveProtection(snapshot.accountId, status.authorization?.revision ?? 0, enabled ? selected : [], enabled);
      setStatus(value); setConfirm(null);
    } catch (e) { setError(`${zh ? '未应用，请刷新状态后核实：' : 'Not applied. Refresh and review: '}${e instanceof Error ? e.message : 'request_failed'}`); }
    finally { setBusy(false); }
  };
  const live = snapshot.continuousProtection ?? status?.protection;
  const coverage = live?.coverage;
  const at = Date.now();
  const groups = live?.groups.map(g => g.reason === 'protection_entry_in_progress' || g.checkedAt > 0 && g.checkedAt <= at && at - g.checkedAt <= 5000
    ? g : { ...g, state: 'RECONCILING', reason: 'protection_observation_stale' });
  const enrolled = coverage?.filter(g => g.enrolled).length ?? 0;
  const verified = groups?.filter(g => ['WATCHING', 'EXECUTING'].includes(g.state)).length ?? 0;
  const candidates = snapshot.groups.filter(g => g.authorized && !['COMPLETED', 'STOPPED', 'STOPPING', 'TRANSFERRED'].includes(g.phase));
  return <section className="risk-panel" aria-label={zh ? '暂停期间持续保护' : 'Continuous protection'}>
    <h2>{zh ? '暂停期间持续保护' : 'Protection while strategies are paused'}</h2>
    <p>{zh ? '新托管任务在启动确认时自动登记本组持续保护；已有未覆盖组须明确授权。策略暂停或程序重启仍会自动核对，并在证据可靠时执行只减仓保护；普通策略不会自动恢复。保留仓位的停止（KEEP）、明确只读及撤权仍优先。' : 'New managed tasks enroll their group at launch confirmation. Existing uncovered groups require explicit enrollment. Reconciliation and reduce-only protection continue after risk pauses or restarts; ordinary strategies remain locked. KEEP, explicit read-only and revocation take precedence.'}</p>
    <p><strong>{live?.enabled ? (zh ? '持续保护已授权' : 'Continuous protection authorized') : (zh ? '持续保护未授权' : 'Continuous protection not authorized')}</strong> · {live?.state ?? '—'}</p>
    {coverage && <p>{zh ? `当前托管组 ${coverage.length} · 已登记 ${enrolled} · 已核实保护 ${verified}` : `Current managed groups ${coverage.length} · Enrolled ${enrolled} · Verified protection ${verified}`}</p>}
    {coverage?.filter(g => !g.enrolled).map(g => <p key={g.groupId} role="status">{g.groupId} · {zh ? '未覆盖' : 'Uncovered'} · {g.reason && protectionReason(g.reason, zh)}</p>)}
    {groups?.map(g => <p key={g.strategyId}>{g.strategyId} · {g.state}{g.reason ? ` · ${protectionReason(g.reason, zh)}` : ''}</p>)}
    <details><summary>{zh ? '授权范围与关闭保护' : 'Scope and revocation'}</summary>
      {candidates.map(g => <label className="risk-group" key={g.id}><input type="checkbox" checked={selected.includes(g.id)} disabled={busy}
        onChange={e => { setConfirm(null); setSelected(e.target.checked ? [...selected, g.id] : selected.filter(id => id !== g.id)); }} />
        <span>{g.asset} · {g.id}</span></label>)}
      {!candidates.length && <p>{zh ? '没有可选择的已授权托管组。请先核实风险设置中的范围。' : 'No eligible authorized groups. Review the margin scope first.'}</p>}
      {confirm && <p role="alert">{confirm === 'enable'
        ? (zh ? `确认对 ${selected.length} 个所选组启用持续保护。可能立即核对并减仓；市价存在滑点。` : `Enable protection for ${selected.length} selected groups. Reconciliation and reduction may begin immediately; market orders may slip.`)
        : (zh ? '关闭后，风险暂停及重启期间不再自动减仓；已有订单仍须核实。' : 'Revocation stops protection during risk pauses and restarts. Existing orders still require reconciliation.')}</p>}
      <div className="risk-heading-actions"><button disabled={busy || !status || !snapshot.fresh || !selected.length}
        onClick={() => confirm === 'enable' ? void apply(true) : setConfirm('enable')}>{confirm === 'enable' ? (zh ? '确认启用持续保护' : 'Confirm enrollment') : (zh ? '启用或更新范围' : 'Enable or update scope')}</button>
        <button disabled={busy || !status?.authorization?.enabled} onClick={() => confirm === 'disable' ? void apply(false) : setConfirm('disable')}>{confirm === 'disable' ? (zh ? '确认关闭持续保护' : 'Confirm revocation') : (zh ? '关闭持续保护' : 'Revoke continuous protection')}</button></div>
    </details>
    {error && <p role="alert">{error}</p>}
  </section>;
}
