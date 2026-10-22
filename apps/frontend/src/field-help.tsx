import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './field-help.css';

/** A click/keyboard explanation, separate from live risk warnings and form input. */
export function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<DOMRect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'scroll') {
        if (event.target instanceof Node && panel.current?.contains(event.target)) return;
        const current = trigger.current?.getBoundingClientRect(), opened = anchor.current;
        if (current && opened && current.top === opened.top && current.left === opened.left
          && current.width === opened.width && current.height === opened.height) return;
      }
      if (['pointerdown', 'focusin'].includes(event.type) && (panel.current?.contains(event.target as Node) || trigger.current?.contains(event.target as Node))) return;
      setPosition(null);
      if (event.type === 'keydown') trigger.current?.focus();
    };
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) setPosition(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    document.addEventListener('focusin', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('field-help-open', other);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); document.removeEventListener('focusin', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('field-help-open', other); };
  }, [id, position]);
  return <span className="field-help">
    <button ref={trigger} type="button" aria-label={`${label} · ?`} aria-expanded={position !== null} aria-controls={position ? id : undefined} aria-describedby={position ? id : undefined}
      onClick={(event) => {
        event.preventDefault(); event.stopPropagation();
        if (position) { setPosition(null); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        anchor.current = rect;
        window.dispatchEvent(new CustomEvent('field-help-open', { detail: id }));
        setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 340)), top: rect.bottom + 8 > window.innerHeight - 220 ? Math.max(12, rect.top - 210) : rect.bottom + 8 });
      }}>!</button>
    {position && createPortal(<div ref={panel} id={id} role="note" aria-label={label} className="field-help-popover" style={position}>
      <strong>{label}</strong><div>{children}</div>
    </div>, document.body)}
  </span>;
}
