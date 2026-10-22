import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { VenueIcon } from './route-shared.js';

export interface VenueSelectOption {
  id: string;
  name: string;
  short: string;
  disabled?: boolean;
  /** Small line under the venue name inside the menu (e.g. the venue-native ticker). */
  detail?: string;
}

interface VenueSelectProps {
  /** Small caption inside the trigger and title of the menu header. */
  label: string;
  /** Small text on the right of the menu header (e.g. the market name). */
  menuSubtitle?: string;
  /** Optional status line rendered next to the selected venue name (trade page health badge). */
  status?: ReactNode;
  options: readonly VenueSelectOption[];
  value: string;
  onSelect: (venueId: string) => void;
  className?: string;
  help?: ReactNode;
}

/** The app-standard exchange dropdown: icon trigger plus keyboard-navigable menu. */
export function VenueSelect({ label, menuSubtitle, status, options, value, onSelect, className, help }: VenueSelectProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selected = options.find((option) => option.id === value) ?? options[0];

  const enabledIndexes = () => options
    .map((option, index) => option.disabled ? -1 : index)
    .filter((index) => index >= 0);

  const focusOption = (index: number) => {
    setHighlight(index);
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  };

  const openFromKeyboard = (direction: 1 | -1) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const selectedIndex = options.findIndex((option) => option.id === value);
    const selectedPosition = enabled.indexOf(selectedIndex);
    const targetPosition = selectedPosition >= 0
      ? (selectedPosition + (direction > 0 ? 0 : enabled.length - 1)) % enabled.length
      : direction > 0 ? 0 : enabled.length - 1;
    setMenuOpen(true);
    focusOption(enabled[targetPosition]);
  };

  const choose = (venueId: string) => {
    setMenuOpen(false);
    if (venueId !== value) onSelect(venueId);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openFromKeyboard(event.key === 'ArrowDown' ? 1 : -1);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const currentPosition = Math.max(0, enabled.indexOf(highlight));
    let targetPosition: number | null = null;
    if (event.key === 'ArrowDown') targetPosition = (currentPosition + 1) % enabled.length;
    else if (event.key === 'ArrowUp') targetPosition = (currentPosition - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') targetPosition = 0;
    else if (event.key === 'End') targetPosition = enabled.length - 1;
    if (targetPosition === null) return;
    event.preventDefault();
    focusOption(enabled[targetPosition]);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  if (!selected) return null;
  return <div className={`exchange-control${className ? ` ${className}` : ''}`} ref={rootRef}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
    }}>
    <button ref={triggerRef} type="button" className={`exchange-selector${menuOpen ? ' open' : ''}`}
      onClick={() => {
        setHighlight(Math.max(0, options.findIndex((option) => option.id === value)));
        setMenuOpen((current) => !current);
      }} onKeyDown={onTriggerKeyDown}
      aria-label={`${label}: ${selected.name}`} aria-haspopup="menu" aria-expanded={menuOpen}
      aria-controls={menuOpen ? menuId : undefined}>
      <VenueIcon id={selected.id} short={selected.short} />
      <span className="exchange-details">
        <small>{label}</small>
        <span className="exchange-summary">
          <strong>{selected.name}</strong>
          {status}
        </span>
      </span>
      <span className="exchange-chevron" aria-hidden="true">⌄</span>
    </button>
    {help}
    {menuOpen && <div id={menuId} className="exchange-menu" role="menu" aria-label={label}
      onKeyDown={onMenuKeyDown}>
      <header><span>{label}</span>{menuSubtitle && <small>{menuSubtitle}</small>}</header>
      <div className="exchange-menu-list">
        {options.map((option, index) => {
          const isSelected = option.id === value;
          return <button key={option.id} type="button" ref={(node) => { itemRefs.current[index] = node; }}
            className={`${isSelected ? 'selected' : ''}${index === highlight ? ' highlighted' : ''}`}
            role="menuitemradio" aria-checked={isSelected} disabled={option.disabled} tabIndex={index === highlight ? 0 : -1}
            onMouseEnter={() => { if (!option.disabled) setHighlight(index); }} onClick={() => choose(option.id)}>
            <VenueIcon id={option.id} short={option.short} />
            <span><strong>{option.name}</strong>{option.detail && <small>{option.detail}</small>}</span>
            {isSelected && <i className="exchange-check" aria-hidden="true">✓</i>}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
