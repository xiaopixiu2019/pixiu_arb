import type { FeeSummary } from '@gate-crossex/shared-types';
import { TaskFeeCell, TaskFeeDetails } from './transaction-fee-details.js';
import { useTaskPerformance } from './use-task-performance.js';
import { TaskPerformanceCell } from './task-performance-cell.js';
import { feeAmount, sumFeeMetrics } from './transaction-fee-format.js';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type AuthenticatedPortfolioSnapshot, type StrategyConfig, type StrategyRecord, type TradingSnapshot, type TradingMode } from './api.js';
import { exchanges, symbolParts, quoteFor, useDialogFocus } from './route-shared.js';
import { ManagedPositionStatus } from './position-management.js';
import { StrategyStopConfirmation } from './strategy-stop-confirmation.js';
import { managementSummary } from './position-management-config.js';
import { strategyErrorMessage } from './strategy-error-message.js';
import { marketSymbol } from './market-symbol.js';
import { localizeStrategyLogCondition, localizeStrategyLogResult, prepareStrategyLogs, type DisplayStrategyLog } from './strategy-logs.js';
import { freshPortfolioMarginBalance, prepareStrategyPositions } from './strategy-positions.js';
import { ManagedPositionsTable as PositionsTable } from './managed-positions-table.js';
import { useLanguage, type Language } from './i18n.js';
const HISTORICAL_STRATEGIES_PAGE_SIZE = 10;
function resumeLabel(strategy: StrategyRecord, language: Language): string {
  const action = strategy.management?.resumeAction;
  if (action === 'OPENING') return language === 'zh' ? '继续建仓' : 'Continue entry';
  if (action === 'MONITORING') return language === 'zh' ? '恢复监控' : 'Resume monitoring';
  if (action === 'EXITING') return language === 'zh' ? '继续平仓' : 'Continue exit';
  return language === 'zh' ? '恢复' : 'Resume';
}
function strategyMaxAmount(config: StrategyConfig): string {
  if (config.closePlan) return `${config.closePlan.orderCount} orders`;
  if (config.kind === 'premium' && config.grid) {
    const derived = (Number(config.perOrderQuantity) || 0) * (config.gridLevels ?? 0);
    return derived > 0 ? String(Number(derived.toFixed(8))) : '—';
  }
  return config.totalAmount ?? config.maxPosition ?? '—';
}

function strategyMarketLabel(config: StrategyConfig): string {
  if (config.closePlan) {
    const assets = [...new Set(config.closePlan.targets.map((target) => symbolParts(target.symbol).asset))];
    return assets.join(' / ');
  }
  if (config.kind === 'premium') return `${config.asset} / ${config.hedgeAsset}`;
  const left = marketSymbol(config.asset, quoteFor(config.leftVenue.toLowerCase()), 'perpetual');
  const right = marketSymbol(config.asset, quoteFor(config.rightVenue.toLowerCase()), 'perpetual');
  return left === right ? left : `${left} ↔ ${right}`;
}

function strategyRuntime(strategy: StrategyRecord, historical: boolean): string {
  const end = historical ? Date.parse(strategy.stoppedAt ?? strategy.updatedAt) : Date.now();
  const elapsed = Math.max(0, end - Date.parse(strategy.createdAt));
  const hours = Math.floor(elapsed / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor((elapsed / 60_000) % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function strategyStartTime(createdAt: string, language: Language): { date: string; time: string } {
  const startedAt = new Date(createdAt);
  if (Number.isNaN(startedAt.getTime())) return { date: '—', time: '' };
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  return {
    date: startedAt.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: startedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}


export function RunningStrategiesPanel({ strategies, authenticatedPortfolio, tradingSnapshot, tradingMode, onOpenModeDialog, onStrategiesChanged, onPositionsRefresh, emptyRunningHint, fees, feeProfileId, feeStale, profileId }: {
  fees?: FeeSummary | null; feeProfileId?: string | null; feeStale?: boolean;
  profileId?: string | null;
  emptyRunningHint?: string;
  strategies: StrategyRecord[];
  authenticatedPortfolio: AuthenticatedPortfolioSnapshot | null;
  tradingSnapshot: TradingSnapshot | null;
  tradingMode: TradingMode | null;
  onOpenModeDialog: () => void;
  onStrategiesChanged: () => Promise<void>;
  onPositionsRefresh: () => Promise<void>;
}) {
  const { language, t } = useLanguage();
  const taskPerformance = useTaskPerformance(profileId ?? feeProfileId);
  const [feeTask, setFeeTask] = useState<string | null>(null);
  const feesEnabled = feeProfileId !== undefined;
  const [activeStrategyTab, setActiveStrategyTab] = useState<'running' | 'positions' | 'historical'>('running');
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [stopSelection, setStopSelection] = useState<StrategyRecord | null>(null);
  const [resumingIds, setResumingIds] = useState<string[]>([]);
  const [selectedLogStrategyId, setSelectedLogStrategyId] = useState<string | null>(null);
  const [selectedStrategyLogs, setSelectedStrategyLogs] = useState<DisplayStrategyLog[]>([]);
  const [logLoadState, setLogLoadState] = useState<{ status: 'idle' | 'loading' | 'loaded' | 'error'; message?: string }>({ status: 'idle' });
  const logRequestRef = useRef(0);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [editingTakeProfitId, setEditingTakeProfitId] = useState<string | null>(null);
  const [takeProfitDraft, setTakeProfitDraft] = useState('');
  const [updatingTakeProfitId, setUpdatingTakeProfitId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const runningStrategies = strategies.filter((strategy) => ['RUNNING', 'PAUSED'].includes(strategy.status) || strategy.management?.phase === 'STOPPED');
  const historicalStrategies = strategies
    .filter((strategy) => !['RUNNING', 'PAUSED', 'STOPPING'].includes(strategy.status) && strategy.management?.phase !== 'STOPPED')
    .sort((left, right) => Date.parse(right.stoppedAt ?? right.updatedAt) - Date.parse(left.stoppedAt ?? left.updatedAt));
  const showingHistory = activeStrategyTab === 'historical';
  const showingPositions = activeStrategyTab === 'positions';
  const historyPages = Math.max(1, Math.ceil(historicalStrategies.length / HISTORICAL_STRATEGIES_PAGE_SIZE));
  const historyStart = (historyPage - 1) * HISTORICAL_STRATEGIES_PAGE_SIZE;
  const visibleStrategies = showingHistory
    ? historicalStrategies.slice(historyStart, historyStart + HISTORICAL_STRATEGIES_PAGE_SIZE)
    : runningStrategies;
  const positionsView = useMemo(
    () => prepareStrategyPositions(authenticatedPortfolio, tradingSnapshot, { retainStalePortfolio: true }),
    [authenticatedPortfolio, tradingSnapshot],
  );
  const selectedLogStrategy = strategies.find((strategy) => strategy.id === selectedLogStrategyId) ?? null;
  const logDialogRef = useDialogFocus(Boolean(selectedLogStrategy), () => setSelectedLogStrategyId(null));


  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPages));
  }, [historyPages]);


  useEffect(() => {
    if (!showingPositions) return;
    let refreshInProgress = false;
    const refresh = () => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      void onPositionsRefresh().catch(() => undefined).finally(() => { refreshInProgress = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [showingPositions, onPositionsRefresh]);

  // A failed stop must never be silent: the strategy would keep trading while the user
  // believes it is halted.
  async function stopStrategy(id: string, closePositions = false) {
    if (stoppingIds.includes(id) || resumingIds.includes(id)) return;
    setStoppingIds((current) => [...current, id]);
    setStopNotice(null);
    try {
      await api.stopStrategy(id, closePositions);
      setStopSelection(null);
      await onStrategiesChanged();
      if (id === selectedLogStrategyId) setSelectedLogStrategyId(null);
    } catch (error) {
      setStopNotice(`${t('Stop failed')} (${id}): ${error instanceof ApiError ? strategyErrorMessage(error, language) : t('Backend unavailable')}`);
    } finally {
      setStoppingIds((current) => current.filter((item) => item !== id));
    }
  }

  async function resumeStrategy(id: string) {
    if (tradingMode !== 'live') {
      onOpenModeDialog();
      return;
    }
    if (resumingIds.includes(id) || stoppingIds.includes(id)) return;
    setResumingIds((current) => [...current, id]);
    setStopNotice(null);
    try {
      await api.resumeStrategy(id, strategies.find(strategy => strategy.id === id)?.management?.resumeAction);
      await onStrategiesChanged();
    } catch (error) {
      setStopNotice(`${t('Resume failed')} (${id}): ${error instanceof ApiError ? strategyErrorMessage(error, language) : t('Backend unavailable')}`);
    } finally {
      setResumingIds((current) => current.filter((item) => item !== id));
    }
  }

  async function openLogs(id: string) {
    const request = ++logRequestRef.current;
    const strategy = strategies.find((candidate) => candidate.id === id);
    setSelectedLogStrategyId(id);
    setSelectedStrategyLogs([]);
    setLogLoadState({ status: 'loading' });
    try {
      const logs = prepareStrategyLogs(
        (await api.strategyLogs(id)).logs,
        strategy?.config,
      );
      if (request !== logRequestRef.current) return;
      setSelectedStrategyLogs(logs);
      setLogLoadState({ status: 'loaded' });
    } catch (error) {
      if (request !== logRequestRef.current) return;
      setSelectedStrategyLogs([]);
      setLogLoadState({ status: 'error', message: error instanceof ApiError ? error.message : t('Backend unavailable') });
    }
  }

  function editTakeProfit(strategy: StrategyRecord) {
    setEditingTakeProfitId(strategy.id);
    setTakeProfitDraft(strategy.config.takeProfitPremiumPct ?? '');
    setStopNotice(null);
  }

  async function saveTakeProfit(strategy: StrategyRecord) {
    if (updatingTakeProfitId) return;
    if (!/^-?\d+(?:\.\d+)?$/.test(takeProfitDraft)) {
      setStopNotice(`${t('Take-profit update failed')} (${strategy.id}): ${t('Enter a valid take-profit premium')}`);
      return;
    }
    setUpdatingTakeProfitId(strategy.id);
    setStopNotice(null);
    try {
      await api.updatePremiumTakeProfit(strategy.id, takeProfitDraft);
      await onStrategiesChanged();
      setEditingTakeProfitId(null);
    } catch (error) {
      setStopNotice(`${t('Take-profit update failed')} (${strategy.id}): ${error instanceof ApiError ? error.message : t('Backend unavailable')}`);
    } finally {
      setUpdatingTakeProfitId(null);
    }
  }

  function kindLabel(strategy: StrategyRecord): string {
    return t(strategy.config.closePlan ? 'Hedge position strategy' : strategy.kind === 'auto' ? 'Price-difference bot' : strategy.kind === 'premium' ? 'SK hynix premium bot' : 'Cross-exchange hedge');
  }

  return <>
    <section className="running-strategies terminal-panel">
      <div className="strategy-panel-head"><div><p className="eyebrow">{t('Live automation')}</p><h2>{t('Strategies')}</h2></div><small>{t('Each strategy runs independently')}</small></div>
      <div className="strategy-history-tabs" role="tablist" aria-label={t('Strategies')}>
        <button role="tab" aria-selected={showingPositions} className={showingPositions ? 'active' : ''} onClick={() => { setActiveStrategyTab('positions'); setFeeTask(null); setEditingTakeProfitId(null); }}>{t('Positions')} <span>({positionsView.status === 'fresh' ? positionsView.rows.length : '—'})</span></button>
        <button role="tab" aria-selected={activeStrategyTab === 'running'} className={activeStrategyTab === 'running' ? 'active' : ''} onClick={() => { setActiveStrategyTab('running'); setFeeTask(null); setEditingTakeProfitId(null); }}>{t('Running')} <span>({runningStrategies.length})</span></button>
        <button role="tab" aria-selected={showingHistory} className={showingHistory ? 'active' : ''} onClick={() => { setActiveStrategyTab('historical'); setFeeTask(null); setHistoryPage(1); setEditingTakeProfitId(null); }}>{t('Historical')} <span>({historicalStrategies.length})</span></button>
      </div>
      {feesEnabled && !showingPositions && fees && visibleStrategies.length > 0 && <div className="task-fee-subtotal">{language === 'zh' ? '当前标签任务已确认手续费' : 'Confirmed fees for this tab'}: {feeAmount(sumFeeMetrics((showingHistory ? historicalStrategies : runningStrategies).map((s) => fees.tasks.find((f) => f.taskId === s.id)?.metric)).amount, language === 'zh')} USDT
        <small> · {language === 'zh' ? '包含全部分页；不含待核对费用' : 'Across all pages; pending fees excluded'}</small></div>}
      {!showingPositions && taskPerformance?.accountCosts && taskPerformance.accountCosts.count>0 && <div className="task-fee-subtotal">
        {language==='zh'?'账户公共账务净变动（未分摊到任务）':'Shared account cashflows (not allocated to tasks)'}: {taskPerformance.accountCosts.amount===null?'—':Number(taskPerformance.accountCosts.amount).toFixed(4)} USDT
      </div>}
      {showingHistory && taskPerformance && !taskPerformance.accountCosts && taskPerformance.unallocated.count>0 && <div className="task-fee-subtotal">
        {language==='zh'?'账户未归属账务净变动（不等于本任务成本）':'Unallocated account cashflows (not task costs)'}:
        {' '}{Object.entries(taskPerformance.unallocated.native).map(([coin,value])=>`${feeAmount(value,language==='zh')} ${coin}`).join(' / ')}
      </div>}
      {!showingPositions && taskPerformance?.unresolvedCashflows && taskPerformance.unresolvedCashflows.count>0 && <div className="task-fee-subtotal">
        {language==='zh'?'其他未归属账务（未计入任务）':'Other unassigned cashflows (not in tasks)'}:
        {' '}{Object.entries(taskPerformance.unresolvedCashflows.native).map(([coin,value])=>`${Number(value).toFixed(4)} ${coin}`).join(' / ')}
      </div>}
      {showingPositions ? <>
        {positionsView.status === 'stale' && positionsView.rows.length > 0 && <p role="status" className="stale-strategy-positions">
          {language === 'zh' ? `持仓快照已过期，以下为上次确认的 ${positionsView.rows.length} 条持仓；依赖实时数据的操作已禁用。数据时间：` : `Position snapshot is stale. Showing ${positionsView.rows.length} last-confirmed positions; actions requiring fresh data are disabled. Data time: `}
          <time dateTime={authenticatedPortfolio?.snapshot.fetchedAt}>{authenticatedPortfolio?.snapshot.fetchedAt ?? '—'}</time>
        </p>}
        {positionsView.rows.length > 0 && <PositionsTable rows={positionsView.rows} profileId={profileId} accountMarginBalance={freshPortfolioMarginBalance(authenticatedPortfolio)} key={profileId} tradingMode={tradingMode} onOpenModeDialog={onOpenModeDialog}
          staleReason={positionsView.status === 'fresh' ? undefined : t('Position snapshot is stale')}
          onChanged={async () => { await onStrategiesChanged(); await onPositionsRefresh(); }} />}
        {positionsView.status === 'fresh' && positionsView.rows.length === 0 && <div className="no-strategies"><span>◎</span><strong>{t('No open positions')}</strong><small>{t('The live account has no open futures positions.')}</small></div>}
        {positionsView.status === 'stale' && positionsView.rows.length === 0 && <div className="no-strategies stale-strategy-positions"><span>!</span><strong>{t('Position snapshot is stale')}</strong><small>{t('Waiting for a fresh account snapshot.')}</small></div>}
        {positionsView.status === 'unavailable' && <div className="no-strategies"><span>◎</span><strong>{t('Position data unavailable')}</strong><small>{t('Waiting for a fresh account snapshot.')}</small></div>}
      </> : <>
        <div tabIndex={0} role="region" aria-label={language==='zh'?'任务及交易盈亏':'Strategy results'} className={`running-table with-trading ${showingHistory ? 'historical' : ''} ${feesEnabled ? 'with-fees' : ''}`}><div className="running-head">{showingHistory && <span>{t('Start time')}</span>}<span>{t('Strategy')}</span><span>{t('Market name')}</span><span>{t('Exchanges')}</span><span>{t('Entry / Exit')}</span><span>{language === 'zh' ? '交易净盈亏' : 'Trading net PnL'}</span><span>{t('Size limits')}</span><span>{t('Method')}</span><span>{t('Execution log')}</span>{feesEnabled && <span>{language === 'zh' ? '本任务手续费' : 'Task fees'}</span>}<span>{t(showingHistory ? 'Duration' : 'Runtime')}</span><span>{t('Status')}</span>{!showingHistory && <span />}</div>{visibleStrategies.map((strategy) => {
      const config = strategy.config;
      const premium = config.kind === 'premium';
      const timedClose = Boolean(config.closePlan);
      const shortPremium = config.leftSide === 'SELL';
      const leftVenue = exchanges.find((item) => item.id === config.leftVenue.toLowerCase());
      const rightVenue = exchanges.find((item) => item.id === config.rightVenue.toLowerCase());
      const startedAt = strategyStartTime(strategy.createdAt, language);
      return <Fragment key={strategy.id}><div className="running-row">
        {showingHistory && <span className="strategy-start-time"><strong>{startedAt.date}</strong><small>{startedAt.time}</small></span>}
        <span><strong>{strategy.id}</strong><small>{kindLabel(strategy)}{strategy.accountLabel ? ` · ${strategy.accountLabel}` : ''}</small></span>
        <span><strong>{strategyMarketLabel(config)}</strong><small>{t(premium ? 'ADR premium' : 'Perpetual')}</small></span>
        <span>{timedClose ? [...new Set(config.closePlan?.targets.map((target) => symbolParts(target.symbol).venue) ?? [])].join(' ⇄ ') : config.leftVenue === config.rightVenue ? leftVenue?.name ?? config.leftVenue : `${leftVenue?.name ?? config.leftVenue} ⇄ ${rightVenue?.name ?? config.rightVenue}`}</span>
        <span>{timedClose
          ? <><strong>{config.closePlan?.orderCount} {t('orders')}</strong><small>{config.closePlan?.intervalSeconds}s {t('Time gap between orders').toLowerCase()}</small></>
          : premium
          ? <><strong>{shortPremium ? '≥' : '≤'} {config.entryPremiumPct}%</strong>{config.reduceOnly
            ? <small>{t('Reduce only · stop at target')}</small>
            : config.grid
            ? <small>{config.gridLevels} × {config.gridStepPct}% {t('grid')}</small>
            : editingTakeProfitId === strategy.id
              ? <small className="take-profit-editor"><span>{shortPremium ? '≤' : '≥'}</span><input aria-label={t('Take-profit premium')} inputMode="decimal" value={takeProfitDraft} onChange={(event) => setTakeProfitDraft(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') void saveTakeProfit(strategy);
                if (event.key === 'Escape') setEditingTakeProfitId(null);
              }} autoFocus /><span>%</span><button className="save-take-profit" onClick={() => void saveTakeProfit(strategy)} disabled={updatingTakeProfitId === strategy.id}>{updatingTakeProfitId === strategy.id ? t('Saving…') : t('Save')}</button><button className="cancel-take-profit" aria-label={t('Cancel edit')} onClick={() => setEditingTakeProfitId(null)} disabled={updatingTakeProfitId === strategy.id}>×</button></small>
              : <small className="take-profit-value"><span>{shortPremium ? '≤' : '≥'} {config.takeProfitPremiumPct}%</span>{strategy.status === 'RUNNING' && <button className="edit-take-profit" onClick={() => editTakeProfit(strategy)}>{t('Edit take profit')}</button>}</small>}</>
          : <><strong>≥ {config.entryBps} bps</strong><small>{config.management ? managementSummary(config.management, language) : config.takeProfitBps ? `≤ ${config.takeProfitBps} bps` : t('Stop at full fill')}</small></>}</span>
        <TaskPerformanceCell value={taskPerformance?.tasks.find(p=>p.taskId===strategy.id)} zh={language==='zh'} stale={taskPerformance?.stale} />
        <span>{timedClose ? `${config.closePlan?.targets.length} ${t('Positions')} · ${config.closePlan?.orderCount} ${t('orders')}` : `${config.perOrderQuantity} ${config.asset} · ${t('max')} ${strategyMaxAmount(config)}`}</span>
        <span>{config.executionMethod.replaceAll('_', '–')}</span>
        <span><button className="logs-button" onClick={() => void openLogs(strategy.id)}>{t('View logs')}</button></span>
        {feesEnabled && <TaskFeeCell metric={fees?.tasks.find((f) => f.taskId === strategy.id)?.metric} language={language} stale={feeStale} expanded={feeTask === strategy.id} onClick={() => setFeeTask((id) => id === strategy.id ? null : strategy.id)} />}
        <span>{strategyRuntime(strategy, showingHistory)}</span>
        <span className={`strategy-status ${strategy.status.toLowerCase()}`}><span className="strategy-status-head"><i />{strategy.status}<small>{strategy.progress.toFixed(0)}%</small></span><ManagedPositionStatus strategy={strategy} language={language} tradingMode={tradingMode} /></span>
        {!showingHistory && <span className="strategy-actions">{(strategy.status === 'PAUSED' || strategy.management?.phase === 'STOPPED') && <button className="resume-button" onClick={() => void resumeStrategy(strategy.id)} disabled={resumingIds.includes(strategy.id) || stoppingIds.includes(strategy.id)}>{resumingIds.includes(strategy.id) ? t('Resuming…') : resumeLabel(strategy, language)}</button>}<button className="stop-button" onClick={() => strategy.config.management ? setStopSelection(strategy) : void stopStrategy(strategy.id)} disabled={stoppingIds.includes(strategy.id) || resumingIds.includes(strategy.id)}>{stoppingIds.includes(strategy.id) ? t('Stopping…') : t('Stop')}</button></span>}
      </div>{feesEnabled && feeTask === strategy.id && <TaskFeeDetails taskId={strategy.id} profileId={feeProfileId ?? null} language={language} />}</Fragment>;
    })}</div>{showingHistory && historicalStrategies.length >= HISTORICAL_STRATEGIES_PAGE_SIZE && <div className="funding-pagination strategy-pagination"><span className="page-range">{historyStart + 1}–{Math.min(historyStart + HISTORICAL_STRATEGIES_PAGE_SIZE, historicalStrategies.length)} / {historicalStrategies.length}</span><div className="page-controls"><button onClick={() => setHistoryPage((current) => Math.max(1, current - 1))} disabled={historyPage === 1}>{t('Prev')}</button><span className="page-indicator">{t('Page')} {historyPage} / {historyPages}</span><button onClick={() => setHistoryPage((current) => Math.min(historyPages, current + 1))} disabled={historyPage === historyPages}>{t('Next')}</button></div><span className="page-size">10 {t('per page')}</span></div>}{stopNotice && <div className="launch-notice error panel-notice">{stopNotice}</div>}{visibleStrategies.length === 0 && <div className="no-strategies"><span>◎</span><strong>{t(showingHistory ? 'No historical strategies' : 'No strategies running')}</strong><small>{t(showingHistory ? 'Stopped and completed strategies will appear here.' : emptyRunningHint ?? 'Configure a strategy above and start it when ready.')}</small></div>}
      </>}
    </section>

    {stopSelection && <StrategyStopConfirmation key={stopSelection.id} strategy={stopSelection} language={language}
      busy={stoppingIds.includes(stopSelection.id)} error={stopNotice} onCancel={() => setStopSelection(null)} onConfirm={(close) => void stopStrategy(stopSelection.id, close)} />}
    {selectedLogStrategy && <div className="execution-log-backdrop" role="presentation" onMouseDown={() => setSelectedLogStrategyId(null)}>
      <section ref={logDialogRef} tabIndex={-1} className="execution-log-modal" role="dialog" aria-modal="true" aria-labelledby="execution-log-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><p className="eyebrow">{t('Strategy execution log')}</p><h2 id="execution-log-title">{selectedLogStrategy.id}</h2><span>{strategyMarketLabel(selectedLogStrategy.config)} · {selectedLogStrategy.config.closePlan ? [...new Set(selectedLogStrategy.config.closePlan.targets.map((target) => symbolParts(target.symbol).venue))].join(' ⇄ ') : selectedLogStrategy.config.leftVenue === selectedLogStrategy.config.rightVenue ? selectedLogStrategy.config.leftVenue : `${selectedLogStrategy.config.leftVenue} ⇄ ${selectedLogStrategy.config.rightVenue}`}</span></div><button data-dialog-autofocus aria-label={t('Close execution log')} onClick={() => setSelectedLogStrategyId(null)}>×</button></header>
        <div className="execution-log-summary"><div><span>{t('Strategy')}</span><strong>{t(selectedLogStrategy.config.closePlan ? 'Hedge position strategy' : selectedLogStrategy.kind === 'auto' ? 'Auto price difference' : selectedLogStrategy.kind === 'premium' ? 'SK hynix premium bot' : 'Cross-exchange hedge')}</strong></div><div><span>{t('Status')}</span><strong className="positive">● {selectedLogStrategy.status}</strong></div><div><span>{t('Execution method')}</span><strong>{selectedLogStrategy.config.executionMethod.replaceAll('_', '–')}</strong></div></div>
        <div className="execution-log-table">
          <div className="execution-log-head"><span>{t('Time')}</span><span>{t('Event')}</span><span>{t('Spread / trigger')}</span><span>{t('Quantity')}</span><span>{t('Execution result')}</span><span>{t('Result')}</span></div>
          {logLoadState.status === 'loading' && <div className="execution-log-state">{t('Loading execution log…')}</div>}
          {logLoadState.status === 'error' && <div className="execution-log-state error">{t('Execution log unavailable')}: {logLoadState.message}</div>}
          {logLoadState.status === 'loaded' && selectedStrategyLogs.length === 0 && <div className="execution-log-state">{t('No execution events yet.')}</div>}
          {selectedStrategyLogs.map((log) => <div className="execution-log-row" key={log.id}>
            <span>{new Date(log.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
            <span><strong>{t(log.event)}</strong><small>{t(log.level)}</small></span>
            <span>{localizeStrategyLogCondition(log.condition, language)}</span>
            <span>{log.quantity}</span>
            <span className="execution-metric">
              {log.executionPremiumPct !== null ? <>
                <strong className={Number(log.executionPremiumPct) >= 0 ? 'positive' : 'negative'}>{Number(log.executionPremiumPct) >= 0 ? '+' : ''}{log.executionPremiumPct}%</strong>
                <small>{t('ADR premium')}</small>
              </> : log.executionSpreadBps !== null ? <>
                <strong className={Number(log.executionSpreadBps) >= 0 ? 'positive' : 'negative'}>{Number(log.executionSpreadBps) >= 0 ? '+' : ''}{log.executionSpreadBps} bps</strong>
                <small>{t('Actual spread')}</small>
              </> : '—'}
            </span>
            <span>{localizeStrategyLogResult(log.result, language)}</span>
          </div>)}
        </div>
        <footer><span><i /> {t('Persistent backend log')}</span><small>{t('Showing executions for')} {selectedLogStrategy.id} {t('only')}</small></footer>
      </section>
    </div>}
  </>;
}
