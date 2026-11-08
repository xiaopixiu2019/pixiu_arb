import { useEffect } from 'react';
export const RISK_LEAVE_EVENT = 'risk-settings-before-leave';
export function allowRiskDraftLeave(): boolean { return window.dispatchEvent(new Event(RISK_LEAVE_EVENT, { cancelable: true })); }

/** One guard shared by route navigation and account switching; it never submits a draft. */
export function useRiskDraftGuard(dirty: boolean, busy: boolean, zh: boolean) {
  useEffect(() => {
    if (!dirty && !busy) return;
    const message = zh ? '保护参数尚未保存或结果仍待核实。离开将放弃本页草稿，是否继续？' : 'Risk settings are unsaved or unverified. Leave and discard this draft?';
    const leave = (event: Event) => { if (busy || !window.confirm(message)) event.preventDefault(); };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener(RISK_LEAVE_EVENT, leave); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener(RISK_LEAVE_EVENT, leave); window.removeEventListener('beforeunload', unload); };
  }, [busy, dirty, zh]);
}
