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
  it('starts one control read without reducing or waiting for the two ordinary slots', async () => {
    const scheduler = new AuthenticatedScheduler({ nextAt: 0, cooldownUntil: 0 }, 0);
    const ordinary = deferred(), control = deferred(), calls: string[] = [];
    const a = scheduler.schedule(async () => { calls.push('ordinary-a'); await ordinary.promise; }, false, 3, undefined, Symbol('a'));
    const b = scheduler.schedule(async () => { calls.push('ordinary-b'); await ordinary.promise; }, false, 3, undefined, Symbol('b'));
    const c = scheduler.schedule(async () => { calls.push('control'); await control.promise; }, false, 0, undefined, Symbol('control'), true);
    const queued = scheduler.schedule(async () => { calls.push('ordinary-c'); }, false, 3, undefined, Symbol('c'));
    await vi.waitFor(() => expect(calls).toEqual(['ordinary-a', 'ordinary-b', 'control']));
    control.resolve(); await c; expect(calls).not.toContain('ordinary-c');
    ordinary.resolve(); await Promise.all([a, b, queued]); expect(calls).toContain('ordinary-c');
  });
  it('applies the same pacing and cooldown to control reads', async () => {
    vi.useFakeTimers();
    try {
      const pacing = { nextAt: 0, cooldownUntil: 0 }, scheduler = new AuthenticatedScheduler(pacing, 100);
      const starts: number[] = [], now = Date.now();
      const ordinary = scheduler.schedule(async () => { starts.push(Date.now()); pacing.cooldownUntil = Date.now() + 1000; }, false, 3);
      await vi.advanceTimersByTimeAsync(0); await ordinary;
      const control = scheduler.schedule(async () => { starts.push(Date.now()); }, false, 0, undefined, Symbol('control'), true);
      await vi.advanceTimersByTimeAsync(999); expect(starts).toEqual([now]);
      await vi.advanceTimersByTimeAsync(1); await control; expect(starts).toEqual([now, now + 1000]);
    } finally { vi.useRealTimers(); }
  });
  it('dispatches a queued control read before later urgent writes at the next shared start slot', async () => {
    vi.useFakeTimers();
    try {
      const scheduler=new AuthenticatedScheduler({nextAt:0,cooldownUntil:0},100),calls:string[]=[];
      const first=scheduler.schedule(async()=>{calls.push('write-0');},true,0);
      await vi.advanceTimersByTimeAsync(0);await first;
      const control=scheduler.schedule(async()=>{calls.push('control');},false,1,undefined,Symbol('control'),true);
      const writes=Array.from({length:10},(_,index)=>scheduler.schedule(async()=>{calls.push(`write-${index+1}`);},true,0));
      await vi.advanceTimersByTimeAsync(100);await control;
      expect(calls.slice(0,2)).toEqual(['write-0','control']);
      await vi.runAllTimersAsync();await Promise.all(writes);
    } finally { vi.useRealTimers(); }
  });
  it('never postpones the pacing wake while ordinary requests keep arriving', async () => {
    vi.useFakeTimers();
    try {
      const scheduler=new AuthenticatedScheduler({nextAt:0,cooldownUntil:0},100),calls:string[]=[];
      const first=scheduler.schedule(async()=>{calls.push('first');},true,0);
      await vi.advanceTimersByTimeAsync(0);await first;
      const control=scheduler.schedule(async()=>{calls.push('control');},false,0,undefined,Symbol('control'),true);
      const ordinary:Promise<void>[]=[];
      for(let index=0;index<9;index+=1){
        await vi.advanceTimersByTimeAsync(10);
        ordinary.push(scheduler.schedule(async()=>{calls.push(`ordinary-${index}`);},false,3,undefined,Symbol(`ordinary-${index}`)));
      }
      expect(calls).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(10);await control;
      expect(calls.slice(0,2)).toEqual(['first','control']);
      await vi.runAllTimersAsync();await Promise.all(ordinary);
    } finally { vi.useRealTimers(); }
  });
});
