import { useCallback, useRef, useState } from 'react';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { olderRiskSnapshot, supersededRiskReply } from './risk-policy-draft.js';
import { riskFresh } from './risk-presentation.js';

/** HTTP replies cannot roll back the live view; stream status invalidation remains authoritative. */
export function useMarginSnapshotState() {
  const [snapshot, setSnapshot] = useState<MarginSnapshot | null>(null);
  const current = useRef<MarginSnapshot | null>(null), epoch = useRef(0);
  const commit = useCallback((next: MarginSnapshot | null) => { current.current = next; setSnapshot(next); }, []);
  const receive = useCallback((next: MarginSnapshot, stream: boolean) => {
    const previous = current.current;
    const invalidation = stream && !riskFresh(next, Date.now());
    if (previous && previous.accountId !== next.accountId) {
      // An unverified/null account is not a different verified account. HTTP-only startup must recover.
      if (!stream && previous.accountId !== null) return;
      epoch.current += 1;
    } else if (previous) {
      if (next.policy.revision < previous.policy.revision) return;
      // An invalid/future-dated observation cannot become a timestamp watermark that blocks recovery.
      if (!invalidation && olderRiskSnapshot(next, previous) && (!stream || riskFresh(previous, Date.now()))) return;
    }
    // Invalidation can retain the last good sample time. Earlier pending HTTP cannot undo it.
    if (invalidation) epoch.current += 1;
    commit(next);
  }, [commit]);
  const accept = useCallback((next: MarginSnapshot) => receive(next, false), [receive]);
  const stream = useCallback((next: MarginSnapshot) => receive(next, true), [receive]);
  const clear = useCallback(() => { epoch.current += 1; commit(null); }, [commit]);
  const read = useCallback(async (active: () => boolean) => {
    const version = epoch.current, before = current.current;
    try {
      const { riskApi } = await import('./risk-api.js');
      const next = await riskApi.snapshot();
      if (active() && version === epoch.current && (!current.current || !supersededRiskReply(next, current.current, before))) accept(next);
    } catch {
      if (active() && version === epoch.current && current.current === before && before) commit({ ...before, fresh: false });
    }
  }, [accept, commit]);
  return { snapshot, accept, stream, clear, read };
}
