import { useContext, useEffect, useRef, useState } from 'react';
import type { ManagedCloseTarget } from '@gate-crossex/shared-types';
import { api, ApiError, type TradingMode } from './api.js';
import { useLanguage } from './i18n.js';
import { PositionsTable } from './positions-table.js';
import type { PositionTableRow } from './strategy-positions.js';
import { matchManagedCloseTarget } from './managed-close-target.js';
import { StrategyStopConfirmation } from './strategy-stop-confirmation.js';
import { strategyErrorMessage } from './strategy-error-message.js';
import { receiptForRows, sameCloseTask } from './managed-close-receipt.js';
import { ManagedCloseReceiptsContext } from './use-managed-close-receipts.js';

function useCloseTargets(profileId?: string | null, enabled = true) {
  const [targets, setTargets] = useState<ManagedCloseTarget[]>([]);
  const [readStatus, setReadStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.managedCloseTargets(controller.signal);
        if (!controller.signal.aborted) { setTargets(result.targets); setReadStatus('loaded'); }
      } catch {
        if (!controller.signal.aborted) { setTargets([]); setReadStatus('failed'); }
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileId, enabled]);

  return { targets, readStatus };
}

function useCloseRequest(selection: ManagedCloseTarget | null, profileId: string | null | undefined,
  tradingMode: TradingMode | null, onOpenModeDialog: () => void, onChanged: () => Promise<void> | void,
  accepted: () => void, dataUnavailable = false) {
  const { language } = useLanguage(), zh = language === 'zh';
  const [busy, setBusy] = useState(false), submitting = useRef(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const store = useContext(ManagedCloseReceiptsContext);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!store) throw new Error('Managed close receipt provider is required');
  const { receipts, begin, update, read } = store;
  async function confirm() {
    if (dataUnavailable || submitting.current || !selection || receipts.some(r => r.strategyId === selection.strategy.id) || selection.scope.accountProfileId !== profileId) return;
    if (tradingMode !== 'live') { onOpenModeDialog(); return; }
    const receipt = begin(selection);
    if (!receipt) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await api.stopStrategy(selection.strategy.id, true, selection.scope);
      if (!sameCloseTask(receipt, result)) throw new Error('managed_close_response_unverified');
      const outcome = update(receipt.strategyId, 'accepted', result);
      if (!alive.current) return;
      accepted();
      setNotice(outcome?.state === 'completed'
        ? (zh ? '两腿已核实归零，任务已完成。' : 'Both legs verified flat; task completed.')
        : outcome?.state === 'review' ? (zh ? '任务状态已变化，请到原任务核实退出结果，勿重复提交。' : 'Task state changed. Review the exit in the original task; do not resubmit.')
        : (zh ? '退出请求已接受，正在按原任务设置平仓；请查看任务进度。' : 'Exit accepted. Closing using the task settings; follow its progress.'));
      try { await onChanged(); }
      catch { if (alive.current && read(receipt.strategyId)?.state === 'accepted') setNotice(zh ? '退出请求已接受，但页面刷新失败；请查看原任务，勿重复提交。' : 'Exit accepted, but refresh failed. Check the task; do not resubmit.'); }
    } catch (failure) {
      const outcome = update(receipt.strategyId, 'review');
      if (!alive.current) return;
      if (outcome?.state === 'completed') { accepted(); setError(null); return; }
      const detail = failure instanceof ApiError ? strategyErrorMessage(failure, language) : '';
      setError(`${detail}${detail ? ' ' : ''}${zh ? '请到原任务核实结果，勿重复提交。' : 'Check the original task; do not resubmit.'}`);
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  async function continueExit(target: ManagedCloseTarget) {
    if (dataUnavailable || submitting.current || target.scope.accountProfileId !== profileId) return;
    if (!['live', 'protect_only'].includes(tradingMode ?? '')) { onOpenModeDialog(); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      await api.resumeStrategy(target.strategy.id, 'EXITING');
      if (!alive.current) return;
      setNotice(zh ? '已重新核实退出责任，系统将保持仅减仓直到真实零仓。' : 'Exit responsibility reverified; reduce-only execution will continue until verified flat.');
      await onChanged();
    } catch (failure) {
      if (!alive.current) return;
      const detail = failure instanceof ApiError ? strategyErrorMessage(failure, language) : '';
      setError(detail || (zh ? '暂时无法继续清仓，请核对当前订单和账户权限。' : 'Exit cannot continue yet; review the current orders and account permission.'));
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  return { busy, submitting, error, setError, notice, setNotice, receipts, confirm, continueExit };
}

interface ManagedPositionsTableProps {
  staleReason?: string;
  rows: readonly PositionTableRow[]; profileId?: string | null; accountMarginBalance?: number | null;
  tradingMode: TradingMode | null; onOpenModeDialog: () => void; onChanged: () => Promise<void> | void;
}
export function ManagedPositionsTable(props: ManagedPositionsTableProps) {
  return <AccountManagedPositionsTable key={props.profileId ?? 'no-account'} {...props} />;
}
function AccountManagedPositionsTable({ rows, profileId, accountMarginBalance, tradingMode, onOpenModeDialog, onChanged, staleReason }: ManagedPositionsTableProps) {
  const { language } = useLanguage(), zh = language === 'zh';
  const { targets, readStatus } = useCloseTargets(profileId, !staleReason);
  const [selection, setSelection] = useState<ManagedCloseTarget | null>(null);
  const { busy, submitting, error, setError, notice, setNotice, receipts, confirm, continueExit } = useCloseRequest(
    selection, profileId, tradingMode, onOpenModeDialog, onChanged, () => setSelection(null), Boolean(staleReason));
  const latest = receipts.filter(r => r.scope.accountProfileId === profileId).at(-1);
  const completed = latest?.state === 'completed' ? latest.strategyId : null;
  useEffect(() => {
    if (!completed || selection && selection.strategy.id !== completed) return;
    setSelection(null); setError(null);
    setNotice(zh ? '两腿已核实归零，任务已完成。' : 'Both legs verified flat; task completed.');
  }, [completed, selection, setError, setNotice, zh]);
  function closeAction(group: PositionTableRow[]) {
    const target = matchManagedCloseTarget(group, targets, profileId);
    const phase = target?.strategy.management?.phase;
    const paused = target?.strategy.status === 'PAUSED' || phase === 'RISK_PAUSED';
    const resumableExit = phase === 'RISK_PAUSED' && target?.strategy.management?.stopIntent === 'EXIT'
      && target.strategy.management.exitRequested && target.strategy.management.resumeAction === 'EXITING';
    const protectedExit = target?.strategy.status === 'PAUSED' && phase === 'EXITING'
      && target.strategy.management?.stopIntent === 'EXIT' && target.strategy.management.exitRequested;
    const receipt = receiptForRows(group, receipts, profileId, targets);
    if (resumableExit) return { disabled: busy || readStatus !== 'loaded', submitted: Boolean(receipt),
      label: zh ? '重新核实并继续清仓' : 'Reverify and continue exit',
      reason: zh ? '仅恢复本任务的只减仓责任，不开启普通交易' : 'Restores only this task\'s reduce-only exit responsibility' };
    if (receipt) {
      const review = !protectedExit && (receipt.state === 'review' || paused && receipt.state !== 'completed');
      const done = receipt.state === 'completed' && !review;
      const pending = receipt.state === 'pending';
      return { disabled: true, submitted: true,
        label: review ? (zh ? '需核实' : 'Review required') : done ? (zh ? '已完成' : 'Completed')
          : pending ? (zh ? '提交中' : 'Submitting') : (zh ? '正在退出' : 'Exiting'),
        reason: review ? (zh ? '请到原任务核实请求结果，勿重复提交' : 'Review the request in the original task; do not resubmit')
          : done ? (zh ? '两腿已核实归零，等待持仓显示更新' : 'Both legs verified flat; awaiting the holdings display')
            : pending ? (zh ? '正在提交退出请求，请勿重复操作' : 'Submitting the exit request; do not resubmit')
            : !target || readStatus === 'failed' ? (zh ? '退出请求已接受，等待结果核实' : 'Exit accepted; awaiting verification') : '' };
    }
    if (staleReason) return { disabled: true, reason: staleReason };
    const exiting = phase === 'EXITING' || phase === 'STOPPING';
    const reason = readStatus === 'loading' ? (zh ? '正在核实托管归属' : 'Checking ownership')
      : readStatus === 'failed' ? (zh ? '托管归属读取失败，请等待更新' : 'Ownership read failed; awaiting an update')
          : !target ? (zh ? '未能确认唯一托管任务，无法全部平仓' : 'No unique managed task owns this pair')
          : paused ? (zh ? '任务需要人工核实，请在原任务中处理' : 'Review the paused task before closing') : '';
    return { disabled: busy || readStatus !== 'loaded' || !target || exiting || paused,
      label: paused ? (zh ? '需核实' : 'Review required') : exiting ? (zh ? '正在退出' : 'Exiting') : undefined, reason };
  }
  function requestClose(group: PositionTableRow[]) {
    const action = closeAction(group), target = matchManagedCloseTarget(group, targets, profileId);
    if (submitting.current || action.disabled) return;
    if (target?.strategy.management?.phase === 'RISK_PAUSED' && target.strategy.management.stopIntent === 'EXIT') {
      void continueExit(target); return;
    }
    if (tradingMode !== 'live') { onOpenModeDialog(); return; }
    setSelection(target);
    setError(null); setNotice(null);
  }
  return <>
    <PositionsTable rows={rows} profileId={profileId} accountMarginBalance={accountMarginBalance} dataStale={Boolean(staleReason)}
      onClose={requestClose} closeAction={closeAction} />
    {!staleReason && readStatus === 'failed' && <p role="status">{zh ? '托管归属暂时无法读取；新的平仓请求已禁用，已提交请求不会重复发送。' : 'Ownership is unavailable. New close requests are disabled; submitted requests will not be resent.'}</p>}
    {notice && <p role="status">{notice}</p>}
    {selection && selection.scope.accountProfileId === profileId && <StrategyStopConfirmation
      key={selection.strategy.id} strategy={selection.strategy} language={language} closeOnly busy={busy}
      error={error} confirmDisabled={Boolean(error) || Boolean(staleReason)} onCancel={() => { if (!submitting.current) setSelection(null); }} onConfirm={() => void confirm()} />}
  </>;
}
