import type { MarginSnapshot } from '@gate-crossex/shared-types';

/** Bounds server time with an HTTP round trip; never trusts the PC's wall clock. */
export class RiskEvidenceClock {
  private anchor: { account: string; lower: number; upper: number; at: number } | null = null;
  private candidate: { account: string; lower: number; upper: number; at: number } | null = null;
  private deadlines = new Map<string, number>();
  private recheck = false;
  constructor(private readonly monotonic = () => performance.now()) {}
  reset(): void { this.anchor = null; this.candidate = null; this.recheck = false; } // Reconnection cannot renew a previously seen sample.
  needsCalibration(account: string | null | undefined): boolean {
    // Renew while the old bound is usable: allow the 5s poll plus a 15s HTTP deadline.
    return this.recheck || this.now(account) === null || this.anchor!.upper - this.anchor!.lower > 500
      || this.monotonic() - this.anchor!.at >= 40000;
  }
  now(account: string | null | undefined): number | null {
    const a = this.anchor, now = this.monotonic();
    return a && a.account === account && now >= a.at && now - a.at <= 60000 ? now + a.upper : null;
  }
  remaining(account: string | null | undefined, sampledAt: number | null | undefined): number | null {
    if (this.now(account) === null || sampledAt == null || !Number.isFinite(sampledAt)) return null;
    const key = `${account}:${sampledAt}`, candidate = sampledAt + 5000 - this.anchor!.upper;
    const deadline = Math.min(this.deadlines.get(key) ?? Infinity, candidate);
    this.deadlines.set(key, deadline);
    if (this.deadlines.size > 128) this.deadlines.delete(this.deadlines.keys().next().value!);
    return deadline - this.monotonic();
  }
  observe(snapshot: MarginSnapshot): boolean | undefined {
    const now = this.now(snapshot.accountId);
    if (now === null || snapshot.sampledAt === null || snapshot.ageMs === null) return undefined;
    if (snapshot.ageMs < 0 || snapshot.sampledAt + snapshot.ageMs > now) { this.recheck = true; return false; }
    return true;
  }
  calibrate(account: string, serverAt: number, sent: number, received: number): boolean {
    if (!account || ![serverAt, sent, received].every(Number.isFinite) || received < sent || received - sent > 15000) return false;
    const next = { account, lower: serverAt - received, upper: serverAt - sent, at: received };
    if (next.upper - next.lower >= 5000) return false;
    const old = this.now(account) === null ? null : this.anchor;
    if (!old) { this.anchor = next; this.candidate = null; this.recheck = next.upper - next.lower > 500; return true; }
    const lower = Math.max(next.lower, old.lower), upper = Math.min(next.upper, old.upper);
    if (lower <= upper) {
      this.anchor = { account, lower, upper, at: received }; this.candidate = null;
      this.recheck = upper - lower > 500; return true;
    }
    const pending = this.candidate;
    const replacementLower = Math.max(next.lower, pending?.account === account ? pending.lower : -Infinity);
    const replacementUpper = Math.min(next.upper, pending?.account === account ? pending.upper : Infinity);
    if (pending?.account === account && replacementLower <= replacementUpper) {
      this.anchor = { account, lower: replacementLower, upper: replacementUpper, at: received };
      this.candidate = null; this.recheck = replacementUpper - replacementLower > 500; return true;
    }
    // One noisy probe cannot erase a still-valid clock. A second matching probe confirms a real shift.
    this.candidate = next; this.recheck = true; return false;
  }
}

export const riskEvidenceClock = new RiskEvidenceClock();
const httpTiming = new WeakMap<MarginSnapshot, { sent: number; received: number }>();
export function recordRiskHttpTiming(snapshot: MarginSnapshot, sent: number, received: number): void {
  httpTiming.set(snapshot, { sent, received });
}
export function acceptRiskHttpTiming(snapshot: MarginSnapshot): boolean | undefined {
  const timing = httpTiming.get(snapshot);
  httpTiming.delete(snapshot); // A rejected calibration needs a new request, not a second consumer.
  if (timing && snapshot.accountId && snapshot.sampledAt !== null && snapshot.ageMs !== null && snapshot.ageMs >= 0)
    return riskEvidenceClock.calibrate(snapshot.accountId, snapshot.sampledAt + snapshot.ageMs, timing.sent, timing.received);
}
