import { describe, expect, it, vi } from 'vitest';
import { CredentialOperationBusyError, CredentialOperationGate } from './credential-operation-gate.js';

describe('CredentialOperationGate', () => {
  it('waits for an accepted write and rejects new writes until credential mutation releases', async () => {
    const gate = new CredentialOperationGate();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const events: string[] = [];

    const write = gate.runAuthenticatedWrite(async () => {
      events.push('write-started');
      markWriteStarted();
      await writeBlocked;
      events.push('write-finished');
    });
    await writeStarted;

    let releaseMutation: (() => void) | undefined;
    const mutation = gate.acquireCredentialMutation().then((release) => {
      events.push('mutation-acquired');
      releaseMutation = release;
    });
    await vi.waitFor(() => expect(events).toEqual(['write-started']));
    await expect(gate.runAuthenticatedWrite(async () => undefined)).rejects.toBeInstanceOf(CredentialOperationBusyError);

    releaseWrite();
    await Promise.all([write, mutation]);
    expect(events).toEqual(['write-started', 'write-finished', 'mutation-acquired']);

    releaseMutation?.();
    await expect(gate.runAuthenticatedWrite(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('allows only one credential mutation at a time', async () => {
    const gate = new CredentialOperationGate();
    const release = await gate.acquireCredentialMutation();
    await expect(gate.acquireCredentialMutation()).rejects.toBeInstanceOf(CredentialOperationBusyError);
    release();
    await expect(gate.acquireCredentialMutation()).resolves.toEqual(expect.any(Function));
  });
});
