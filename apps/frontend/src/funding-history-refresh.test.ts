import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FundingHistorySeriesResponse } from '@gate-crossex/shared-types';
import { startFundingHistoryRefresh } from './funding-history-refresh.js';

afterEach(() => { vi.useRealTimers(); });
const response: FundingHistorySeriesResponse = { entries: [], from: 0, to: 1, fetchedAt: '2026-09-29T00:00:00Z' };

describe('funding history read recovery', () => {
  it('recovers after a transient timeout without requiring selection or page reload', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new Error('request_timeout')).mockResolvedValue(response);
    const value = vi.fn(), failed = vi.fn();
    const stop = startFundingHistoryRefresh(load, value, failed);
    await vi.advanceTimersByTimeAsync(0); expect(failed).toHaveBeenCalledTimes(1); expect(value).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); expect(value).toHaveBeenCalledWith(response); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); expect(load).toHaveBeenCalledTimes(3);
    stop();
  });
  it('bounds retry frequency and never overlaps a slow request', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const load = vi.fn(() => new Promise<FundingHistorySeriesResponse>((_, r) => { reject = r; }));
    const failed = vi.fn(); const stop = startFundingHistoryRefresh(load, vi.fn(), failed);
    await vi.advanceTimersByTimeAsync(60_000); expect(load).toHaveBeenCalledTimes(1);
    reject(new Error('slow')); await vi.advanceTimersByTimeAsync(4999); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
    stop();
  });
  it('aborts a replaced selection and discards its late response', async () => {
    vi.useFakeTimers();
    let release!: (value: FundingHistorySeriesResponse) => void;
    let signal!: AbortSignal;
    const value = vi.fn(), failed = vi.fn();
    const stop = startFundingHistoryRefresh((s) => { signal = s; return new Promise((r) => { release = r; }); }, value, failed);
    stop(); expect(signal.aborted).toBe(true);
    release(response); await vi.advanceTimersByTimeAsync(120_000);
    expect(value).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
