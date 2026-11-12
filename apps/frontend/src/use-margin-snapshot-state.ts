import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import { olderRiskSnapshot, supersededRiskReply } from './risk-policy-draft.js';
import { riskFresh } from './risk-presentation.js';
import { acceptRiskHttpTiming, riskEvidenceClock } from './risk-evidence-clock.js';

/** HTTP replies cannot roll back the live view; stream status invalidation remains authoritative. */
export function useMarginSnapshotState() {
  const [snapshot, setSnapshot] = useState<MarginSnapshot | null>(null);
  const current = useRef<MarginSnapshot | null>(null), epoch = useRef(0);
  const commit = useCallback((next: MarginSnapshot | null) => { current.current = next; setSnapshot(next); }, []);
  const receive = useCallback((next: MarginSnapshot, stream: boolean) => {
    const previous = current.current;
    const clockEvidence = stream ? riskEvidenceClock.observe(next) : undefined;
    const invalidation = stream && (!next.fresh || next.status === 'unavailable'
      || clockEvidence === false || riskEvidenceClock.now(next.accountId) !== null && !riskFresh(next));
    if (previous && previous.accountId !== next.accountId) {
      // An unverified/null account is not a different verified account. HTTP-only startup must recover.
      if (!stream && previous.accountId !== null) return;
      riskEvidenceClock.reset();
      epoch.current += 1;
    } else if (previous) {
      if (next.policy.revision < previous.policy.revision) return;
      // An invalid/future-dated observation cannot become a timestamp watermark that blocks recovery.
      if (!invalidation && olderRiskSnapshot(next, previous) && (!stream || riskFresh(previous))) return;
    }
    // Invalidation can retain the last good sample time. Earlier pending HTTP cannot undo it.
    if (invalidation) epoch.current += 1;
    if (!stream) acceptRiskHttpTiming(next);
    commit(clockEvidence === false ? { ...next, fresh: false } : next);
  }, [commit]);
  const accept = useCallback((next: MarginSnapshot) => receive(next, false), [receive]);
  const stream = useCallback((next: MarginSnapshot) => receive(next, true), [receive]);
  const clear = useCallback(() => { epoch.current += 1; riskEvidenceClock.reset(); commit(null); }, [commit]);
  const reading = useRef(false), calibrating = useRef(false);
  const read = useCallback(async (active: () => boolean) => {
    if (reading.current) return;
    reading.current = true;
    const version = epoch.current, before = current.current;
    try {
      const { riskApi } = await import('./risk-api.js');
      const next = await riskApi.snapshot();
      if (active() && version === epoch.current && (!current.current?.accountId || current.current.accountId === next.accountId)) {
        const calibrated = acceptRiskHttpTiming(next);
        if (!current.current || !supersededRiskReply(next, current.current, before)) accept(next);
        else if (calibrated !== undefined) commit({ ...current.current }); // Repaint clock changes without rolling back newer control state.
      }
    } catch {
      if (active() && version === epoch.current && current.current === before && before) commit({ ...before, fresh: false });
    } finally { reading.current = false; }
  }, [accept, commit]);
  const calibrate = useCallback(async (active: () => boolean) => {
    const account=current.current?.accountId;
    if(!account||calibrating.current)return;
    calibrating.current=true;
    try{
      const {riskApi}=await import('./risk-api.js'),probe=await riskApi.clock();
      if(active()&&current.current?.accountId===account&&probe.accountId===account
        &&riskEvidenceClock.calibrate(account,probe.serverAt,probe.sent,probe.received)&&current.current)
        commit({...current.current});
    }catch{/* Missing clock evidence remains unavailable; the slow account endpoint is not a time source. */}
    finally{calibrating.current=false;}
  },[commit]);
  useEffect(() => {
    let active = true;
    const refresh = () => { if (current.current?.accountId && riskEvidenceClock.needsCalibration(current.current.accountId)) void calibrate(() => active); };
    const invalidate = () => {
      epoch.current += 1; riskEvidenceClock.reset();
      if (current.current) commit({ ...current.current, fresh: false });
      refresh();
    };
    const wake = () => { if (document.visibilityState === 'visible') invalidate(); };
    const timer = window.setInterval(refresh, 5000);
    refresh();
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    window.addEventListener('risk-stream-reconnected', invalidate);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); window.removeEventListener('risk-stream-reconnected', invalidate); };
  }, [calibrate, commit, snapshot?.accountId]);
  return { snapshot, accept, stream, clear, read };
}
