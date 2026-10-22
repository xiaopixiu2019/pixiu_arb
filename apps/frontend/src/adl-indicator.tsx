import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n.js';
import {
  adlRiskTone,
  crossExAdlLightLevel,
  exchangeAdlLightLevel,
  type AdlRankDisplay,
} from './adl-ranking.js';

interface TooltipPlacement {
  left: number;
  top: number;
  arrowLeft: number;
  below: boolean;
}

function AdlSignal({ level, description, explanation }: { level: number | null; description: string; explanation: string }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const tooltipWidth = Math.min(380, Math.max(220, window.innerWidth - 24));
      const center = rect.left + rect.width / 2;
      const left = Math.min(window.innerWidth - tooltipWidth / 2 - 12, Math.max(tooltipWidth / 2 + 12, center));
      const below = rect.top < 150;
      setPlacement({
        left,
        top: below ? rect.bottom + 11 : rect.top - 11,
        arrowLeft: center - left + tooltipWidth / 2,
        below,
      });
    };
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [open]);

  const tooltipStyle = placement ? {
    left: placement.left,
    top: placement.top,
    '--adl-tooltip-arrow-left': `${placement.arrowLeft}px`,
  } as CSSProperties : undefined;

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`adl-signal ${adlRiskTone(level)}`}
      aria-label={description}
      aria-describedby={open ? tooltipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (document.activeElement !== triggerRef.current) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className="adl-lights" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((light) => <i className={level !== null && light <= level ? 'lit' : ''} key={light} />)}
      </span>
    </button>
    {open && placement && typeof document !== 'undefined' && createPortal(
      <span id={tooltipId} role="tooltip" className={`adl-tooltip ${placement.below ? 'below' : ''}`} style={tooltipStyle}>
        <span>{explanation}</span>
        <small>{description}</small>
      </span>,
      document.body,
    )}
  </>;
}

export function AdlIndicators({ ranks }: { ranks: readonly AdlRankDisplay[] }) {
  const { t } = useLanguage();
  if (ranks.length === 0) return <span className="adl-unavailable">—</span>;
  const explanation = t('It indicates the position in ADL ranking. When all lights are lit, the position is at the top of the ADL preference hierarchy.');
  return <div className="adl-indicators">
    {ranks.map((rank) => {
      const exchangeLevel = exchangeAdlLightLevel(rank.venue, rank.exchangeRank);
      const crossExLevel = crossExAdlLightLevel(rank.crossExRank);
      const exchangeText = exchangeLevel === null
        ? t('unavailable')
        : `${exchangeLevel}/5 (${t('raw rank')} ${rank.exchangeRank})`;
      const crossExText = crossExLevel === null ? t('unavailable') : `${crossExLevel}/5`;
      const description = `${rank.venue} · ${t('Exchange ADL')}: ${exchangeText} · ${t('CrossEx ADL')}: ${crossExText}`;
      const level = crossExLevel ?? exchangeLevel;
      return <span className="adl-rank-row" key={rank.key}>
        {ranks.length > 1 && <small>{rank.venue.slice(0, 3)}</small>}
        <AdlSignal level={level} description={description} explanation={explanation} />
      </span>;
    })}
  </div>;
}
