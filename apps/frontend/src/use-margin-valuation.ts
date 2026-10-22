import { useEffect, useState } from 'react';
import { riskApi } from './risk-api.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
export function useMarginValuation(profileId: string | null | undefined, enabled: boolean) {
  const [value, setValue] = useState<{ profile: string; valuation: MarginSnapshot['valuation'] } | null>(null);
  useEffect(() => {
    if (!profileId || !enabled) return;
    let stopped = false;
    const read = async () => {
      try { const result = await riskApi.snapshot(); if (!stopped) setValue({ profile: profileId, valuation: result.valuation?.profileId === profileId ? result.valuation : null }); }
      catch { if (!stopped) setValue(null); }
    };
    void read(); const timer = window.setInterval(() => void read(), 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [enabled, profileId]);
  return value?.profile === profileId && value?.valuation && Date.now() - value.valuation.checkedAt <= 60000
    && value.valuation.checkedAt <= Date.now() ? value.valuation.rates : undefined;
}
