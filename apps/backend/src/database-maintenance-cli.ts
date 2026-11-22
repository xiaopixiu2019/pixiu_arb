import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase, prepareDatabaseForClose } from './database.js';
import { runDatabaseMaintenance, type DatabaseMaintenanceResult } from './database-maintenance.js';
import { acquireBackendProcessLock } from './process-lock.js';

/** Run retention only while this process exclusively owns the backend data directory. */
export function runOfflineDatabaseMaintenance(environment: NodeJS.ProcessEnv = process.env): DatabaseMaintenanceResult {
  const config = loadConfig(environment);
  const processLock = acquireBackendProcessLock(config.dataDir, { rejectExisting: true });
  let database: ReturnType<typeof openDatabase> | null = null;
  try {
    database = openDatabase(config.databasePath, config.migrationsDir);
    const result = runDatabaseMaintenance(database);
    prepareDatabaseForClose(database);
    return result;
  } finally {
    database?.close();
    processLock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(runOfflineDatabaseMaintenance())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'database_maintenance_failed'}\n`);
    process.exitCode = 1;
  }
}
