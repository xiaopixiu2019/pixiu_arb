import { describe, expect, it, vi } from 'vitest';
import { AuthenticatedScheduler } from './authenticated-scheduler.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describe('shared authenticated read/write scheduler', () => {
  it('dispatches a write while a read is blocked and never overlaps writes', async () => {
    const scheduler = new AuthenticatedScheduler({ nextAt: 0, cooldownUntil: 0 }, 0);
    const read = deferred(), write = deferred(), calls: string[] = [];
    const a = scheduler.schedule(async () => { calls.push('read'); await read.promise; }, false, 1);
    const b = scheduler.schedule(async () => { calls.push('write-1'); await write.promise; }, true, 0);
    const c = scheduler.schedule(async () => { calls.push('write-2'); }, true, 0);
    await vi.waitFor(() => expect(calls).toEqual(['read', 'write-1']));
    write.resolve(); await b; await c; expect(calls).toEqual(['read', 'write-1', 'write-2']);
    read.resolve(); await a;
  });
  it('shares pacing and a newly observed cooldown between both lanes', async () => {
    vi.useFakeTimers();
    try {
      const pacing = { nextAt: 0, cooldownUntil: 0 }, scheduler = new AuthenticatedScheduler(pacing, 100);
      const starts: number[] = [], now = Date.now();
      const a = scheduler.schedule(async () => { starts.push(Date.now()); pacing.cooldownUntil = Date.now() + 1000; }, false, 1);
      await vi.advanceTimersByTimeAsync(0); await a;
      const b = scheduler.schedule(async () => { starts.push(Date.now()); }, true, 0);
      await vi.advanceTimersByTimeAsync(999); expect(starts).toEqual([now]);
      await vi.advanceTimersByTimeAsync(1); await b; expect(starts).toEqual([now, now + 1000]);
    } finally { vi.useRealTimers(); }
  });
  it('cancels only queued work and bounds the read lane', async () => {
    const scheduler = new AuthenticatedScheduler({ nextAt: 0, cooldownUntil: 0 }, 0);
    const held = deferred(), abort = new AbortController(); let active = 0, maximum = 0;
    const read = async () => { active++; maximum = Math.max(maximum, active); await held.promise; active--; };
    const a = scheduler.schedule(read, false, 1, undefined, Symbol('a'));
    const b = scheduler.schedule(read, false, 1, undefined, Symbol('b'));
    const work = vi.fn(); const c = scheduler.schedule(work, false, 1, abort.signal);
    const rejected = expect(c).rejects.toThrow('request_not_dispatched'); abort.abort(); await rejected;
    held.resolve(); await Promise.all([a, b]); expect(work).not.toHaveBeenCalled(); expect(maximum).toBe(2);
  });
});
