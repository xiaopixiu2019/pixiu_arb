import { useEffect, useState } from 'react';
import { api, type FundingOverviewResponse } from './api.js';

const POSITION_FUNDING_REFRESH_MS = 30_000;
const POSITION_FUNDING_LAST_GOOD_MS = 60_000;

const lastGoodOverviews = new Map<string, { value: FundingOverviewResponse; receivedAt: number }>();

function recentOverview(key: string, now = Date.now()): FundingOverviewResponse | null {
  const cached = lastGoodOverviews.get(key);
  if (!cached || now - cached.receivedAt > POSITION_FUNDING_LAST_GOOD_MS) return null;
  return cached.value;
}

export function positionFundingRefreshDelay(startedAt: number, completedAt = Date.now()): number {
  return Math.max(0, POSITION_FUNDING_REFRESH_MS - (completedAt - startedAt));
}

export function usePositionFundingOverview(active: boolean, symbols?: readonly string[]): FundingOverviewResponse | null {
  const key = symbols ? JSON.stringify([...new Set(symbols)].sort()) : 'all';
  const [snapshot, setSnapshot] = useState<{ key: string; value: FundingOverviewResponse | null }>(() => ({ key, value: active ? recentOverview(key) : null }));

  useEffect(() => {
    if (!active) {
      setSnapshot({ key, value: null });
      return;
    }
    let cancelled = false;
    setSnapshot({ key, value: recentOverview(key) });
    let loading = false;
    let lastStartedAt = 0;
    let timer: number | undefined;
    const load = async () => {
      if (cancelled || loading) return;
      loading = true;
      lastStartedAt = Date.now();
      try {
        const response = await api.fundingOverview(key === 'all' ? undefined : JSON.parse(key) as string[]);
        if (cancelled) return;
        lastGoodOverviews.delete(key);
        lastGoodOverviews.set(key, { value: response, receivedAt: Date.now() });
        if (lastGoodOverviews.size > 32) lastGoodOverviews.delete(lastGoodOverviews.keys().next().value!);
        setSnapshot({ key, value: response });
      } catch {
        if (!cancelled) setSnapshot({ key, value: recentOverview(key) });
      } finally {
        loading = false;
        if (!cancelled) {
          const remaining = positionFundingRefreshDelay(lastStartedAt);
          timer = window.setTimeout(() => { void load(); }, remaining);
        }
      }
    };
    const refreshIfDue = () => {
      if (Date.now() - lastStartedAt < POSITION_FUNDING_REFRESH_MS) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void load();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshIfDue();
    };
    void load();
    window.addEventListener('focus', refreshIfDue);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshIfDue);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, key]);

  return active && snapshot.key === key ? snapshot.value : null;
}
