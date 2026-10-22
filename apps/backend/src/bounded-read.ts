/** Logical deadlines plus a physical-work bound, even for gateways which ignore cancellation. */
export class BoundedRead {
  private active = 0;
  constructor(private readonly limit = 2) {}
  async run<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.active >= this.limit) throw new Error('read_capacity_exhausted');
    const controller = new AbortController(); this.active += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.resolve().then(() => work(controller.signal)).finally(() => { this.active -= 1; });
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('read_deadline_exceeded')); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
