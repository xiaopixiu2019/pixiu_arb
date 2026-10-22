import { useId, type ReactNode } from 'react';

export interface HedgeReviewGroup {
  title: string;
  rows: Array<{ label: string; value: ReactNode }>;
  wide?: boolean;
  fees?: boolean;
}

/** Display-only review; the parent retains validation, confirmation and submission authority. */
export function HedgeReview({ groups, notes, warnings = [], zh }: { groups: HedgeReviewGroup[]; notes: string[]; warnings?: string[]; zh: boolean }) {
  const id = useId();
  const cards = (wide: boolean) => groups.map((group, index) => Boolean(group.wide) === wide && <section key={group.title}
    className={`hedge-review-group${group.wide ? ' wide' : ''}${group.fees ? ' fees' : ''}`} aria-labelledby={`${id}-${index}`}>
    <h3 id={`${id}-${index}`}>{group.title}</h3>
    <dl>{group.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
  </section>);
  return <div className="hedge-review">
    <header className="hedge-review-heading">
      <span className="hedge-step-number">03</span>
      <div><h2>{zh ? '审核并执行' : 'Review & execute'}</h2>
        <p>{zh ? '核对方向、规模、费用与退出规则' : 'Review direction, size, fees and exit rules'}</p></div>
    </header>
    <div className="hedge-review-grid">{cards(false)}</div>
    {warnings.map(warning => <p key={warning} role="alert" className="hedge-review-warning">{warning}</p>)}
    <details className="hedge-review-details">
      <summary>{zh ? '保证金、退出与保护详情' : 'Margin, exit & protection details'}</summary>
      <div className="hedge-review-grid">{cards(true)}</div>
      <div className="hedge-review-notes">{notes.map(note => <p key={note}>{note}</p>)}</div>
    </details>
  </div>;
}
