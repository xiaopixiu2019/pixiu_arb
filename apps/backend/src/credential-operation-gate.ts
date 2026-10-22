export class CredentialOperationBusyError extends Error {
  constructor() {
    super('credential_operation_in_progress');
    this.name = 'CredentialOperationBusyError';
  }
}

/**
 * Keeps authenticated account writes and credential mutation in separate phases.
 *
 * A credential mutation closes the write side synchronously, waits for writes that already
 * started, then holds exclusive access until the active credential pointer and caches are stable.
 * Writes arriving after the close are rejected instead of queued so strategy actors cannot become
 * part of a credential-switch quiesce cycle while that cycle is already waiting for them.
 */
export class CredentialOperationGate {
  private credentialMutationActive = false;
  private authenticatedWrites = 0;
  private readonly idleWaiters = new Set<() => void>();

  async runAuthenticatedWrite<T>(work: () => Promise<T>): Promise<T> {
    if (this.credentialMutationActive) throw new CredentialOperationBusyError();
    this.authenticatedWrites += 1;
    try {
      return await work();
    } finally {
      this.authenticatedWrites -= 1;
      if (this.authenticatedWrites === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  async acquireCredentialMutation(): Promise<() => void> {
    if (this.credentialMutationActive) throw new CredentialOperationBusyError();
    this.credentialMutationActive = true;
    if (this.authenticatedWrites > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.credentialMutationActive = false;
    };
  }
}
