import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { riskAmount } from './risk-presentation.js';
import { policyDraft, riskKinds, riskLevels, thresholdError, thresholdLabels, type RiskPolicyDraft, type RiskKind } from './risk-policy-draft.js';
import type { RiskPolicyEditor } from './use-risk-policy-editor.js';

export function RiskParameterMatrix({ snapshot, model, zh }: { snapshot: MarginSnapshot; model: RiskPolicyEditor; zh: boolean }) {
  const draft = model.editor?.draft ?? policyDraft(snapshot.effectivePolicy);
  const disabled = model.editor?.phase !== 'editing';
  return <div className="risk-threshold-grid">{riskKinds.map(kind => <ParameterRow key={kind} kind={kind} draft={draft}
    snapshot={snapshot} model={model} zh={zh} disabled={disabled} />)}</div>;
}

function ParameterRow({ kind, draft, snapshot, model, zh, disabled }: { kind: RiskKind; draft: RiskPolicyDraft;
  snapshot: MarginSnapshot; model: RiskPolicyEditor; zh: boolean; disabled: boolean }) {
  const initial = kind === 'initial', label = initial ? 'IMR' : 'MMR';
  const current = initial ? snapshot.metrics?.initialPct : snapshot.metrics?.maintenancePct;
  return <section className="risk-parameter-row" aria-label={label}>
    <div className="risk-parameter-name"><strong>{label}</strong><span>{initial ? (zh ? '起始保证金率' : 'Initial margin ratio') : (zh ? '维持保证金率' : 'Maintenance margin ratio')}</span>
      <small>{zh ? '当前' : 'Current'} {riskAmount(current)}{current == null ? '' : '%'}</small></div>
    <div className="risk-parameter-cells">{riskLevels.map((level, index) => {
      const before = model.editor?.base[kind][level], changed = before !== undefined && Number(draft[kind][level]) !== before;
      const error = model.editor ? thresholdError(draft[kind], level, zh) : null;
      const id = `risk-${kind}-${level}`, deferred = !model.editor && snapshot.policy[kind][level] !== snapshot.effectivePolicy[kind][level];
      return <label key={level} className={`risk-parameter-cell${changed ? ' changed' : ''}`} htmlFor={id}>
        <span>{thresholdLabels(zh)[index]} (%)</span><div className="risk-parameter-input"><input id={id} type="text" inputMode="decimal"
          value={draft[kind][level]} readOnly={disabled} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
          onChange={e => model.change({ ...draft, [kind]: { ...draft[kind], [level]: e.target.value } })} /><b aria-hidden="true">%</b></div>
        {error ? <small id={`${id}-error`} className="risk-field-error">{error}</small>
          : changed ? <small>{before}% → {draft[kind][level]}%</small>
            : deferred ? <small>{zh ? '已保存，后续事件' : 'Saved for later events'} {snapshot.policy[kind][level]}%</small>
              : <small>{model.editor ? (zh ? '保持已保存值' : 'Unchanged') : (zh ? '当前有效值' : 'Effective value')}</small>}
      </label>;
    })}</div>
  </section>;
}
