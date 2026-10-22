import type { FundingHistorySeriesResponse } from '@gate-crossex/shared-types';

/** Read-only polling: a transient timeout is not permanent absence of funding history. */
export function startFundingHistoryRefresh(
  load: (signal: AbortSignal) => Promise<FundingHistorySeriesResponse>,
  onValue: (value: FundingHistorySeriesResponse) => void,
  onFailure: () => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const refresh = async () => {
    try {
      const response = await load(controller.signal);
      if (controller.signal.aborted) return;
      failures = 0;
      onValue(response);
    } catch {
      if (controller.signal.aborted) return;
      failures = Math.min(failures + 1, 4);
      onFailure();
    } finally {
      if (!controller.signal.aborted) {
        const delay = failures ? Math.min(30_000, 5_000 * 2 ** (failures - 1)) : 60_000;
        timer = setTimeout(() => { void refresh(); }, delay);
      }
    }
  };
  void refresh();
  return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
}
