import type { ReactNode } from 'react';
import { useLanguage } from './i18n.js';
import { useDialogFocus } from './route-shared.js';

export interface StrategyConfirmationRow {
  label: string;
  value: ReactNode;
  tone?: 'positive' | 'negative';
}

export function StrategyLaunchConfirmation({
  market,
  rows,
  busy,
  managed = false,
  onCancel,
  onConfirm,
}: {
  market: string;
  rows: StrategyConfirmationRow[];
  busy: boolean;
  managed?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t, language } = useLanguage();
  const dialogRef = useDialogFocus(true, busy ? undefined : onCancel);

  return <div className="modal-backdrop confirm-order-backdrop" role="presentation" onMouseDown={() => { if (!busy) onCancel(); }}>
    <section ref={dialogRef} tabIndex={-1} className="confirm-order-modal strategy-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-strategy-title" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div>
          <p className="eyebrow">{t('Live automation')}</p>
          <h2 id="confirm-strategy-title">{t('Confirm strategy launch')}</h2>
          <span className="confirm-market">{market}</span>
        </div>
        <button className="disclaimer-close" aria-label={t('Close')} onClick={onCancel} disabled={busy}>×</button>
      </header>
      <p className="strategy-confirm-warning">{t('Review the strategy details before starting live automated execution.')}</p>
      <p className="strategy-confirm-warning">{managed ? language === 'zh'
        ? '启动同时授权本托管组按账户IMR/MMR规则自动减仓，覆盖接管与新增的合并仓位。建仓核实且执行条件具备后，账户触线可先于经济退出分批减仓；可在风险管理页取消后续批次授权。'
        : 'Starting authorizes account IMR/MMR reduction for this managed group, including adopted and added holdings. After holdings and execution conditions are verified, account risk may reduce positions before economic exit. Revoke future batches in Risk Management.'
        : language === 'zh' ? '本任务未启用持仓管理，不新增保证金自动减仓授权。'
          : 'This task has no managed position group and adds no automatic margin reduction authority.'}</p>
      <dl className="confirm-order-summary">
        {rows.map((row, index) => <div key={`${row.label}:${index}`}><dt>{row.label}</dt><dd className={row.tone}>{row.value}</dd></div>)}
      </dl>
      <div className="confirm-order-actions">
        <button className="confirm-back" data-dialog-autofocus onClick={onCancel} disabled={busy}>{t('Go back')}</button>
        <button className="confirm-submit buy" disabled={busy} onClick={onConfirm}>
          <strong>{busy ? t('Launching…') : t('Run strategy')}</strong>
          <span>{t('This will start live automated execution.')}</span>
        </button>
      </div>
    </section>
  </div>;
}
