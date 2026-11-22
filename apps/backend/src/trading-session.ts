export type TradingMode = 'unset' | 'readonly' | 'live' | 'protect_only';

export interface TradingModeEvent {
  type: 'mode.update';
  payload: { mode: TradingMode };
}

type TradingModeListener = (event: TradingModeEvent) => void;

/**
 * Ordinary trading always starts unset. A separately enrolled protection controller can enter
 * protect_only after reconciling the persisted account and responsibility; it cannot arm live.
 * Explicit readonly revokes that protection authority as well as locking ordinary trading.
 */
export class TradingSession {
  private mode: TradingMode = 'unset';
  private readonly listeners = new Set<TradingModeListener>();
  private protectionAvailable = () => false;
  private revokeProtection = () => {};
  private maintenanceActive = () => false;
  private admittedMaintenanceWork = () => false;
  private controlEpoch = 0;
  get controlRevision(): number { return this.controlEpoch; }

  attachMaintenance(active: () => boolean, admitted: () => boolean): void {
    this.maintenanceActive = active; this.admittedMaintenanceWork = admitted;
  }
  get maintenancePending(): boolean { return this.maintenanceActive(); }

  attachProtection(available: () => boolean, revoke: () => void): void {
    this.protectionAvailable = available; this.revokeProtection = revoke;
  }
  pause(): TradingMode {
    return this.mode !== 'readonly' && this.protectionAvailable() ? this.protect() : this.set('readonly');
  }
  protect(): TradingMode {
    if (this.maintenanceActive() && !this.admittedMaintenanceWork()) return this.mode;
    if (this.mode === 'readonly' || !this.protectionAvailable()) return this.mode;
    return this.publish('protect_only');
  }
  /** Called only after an explicit continuous-protection enrollment. */
  armProtection(): TradingMode {
    if (this.maintenanceActive() && !this.admittedMaintenanceWork()) return this.mode;
    return this.protectionAvailable() ? this.publish('protect_only') : this.mode;
  }

  get current(): TradingMode {
    return this.mode;
  }

  get liveTradingEnabled(): boolean {
    return this.mode === 'live' && (!this.maintenanceActive() || this.admittedMaintenanceWork());
  }

  set(mode: 'readonly' | 'live'): TradingMode {
    this.controlEpoch += 1;
    const applied = this.publish(mode);
    if (mode === 'readonly') this.revokeProtection();
    return applied;
  }

  private publish(mode: TradingMode): TradingMode {
    if (this.mode !== mode) {
      this.mode = mode;
      const event: TradingModeEvent = { type: 'mode.update', payload: { mode } };
      for (const listener of [...this.listeners]) listener(event);
    }
    return this.mode;
  }

  subscribe(listener: TradingModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
