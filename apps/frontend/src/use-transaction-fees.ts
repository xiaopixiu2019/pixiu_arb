import { useEffect, useState } from 'react';
import type { FeeSummary } from '@gate-crossex/shared-types';
import { api } from './api.js';

export function useTransactionFees(profileId: string | null) {
  const [data, setData] = useState<FeeSummary | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let loading = false;
    setData(null); setError(false);
    if (!profileId) return () => controller.abort();
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const result = await api.transactionFees(controller.signal);
        if (controller.signal.aborted) return;
        if (result.profileId !== profileId) { setData(null); setError(true); }
        else { setData(result); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { loading = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileId]);
  return { data: data?.profileId === profileId ? data : null, error };
}
