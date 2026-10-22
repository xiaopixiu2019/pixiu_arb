import { useEffect, useState } from 'react';
import type { AccountPerformance, PerformanceRange } from '@gate-crossex/shared-types';
import { api } from './api.js';

export function useAccountPerformance(profileId: string | null, range: PerformanceRange) {
  const [data, setData] = useState<AccountPerformance | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let loading = false;
    setData(null); setError(false);
    if (!profileId) return () => controller.abort();
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const response = await api.accountPerformance(range, controller.signal);
        if (!controller.signal.aborted) {
          if (response.profileId === profileId) { setData(response); setError(false); }
          else { setData(null); setError(true); }
        }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { loading = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [profileId, range]);
  return { data: data?.profileId === profileId ? data : null, error };
}
