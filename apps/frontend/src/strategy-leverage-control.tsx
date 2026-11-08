import { useRef, useState } from 'react';
import { useLanguage } from './i18n.js';
import { marketSymbol } from './market-symbol.js';
import { formatAmount, maxPositionValueAtLeverage } from './route-shared.js';
import { StrategyHelp } from './strategy-help.js';
import { StrategyLeveragePanel } from './strategy-leverage-panel.js';
import type { StrategyLeverageState } from './use-strategy-leverage.js';
import type { TradingMode } from './api.js';

interface Props {
  label: string; symbol: string; exchangeName: string; asset: string; quote: string;
  referencePrice: number; tradingMode: TradingMode | null; disabled?: boolean;
  onOpenModeDialog: () => void; control: StrategyLeverageState;
}
function leverageWarning(control: StrategyLeverageState, zh: boolean): string | null {
  if (control.error) return zh ? '杠杆尚未核实；请重新读取，确认前不能启动或再次应用。'
    : 'Leverage is unverified. Recheck before launching or applying again.';
  if (control.busy) return zh ? '正在核实杠杆与风险档位…' : 'Verifying leverage and risk tiers…';
  if (control.current && control.ceiling !== null && Number(control.current) > control.ceiling) return zh
    ? `当前杠杆 ${control.current}× 超过最高 ${control.ceiling}×；请选择并应用允许的杠杆。`
    : `Current leverage ${control.current}× exceeds maximum ${control.ceiling}×. Select and apply an allowed leverage.`;
  return null;
}

/** Display, review and submission all consume the parent's confirmed, scope-bound evidence. */
export function StrategyLeverageControl({ label, exchangeName, asset, quote, referencePrice, tradingMode,
  disabled = false, onOpenModeDialog, control }: Props) {
  const { language, t } = useLanguage();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState('');
  const leverageCeiling = control.ceiling, currentLabel = control.current ? `${control.current}×` : '—';
  const warning = leverageWarning(control, language === 'zh');
  const canApply = tradingMode === 'live' && !disabled && !control.busy && !control.error && leverageCeiling !== null
    && /^\d+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= leverageCeiling;
  const presets = [...new Set([1, 3, 5, 10, 20, leverageCeiling ?? 1])].filter(n => leverageCeiling !== null && n <= leverageCeiling).sort((a,b) => a-b);
  const draftMaxPositionValue = canApply ? maxPositionValueAtLeverage(control.tiers, Number(draft)) : null;
  const draftMaxPositionQuantity = draftMaxPositionValue !== null && referencePrice > 0 ? draftMaxPositionValue / referencePrice : null;
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const openEditor = () => {
    if (disabled) return;
    if (tradingMode !== 'live') { onOpenModeDialog(); return; }
    setDraft(String(Math.min(leverageCeiling ?? 1, Number(control.current) || 1))); setOpen(true);
  };
  const adjust = (delta: number) => setDraft(String(Math.min(leverageCeiling ?? 1, Math.max(1, (Number(draft) || 1) + delta))));
  const apply = async () => { if (canApply && await control.apply(draft)) close(); };
  return <div className={`premium-leverage-setting${disabled ? ' inactive-for-reduce-only' : ''}`} aria-disabled={disabled || control.busy}>
    <span>{t(label)}<StrategyHelp name={label} /></span>
    <div className="leverage-control">
      <button ref={triggerRef} type="button" className={`leverage-trigger${open ? ' open' : ''}`} onClick={openEditor} aria-haspopup="dialog" aria-expanded={open} aria-label={`${t(label)}: ${currentLabel}`} title={t('Set leverage')} disabled={disabled || control.busy}>
        {currentLabel} <span>⌄</span>
      </button>
      {open && <StrategyLeveragePanel anchor={triggerRef} onClose={close} label={t('Adjust leverage')}>
        <header><div><strong>{t('Adjust leverage')}</strong><span>{exchangeName} · {marketSymbol(asset, quote, 'perpetual')}</span></div><button onClick={close} aria-label={t('Close')}>✕</button></header>
        <dl><div><dt>{t('Current leverage')}</dt><dd>{currentLabel}</dd></div><div><dt>{t('Max leverage')}</dt><dd>{leverageCeiling ?? '—'}×</dd></div><div className="leverage-position-cap"><dt>{t('Max position at selected leverage')}</dt><dd>{draftMaxPositionValue !== null ? `${formatAmount(draftMaxPositionValue)} ${quote}` : '—'}{draftMaxPositionQuantity !== null && <small>≈ {formatAmount(draftMaxPositionQuantity, 6)} {asset}</small>}</dd></div></dl>
        <div className="leverage-stepper">
          <button onClick={() => adjust(-1)} aria-label="Decrease leverage">−</button>
          <label><input type="number" min="1" max={leverageCeiling ?? 1} step="1" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t('Leverage')} /><b>×</b></label>
          <button onClick={() => adjust(1)} aria-label="Increase leverage">+</button>
        </div>
        <input className="leverage-range" type="range" min="1" max={leverageCeiling ?? 1} step="1" value={Math.min(leverageCeiling ?? 1, Math.max(1, Number(draft) || 1))} onChange={(event) => setDraft(event.target.value)} aria-label={t('Leverage')} />
        <div className="leverage-presets">{presets.map((preset) => <button className={Number(draft) === preset ? 'active' : ''} key={preset} onClick={() => setDraft(String(preset))}>{preset}×</button>)}</div>
        {warning && <p role="alert">{warning}</p>}
        <button className="apply-leverage" onClick={() => void apply()} disabled={!canApply}>{control.busy ? t('Applying…') : t('Apply leverage')}</button>
      </StrategyLeveragePanel>}
    </div>
    {!disabled && warning && <p className="strategy-leverage-warning" role="alert">{warning}</p>}
    {!disabled && control.error && <button type="button" onClick={() => void control.reload()} disabled={control.busy}>
      {language === 'zh' ? '重新读取杠杆' : 'Recheck leverage'}</button>}
  </div>;
}
