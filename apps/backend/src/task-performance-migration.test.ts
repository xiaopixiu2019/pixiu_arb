import { it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase, readDatabaseStatus } from './database.js';
import { TaskPerformanceProjection } from './task-performance-projection.js';
import { TaskPerformanceStore } from './task-performance-store.js';
import { TransactionFeeStore } from './transaction-fee-store.js';

it('upgrades retained evidence additively, preserves protection authority and rebuilds coverage exactly once',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'pnl-migration-')),older=join(directory,'migrations'),path=join(directory,'old.sqlite');
  const migrations=fileURLToPath(new URL('../../../migrations/',import.meta.url));mkdirSync(older);
  for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n<'0034'))copyFileSync(join(migrations,name),join(older,name));
  let db:Database.Database|null=openDatabase(path,older);
  try {
    db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,credential_profile_id)
      VALUES('task','position','live','PAUSED','{}','1970-01-01T00:01:40.000Z','1970-01-01T00:01:40.000Z','p')`).run();
    db.prepare('INSERT INTO managed_positions VALUES(?,?,?,?)').run('task','p',JSON.stringify({groupId:'task',phase:'RISK_PAUSED',adoptedLeft:'1',adoptedRight:'1',leftQuantity:'1',rightQuantity:'1'}),'old');
    db.prepare('INSERT INTO managed_risk_lock VALUES(?,?,?)').run(1,'managed_account_recovery_expired','old');
    db.prepare('INSERT INTO continuous_protection_authority VALUES(?,?,?,?,?,?)').run('p','risk-account',3,1,'["task"]','old');
    const fees=new TransactionFeeStore(db);fees.begin('key','p',100000);fees.rates('key',200000,{USD:'1.2',USDT:'1'});
    const store=new TaskPerformanceStore(db);store.save('key',[],100000,110000);store.save('key',[],120000,310000);
    const names=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all() as {name:string}[]).map(r=>r.name);
    const rows=()=>Object.fromEntries(names.map(name=>[name,db!.prepare(`SELECT * FROM "${name}"`).all()]));
    const before=rows();db.close();db=openDatabase(path,migrations);expect(readDatabaseStatus(db).migrationCount).toBe(34);expect(rows()).toEqual(before);
    expect(new TaskPerformanceStore(db).knownThrough('key',100000)).toBe(100000);
    const projection=new TaskPerformanceProjection(db,'key','p');await projection.update(310000);
    expect(new TaskPerformanceStore(db).knownThrough('key',100000)).toBe(110000);
    expect(db.prepare('SELECT from_at,to_at FROM task_pnl_coverage_merged WHERE account_key=? ORDER BY from_at').all('key'))
      .toEqual([{from_at:100000,to_at:110000},{from_at:120000,to_at:310000}]);
    const count=projection.statistics.historyGroups;await projection.update(310000);expect(projection.statistics.historyGroups).toBe(count);expect(rows()).toEqual(before);
    db.close();db=openDatabase(path,older);expect(rows()).toEqual(before); // Older schema reader remains compatible with additive tables.
  } finally {db?.close();rmSync(directory,{recursive:true,force:true});}
});
