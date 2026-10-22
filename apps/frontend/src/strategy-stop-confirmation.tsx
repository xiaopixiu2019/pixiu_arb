import { useState } from 'react';
import type { StrategyRecord } from './api.js';
import { useDialogFocus } from './route-shared.js';

export function StrategyStopConfirmation({ strategy, language, busy, error, closeOnly = false, confirmDisabled = false, onCancel, onConfirm }: {
  strategy: StrategyRecord; language: string; busy: boolean; onCancel: () => void; onConfirm: (closePositions: boolean) => void;
  error?: string | null;
  closeOnly?: boolean;
  confirmDisabled?: boolean;
}) {
  const [choice, setClosePositions] = useState(false);
  const closePositions = closeOnly || choice;
  const zh = language === 'zh';
  const ref = useDialogFocus(true, busy ? undefined : onCancel);
  return <div className="modal-backdrop confirm-order-backdrop" onMouseDown={() => { if (!busy) onCancel(); }}>
    <section ref={ref} tabIndex={-1} className="confirm-order-modal strategy-confirm-modal" role="dialog" aria-modal="true"
      aria-labelledby="stop-strategy-title" onMouseDown={(e) => e.stopPropagation()}>
      <header><div><h2 id="stop-strategy-title">{zh ? '停止任务' : 'Stop task'}</h2>
        <span>{strategy.config.asset} · {strategy.id}</span></div>
        <button className="disclaimer-close" aria-label={zh ? '取消' : 'Cancel'} disabled={busy} onClick={onCancel}>×</button></header>
      <label className="management-toggle"><input type="checkbox" checked={closePositions} disabled={busy || closeOnly}
        onChange={(e) => setClosePositions(e.target.checked)} />
        <span>{zh ? '同时自动平仓（包含接管旧仓与新增仓位）' : 'Also close all positions (adopted and new)'}</span></label>
      <p className="strategy-confirm-warning">{closePositions
        ? (zh ? '停止新增，核实并撤销未完成订单，按退出设置分批平掉两腿全部托管仓位。' : 'Stop new entries, reconcile and cancel pending orders, then close all managed holdings using the exit settings.')
        : (zh ? '撤销并核实未完成订单后，保留当前仓位；自动监控、失衡保护和条件平仓全部停止。仓位风险由你管理，可随后恢复监控或由新任务接管。' : 'Reconcile and cancel pending orders, then keep current holdings. Monitoring, imbalance protection and automatic exits stop. You manage the remaining risk until explicit resume or adoption by a new task.')}</p>
      <dl className="confirm-order-summary"><div><dt>{zh ? '最近核实的两腿持仓' : 'Last verified holdings'}</dt>
        <dd>{strategy.management?.leftQuantity ?? '—'} / {strategy.management?.rightQuantity ?? '—'} {strategy.config.asset}</dd></div></dl>
      {error && <p className="launch-notice error" role="alert">{error}</p>}
      <div className="confirm-order-actions"><button className="confirm-back" data-dialog-autofocus disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
        <button className={`confirm-submit ${closePositions ? 'sell' : 'buy'}`} disabled={busy || confirmDisabled} onClick={() => onConfirm(closePositions)}>{busy
          ? (zh ? '正在核实并停止…' : 'Reconciling and stopping…')
          : closePositions ? (zh ? '停止并平仓' : 'Stop and close positions') : (zh ? '停止并保留仓位' : 'Stop and keep positions')}</button></div>
    </section>
  </div>;
}
