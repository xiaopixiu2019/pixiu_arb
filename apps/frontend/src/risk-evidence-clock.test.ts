import { describe, expect, it } from 'vitest';
import { RiskEvidenceClock } from './risk-evidence-clock.js';
import { MarginSnapshotSchema } from '@gate-crossex/shared-types';

describe('server risk evidence clock', () => {
  it('requests renewal before expiry while keeping the current clock usable', () => {
    let now = 100; const clock = new RiskEvidenceClock(() => now);
    clock.calibrate('a', 10000, 0, 100);
    now = 40099; expect(clock.needsCalibration('a')).toBe(false);
    now = 40100; expect(clock.needsCalibration('a')).toBe(true);
    expect(clock.now('a')).not.toBeNull();
    // Allow a full 5s polling interval and 15s HTTP deadline before expiry.
    now = 60099; expect(clock.now('a')).not.toBeNull();
    now = 60101; expect(clock.now('a')).toBeNull();
  });
  it('renews across multiple minutes without extending evidence or hiding failed renewal', () => {
    let now = 100; const clock = new RiskEvidenceClock(() => now);
    clock.calibrate('a', 10000, 0, 100);
    for (let cycle = 0; cycle < 4; cycle++) {
      now += 45000;
      const sample = now + 9900;
      expect(clock.needsCalibration('a')).toBe(true);
      expect(clock.now('a')).not.toBeNull();
      const remaining = clock.remaining('a', sample);
      expect(clock.calibrate('a', sample, now - 100, now)).toBe(true);
      expect(clock.needsCalibration('a')).toBe(false);
      expect(clock.remaining('a', sample)).toBe(remaining);
    }
    now += 45000;
    expect(clock.calibrate('a', NaN, now - 100, now)).toBe(false);
    expect(clock.now('a')).not.toBeNull();
    now += 15001; expect(clock.now('a')).toBeNull();
  });
  it('uses a conservative monotonic server clock, independent of wall-clock offset', () => {
    let now = 1100; const clock = new RiskEvidenceClock(() => now);
    expect(clock.calibrate('a', 10000, 1000, 1100)).toBe(true);
    expect(clock.now('a')).toBe(10100);
    now = 2600; expect(clock.now('a')).toBe(11600);
    // A sample at 9000 is still younger than 5s, even if the PC wall clock is 2.85s ahead.
    expect(clock.now('a')! - 9000).toBe(2600);
    now = 6101; expect(clock.now('a')! - 9000).toBeGreaterThan(5000);
  });
  it('does not erase transport time, tightens intersecting bounds and retains one noisy calibration', () => {
    let now = 1200; const clock = new RiskEvidenceClock(() => now);
    clock.calibrate('a', 10000, 1000, 1200);
    expect(clock.now('a')).toBe(10200);
    now = 1300; clock.calibrate('a', 10150, 1250, 1300);
    expect(clock.now('a')).toBe(10200);
    expect(clock.calibrate('a', 20000, 1250, 1300)).toBe(false);
    expect(clock.now('a')).toBe(10200); expect(clock.needsCalibration('a')).toBe(true);
    now = 1400; expect(clock.calibrate('a', 20100, 1350, 1400)).toBe(true);
    expect(clock.now('a')).toBe(20150);
  });
  it('never lets a slow snapshot response loosen an already tight clock',()=>{
    let now=1000;const clock=new RiskEvidenceClock(()=>now);
    expect(clock.calibrate('a',10000,900,1000)).toBe(true);
    expect(clock.remaining('a',9000)).toBe(3900);
    now=1100;expect(clock.calibrate('a',10100,0,1100)).toBe(true);
    expect(clock.now('a')).toBe(10200);expect(clock.remaining('a',9000)).toBe(3800);
  });
  it('rejects invalid samples and expires calibration on reset, account change and long suspension', () => {
    let now = 100; const clock = new RiskEvidenceClock(() => now);
    expect(clock.calibrate('a', NaN, 0, 100)).toBe(false);
    expect(clock.calibrate('a', 10000, 200, 100)).toBe(false);
    clock.calibrate('a', 10000, 0, 100);
    expect(clock.now('b')).toBeNull();
    now = 60101; expect(clock.now('a')).toBeNull();
    now = 200; clock.calibrate('a', 10200, 100, 200); clock.reset();
    expect(clock.now('a')).toBeNull();
  });
  it('never extends a known sample deadline when repeated HTTP evidence tightens the clock bound', () => {
    let now = 1200; const clock = new RiskEvidenceClock(() => now);
    clock.calibrate('a',10000,1000,1200);
    expect(clock.remaining('a',9000)).toBe(3800);
    now = 1300; clock.calibrate('a',10150,1250,1300);
    expect(clock.remaining('a',9000)).toBe(3700);
    now = 5001; expect(clock.remaining('a',9000)).toBe(-1);
  });
  it('does not renew the same observation after reconnect calibration',()=>{
    let now=1200;const clock=new RiskEvidenceClock(()=>now);
    clock.calibrate('a',10000,1000,1200);expect(clock.remaining('a',9000)).toBe(3800);
    clock.reset();now=1300;clock.calibrate('a',10150,1250,1300);
    expect(clock.remaining('a',9000)).toBe(3700);
  });
  it('keeps an initial clock uncertain when the round trip spans the entire freshness window',()=>{
    const clock=new RiskEvidenceClock(()=>6000);
    expect(clock.calibrate('a',10000,0,6000)).toBe(false);expect(clock.now('a')).toBeNull();
    expect(clock.calibrate('a',10000,5900,6000)).toBe(true);
  });
  it('retries a wide valid calibration until an intersecting low-latency probe tightens it',()=>{
    let now=1000;const clock=new RiskEvidenceClock(()=>now);
    expect(clock.calibrate('a',10000,0,1000)).toBe(true);expect(clock.needsCalibration('a')).toBe(true);
    now=1100;expect(clock.calibrate('a',10100,1000,1100)).toBe(true);expect(clock.needsCalibration('a')).toBe(false);
    expect(clock.now('a')).toBe(10200);
  });
  it('quarantines a future emission without letting it poison the clock for the next valid observation',()=>{
    const clock=new RiskEvidenceClock(()=>1000);clock.calibrate('a',10000,900,1000);
    const snapshot=MarginSnapshotSchema.parse({accountId:'a',accountLabel:'a',sampledAt:10000,ageMs:200,fresh:true,status:'clear',reason:null,entryBlocked:false,
      metrics:null,policy:{},effectivePolicy:{},liveEnabled:true,incidentId:null,groups:[],uncoveredSymbols:[]});
    expect(clock.observe(snapshot)).toBe(false);expect(clock.needsCalibration('a')).toBe(true);
    expect(clock.observe({...snapshot,ageMs:100})).toBe(true);
    expect(clock.now('a')).toBe(10100);
  });
});
