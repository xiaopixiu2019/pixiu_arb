import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrossExRiskLimitTier } from '@gate-crossex/shared-types';
import { api } from './api.js';
import { isPositiveDecimal, maxPositionValueAtLeverage } from './route-shared.js';

interface Evidence {
  scope: string;
  current: string | null;
  tiers: CrossExRiskLimitTier[] | null;
  busy: boolean;
  error: string | null;
}
const empty = (scope: string): Evidence => ({ scope, current: null, tiers: null, busy: true, error: null });

function maximum(tiers: CrossExRiskLimitTier[] | null): number | null {
  if (!tiers?.length || tiers.some(t => !isPositiveDecimal(t.leverageMax) || !isPositiveDecimal(t.maxRiskLimitValue))) return null;
  const value = Math.floor(Math.max(...tiers.map(t => Number(t.leverageMax))));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/** Read evidence and writes share a generation: an older response cannot authorize a new selection. */
export function useStrategyLeverage(profileId: string | null | undefined, symbol: string, enabled = true) {
  const scope = `${profileId ?? ''}:${symbol}`;
  const generation = useRef(0);
  const writing = useRef<string | null>(null);
  const reloadAfterWrite = useRef<(() => Promise<void>) | null>(null);
  const [state, setState] = useState<Evidence>(() => empty(scope));
  const evidence = enabled && state.scope === scope ? state : empty(scope);
  const reload = useCallback(async () => {
    if (!enabled) { setState(empty(scope)); return; }
    if (writing.current === scope) return;
    const version = ++generation.current;
    setState(empty(scope));
    try {
      const [leverage, risk] = await Promise.all([api.leverage(symbol), api.riskLimits(symbol)]);
      if (risk.cacheStatus !== 'fresh' || risk.upstreamStatus !== 'healthy') throw new Error('unverified');
      if (leverage.symbol !== symbol || risk.item.symbol !== symbol || !leverage.leverage || !isPositiveDecimal(leverage.leverage)) throw new Error('unverified');
      if (maximum(risk.item.tiers) === null) throw new Error('unverified');
      if (generation.current === version) setState({ scope, current: leverage.leverage, tiers: risk.item.tiers, busy: false, error: null });
    } catch {
      if (generation.current === version) setState({ ...empty(scope), busy: false, error: 'read' });
    }
  }, [enabled, scope, symbol]);
  useEffect(() => {
    reloadAfterWrite.current = reload;
    void reload();
    return () => { generation.current += 1; reloadAfterWrite.current = null; };
  }, [reload]);
  const ceiling = maximum(evidence.tiers);
  const apply = useLeverageApplication(scope, symbol, evidence, ceiling, generation, writing, reloadAfterWrite, setState);
  const limit = evidence.current && evidence.tiers && !evidence.busy && !evidence.error
    ? maxPositionValueAtLeverage(evidence.tiers, Number(evidence.current)) : undefined;
  return { ...evidence, ceiling, limit, ready: limit !== undefined && limit !== null, reload, apply };
}

function useLeverageApplication(scope: string, symbol: string, evidence: Evidence, ceiling: number | null,
  generation: React.RefObject<number>, writing: React.RefObject<string | null>,
  reloadAfterWrite: React.RefObject<(() => Promise<void>) | null>, setState: React.Dispatch<React.SetStateAction<Evidence>>) {
  return useCallback(async (value: string) => {
    if (writing.current || evidence.busy || evidence.error || ceiling === null || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > ceiling) return false;
    writing.current = scope;
    const version = ++generation.current;
    setState(previous => ({ ...previous, busy: true, error: null }));
    try {
      const response = await api.setLeverage(symbol, value);
      if (response.symbol !== symbol || Number(response.leverage) !== Number(value)) throw new Error('unverified');
      if (generation.current !== version) return false;
      setState(previous => ({ ...previous, scope, current: response.leverage, busy: false, error: null }));
      return true;
    } catch {
      // A failed/ambiguous write is reconciled by a read, never an automatic second write.
      if (generation.current === version) setState(previous => ({ ...previous, busy: false, error: 'apply' }));
      return false;
    } finally {
      writing.current = null;
      // A -> B -> A while the write was pending must reconcile A, not stay in an empty busy state.
      if (generation.current !== version) void reloadAfterWrite.current?.();
    }
  }, [ceiling, evidence.busy, evidence.error, generation, reloadAfterWrite, scope, setState, symbol, writing]);
}

export type StrategyLeverageState = ReturnType<typeof useStrategyLeverage>;
