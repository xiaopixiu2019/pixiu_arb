import { useEffect, useState } from 'react';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { RISK_FRESHNESS_MS } from './risk-presentation.js';

export function riskExpiryDelay(sampledAt: number | null | undefined, renderedAt: number, effectAt: number): number | null {
  const expiresAt = (sampledAt ?? NaN) + RISK_FRESHNESS_MS + 1;
  const delay = expiresAt - effectAt;
  if (!Number.isFinite(delay) || delay > RISK_FRESHNESS_MS + 1) return null;
  if (delay > 0) return delay;
  // A passive effect can run after the boundary crossed during this render.
  return renderedAt < expiresAt ? 0 : null;
}

/** Repaint at expiry; every render still evaluates freshness against the real current time. */
export function useRiskClock(snapshot: MarginSnapshot | null | undefined): void {
  const [tick, setTick] = useState(0);
  const renderedAt = Date.now();
  useEffect(() => {
    const redraw = () => setTick(value => value + 1);
    const interval = window.setInterval(redraw, 1000);
    window.addEventListener('focus', redraw);
    document.addEventListener('visibilitychange', redraw);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', redraw);
      document.removeEventListener('visibilitychange', redraw);
    };
  }, []);
  useEffect(() => {
    const delay = riskExpiryDelay(snapshot?.sampledAt, renderedAt, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(() => setTick(value => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [snapshot?.accountId, snapshot?.sampledAt, tick, renderedAt]);
}
