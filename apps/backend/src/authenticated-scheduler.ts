export interface AuthenticatedPacing { nextAt: number; cooldownUntil: number }
interface Entry {
  write: boolean; priority: number; sequence: number; signal?: AbortSignal; readLane: symbol;
  work(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void;
  abort(): void;
}

/** Only this error proves that no transport was started. Never use a timeout as that proof. */
export class RequestNotDispatchedError extends Error {
  constructor(readonly reason: string = 'request_not_dispatched') { super(reason); }
}

/** One shared start gate, two bounded read slots, and one serial write slot. */
export class AuthenticatedScheduler {
  private readonly queue: Entry[] = [];
  private reads = 0;
  private readonly readLanes = new Set<symbol>();
  private readonly defaultLane = Symbol('default-reader');
  private writing = false;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly pacing: AuthenticatedPacing, private readonly spacingMs: number) {}

  schedule<T>(work: () => Promise<T>, write: boolean, priority: number, signal?: AbortSignal, readLane = this.defaultLane): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(new RequestNotDispatchedError()); return; }
      const entry: Entry = { write, priority, sequence: this.sequence++, signal, readLane, work,
        resolve: value => resolve(value as T), reject,
        abort: () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1); reject(new RequestNotDispatchedError()); this.pump();
        } };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const index = this.queue.findIndex(entry => entry.write ? !this.writing : this.reads < 2 && !this.readLanes.has(entry.readLane));
    if (index < 0) return;
    const wait = Math.max(0, this.pacing.nextAt - Date.now(), this.pacing.cooldownUntil - Date.now());
    if (wait > 0) { this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, wait); return; }
    const [entry] = this.queue.splice(index, 1);
    entry.signal?.removeEventListener('abort', entry.abort);
    this.pacing.nextAt = Date.now() + this.spacingMs;
    if (entry.write) this.writing = true;
    else { this.reads++; this.readLanes.add(entry.readLane); }
    void this.run(entry);
    this.pump();
  }

  private async run(entry: Entry): Promise<void> {
    try { entry.resolve(await entry.work()); }
    catch (error) { entry.reject(error); }
    finally {
      if (entry.write) {
        // Promise propagation must publish the caller's result/risk state before the next write guard.
        setTimeout(() => { this.writing = false; this.pump(); }, 0);
      } else {
        this.reads--; this.readLanes.delete(entry.readLane); this.pump();
      }
    }
  }
}

const shared = new WeakMap<AuthenticatedPacing, AuthenticatedScheduler>();
export function sharedAuthenticatedScheduler(pacing: AuthenticatedPacing, spacingMs: number): AuthenticatedScheduler {
  let scheduler = shared.get(pacing);
  if (!scheduler) { scheduler = new AuthenticatedScheduler(pacing, spacingMs); shared.set(pacing, scheduler); }
  return scheduler;
}
