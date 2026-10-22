import WebSocket from 'ws';
import type { LiveMarket } from './market-hub.js';
import { recoveryBookChannel } from './executable-quote.js';

export function activeQuoteDemand(demand: Map<string, number>, watchers: Map<string, number>): string[] {
  for (const [symbol, used] of demand) {
    if (Date.now() - used > 60_000 && !watchers.has(symbol)) demand.delete(symbol);
  }
  return [...new Set([...watchers.keys(), ...demand.keys()])];
}

export function quoteUnavailableReason(market: LiveMarket | undefined, now = Date.now()): string | null {
  if (!market || !['gate_crossex_websocket', 'native_venue'].includes(market.source)) return 'awaiting_ticker';
  if (market.source === 'native_venue' && (!market.nativeSymbol || !Number.isFinite(market.nativeValidUntil) || market.nativeValidUntil! <= now)) return 'native_identity_expired';
  const age = now - Date.parse(market.updatedAt);
  const lag = Date.parse(market.receivedAt) - Date.parse(market.updatedAt);
  if (!Number.isFinite(age) || !Number.isFinite(lag)) return 'awaiting_connection_quote';
  if (age > 15_000) return 'source_expired';
  if (age < -2_000) return 'source_in_future';
  if (lag > 3_000) return 'delivery_delayed';
  if (!Number.isFinite(Number(market.bidPrice)) || !Number.isFinite(Number(market.askPrice))
    || Number(market.bidPrice) <= 0 || Number(market.askPrice) < Number(market.bidPrice)) return 'invalid_prices';
  return null;
}

export interface QuoteRecoveryOptions {
  tickMs?: number;
  probeTimeoutMs?: number;
  retryIntervalMs?: number;
  budgetWindowMs?: number;
  maxAttempts?: number;
  pingIntervalMs?: number;
}
interface Callbacks {
  demand(): string[];
  missing(symbol: string): boolean;
  owns(socket: WebSocket, symbol: string): boolean;
  accept(raw: string, at: number, socket: WebSocket): void;
  invalidate(socket: WebSocket): void;
}
interface Candidate {
  socket: WebSocket;
  createdAt: number;
  lastPingAt: number;
  awaitingPong: boolean;
  symbols: Set<string>;
  requestedAt: Map<string, number>;
}

/** At most two public quote sockets, eight connection/subscription probes per minute by default.
 * ACKs never authorize a quote; the hub validates every frame and owns its receipt evidence.
 * A socket serving a healthy leg is retained while a spare probes an unavailable leg.
 */
export class QuoteRecovery {
  private readonly candidates = new Set<Candidate>();
  private attempts: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private readonly options: Required<QuoteRecoveryOptions>;

  constructor(private readonly url: string, private readonly callbacks: Callbacks, options: QuoteRecoveryOptions = {}) {
    this.options = { tickMs: 500, probeTimeoutMs: 5_000, retryIntervalMs: 1_000,
      budgetWindowMs: 60_000, maxAttempts: 8, pingIntervalMs: 10_000, ...options };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.options.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const candidate of this.candidates) this.retire(candidate);
  }

  connected(): boolean {
    return [...this.candidates].some(c => c.socket.readyState === WebSocket.OPEN);
  }

  diagnostics(): { connections: number; attemptsInWindow: number; limit: number } {
    return { connections: this.candidates.size,
      attemptsInWindow: this.attempts.filter(t => Date.now() - t < this.options.budgetWindowMs).length,
      limit: this.options.maxAttempts };
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const demand = [...new Set(this.callbacks.demand())].slice(0, 100);
    this.attempts = this.attempts.filter(t => now - t < this.options.budgetWindowMs);
    for (const candidate of this.candidates) {
      this.maintain(candidate, demand, now);
      this.retryMissing(candidate, demand, now);
    }
    const missing = demand.filter(s => this.callbacks.missing(s));
    if (!missing.length || this.candidates.size >= 2 || !this.takeAttempt(now)) return;
    this.open(missing, now);
  }

  private maintain(candidate: Candidate, demand: string[], now: number): void {
    const ownsNeededQuote = demand.some(s => this.callbacks.owns(candidate.socket, s) && !this.callbacks.missing(s));
    if (!ownsNeededQuote && (now - candidate.createdAt >= this.options.probeTimeoutMs || !demand.some(s => this.callbacks.missing(s)))) {
      this.retire(candidate);
      return;
    }
    if (candidate.socket.readyState !== WebSocket.OPEN) return;
    if (now - candidate.lastPingAt >= this.options.pingIntervalMs) {
      if (candidate.awaitingPong) { this.retire(candidate); return; }
      candidate.awaitingPong = true;
      candidate.lastPingAt = now;
      candidate.socket.ping();
    }
    const removed = [...candidate.symbols].filter(s => !demand.includes(s));
    if (removed.length) {
      this.send(candidate, 'unsubscribe', removed);
      for (const symbol of removed) { candidate.symbols.delete(symbol); candidate.requestedAt.delete(symbol); }
    }
    const added = demand.filter(s => this.callbacks.missing(s) && !candidate.symbols.has(s));
    if (added.length) {
      for (const symbol of added) { candidate.symbols.add(symbol); candidate.requestedAt.set(symbol, now); }
      this.send(candidate, 'subscribe', added);
    }
  }

  takeSharedAttempt(now: number): boolean {
    this.attempts = this.attempts.filter(at => now - at < this.options.budgetWindowMs);
    return this.takeAttempt(now);
  }
  private takeAttempt(now: number): boolean {
    if (this.attempts.length >= this.options.maxAttempts
      || now - (this.attempts.at(-1) ?? 0) < this.options.retryIntervalMs) return false;
    this.attempts.push(now); return true;
  }

  private retryMissing(candidate: Candidate, demand: string[], now: number): void {
    if (!this.candidates.has(candidate) || candidate.socket.readyState !== WebSocket.OPEN) return;
    const missing = demand.filter(symbol => candidate.symbols.has(symbol) && this.callbacks.missing(symbol)
      && now - (candidate.requestedAt.get(symbol) ?? candidate.createdAt) >= this.options.probeTimeoutMs);
    if (!missing.length || !this.takeAttempt(now)) return;
    for (const symbol of missing) candidate.requestedAt.set(symbol, now);
    this.send(candidate, 'unsubscribe', missing);
    this.send(candidate, 'subscribe', missing);
  }

  private open(symbols: string[], now: number): void {
    const socket = new WebSocket(this.url);
    const candidate: Candidate = { socket, createdAt: now, lastPingAt: now, awaitingPong: false,
      symbols: new Set(symbols), requestedAt: new Map(symbols.map(symbol => [symbol, now])) };
    this.candidates.add(candidate);
    socket.on('open', () => {
      if (!this.candidates.has(candidate) || this.stopped) { socket.terminate(); return; }
      const at = Date.now();
      for (const symbol of candidate.symbols) candidate.requestedAt.set(symbol, at);
      this.send(candidate, 'subscribe', [...candidate.symbols]);
    });
    socket.on('pong', () => { candidate.awaitingPong = false; });
    socket.on('message', data => {
      if (!this.candidates.has(candidate) || this.stopped) return;
      const raw = data.toString();
      let frame: { channel?: string; event?: string; result?: { s?: string } };
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || frame.event !== 'update' || !frame.result?.s || !candidate.symbols.has(frame.result.s)
        || (frame.channel !== 'ticker' && frame.channel !== recoveryBookChannel(frame.result.s))) return;
      this.callbacks.accept(raw, Date.now(), socket);
    });
    socket.on('error', () => this.retire(candidate));
    socket.on('close', () => this.retire(candidate));
  }

  private send(candidate: Candidate, event: string, symbols: string[]): void {
    const channels = new Map<string, string[]>([['ticker', symbols]]);
    for (const symbol of symbols) {
      const channel = recoveryBookChannel(symbol);
      if (channel) channels.set(channel, [...(channels.get(channel) ?? []), symbol]);
    }
    for (const [channel, payload] of channels) {
      candidate.socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1_000), channel, event, payload }));
    }
  }

  private retire(candidate: Candidate): void {
    if (!this.candidates.delete(candidate)) return;
    this.callbacks.invalidate(candidate.socket);
    candidate.socket.terminate();
  }
}
