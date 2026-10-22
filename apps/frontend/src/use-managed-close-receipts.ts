import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedCloseTarget, StrategyRecord } from '@gate-crossex/shared-types';
import { closeReceipt, reconcileReceipt, transitionReceipt, type CloseReceipt } from './managed-close-receipt.js';

export const ManagedCloseReceiptsContext = createContext<ReturnType<typeof useManagedCloseReceipts> | null>(null);

/** App-session display evidence survives route/tab changes; exact account identity stays on every receipt. */
export function useManagedCloseReceipts(records: readonly StrategyRecord[]) {
  const [receipts, setReceipts] = useState<CloseReceipt[]>([]);
  const current = useRef<CloseReceipt[]>([]);
  const alive = useRef(true);
  const publish = useCallback((next: CloseReceipt[]) => { current.current = next; setReceipts(next); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const previous = current.current, next = previous.map(receipt => reconcileReceipt(receipt, records));
    if (!next.every((r, i) => r === previous[i])) publish(next);
  }, [records, publish]);
  const begin = (target: ManagedCloseTarget) => {
    if (current.current.some(r => r.strategyId === target.strategy.id)) return null;
    const receipt = closeReceipt(target);
    publish([...current.current, receipt]); return receipt;
  };
  const update = (id: string, state: CloseReceipt['state'], record?: StrategyRecord) => {
    if (!alive.current) return;
    const next = current.current.map(r => r.strategyId === id
      ? reconcileReceipt(transitionReceipt(r, state), record ? [record] : []) : r);
    publish(next); return next.find(r => r.strategyId === id);
  };
  return { receipts, alive, begin, update, read: (id: string) => current.current.find(r => r.strategyId === id) };
}
