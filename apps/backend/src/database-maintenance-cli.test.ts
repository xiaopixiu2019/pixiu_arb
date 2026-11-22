import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runOfflineDatabaseMaintenance } from './database-maintenance-cli.js';
import { acquireBackendProcessLock } from './process-lock.js';

it('runs retention offline and refuses to compete with a running backend', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixiu-offline-maintenance-'));
  const environment = { ...process.env, GCT_DATA_DIR: dataDir,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations') };
  try {
    expect(runOfflineDatabaseMaintenance(environment)).toEqual({
      auditEventsDeleted: 0, strategyLogsDeleted: 0, fillsDeleted: 0, ordersDeleted: 0,
    });
    const backend = acquireBackendProcessLock(dataDir, { pid: 987_654_321, isProcessAlive: () => false });
    try {
      const originalLock = readFileSync(backend.path);
      expect(() => runOfflineDatabaseMaintenance(environment)).toThrow(/backend_lock_exists/);
      expect(() => acquireBackendProcessLock(dataDir, { rejectExisting: true })).toThrow(/backend_lock_exists/);
      expect(readFileSync(backend.path)).toEqual(originalLock);
    } finally { backend.release(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
