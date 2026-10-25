import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { TaskPerformanceProjection } from './task-performance-projection.js';

const request = z.object({ id:z.number().int(), path:z.string().min(1), key:z.string().min(1), profile:z.string().min(1), now:z.number() });
let db: Database.Database | null = null, path: string | null = null, projection: TaskPerformanceProjection | null = null, busy = false;
parentPort?.on('message', async (raw: unknown) => {
  const parsed=request.safeParse(raw);
  if(!parsed.success){
    const id=raw&&typeof raw==='object'&&'id' in raw?raw.id:null;
    if(Number.isSafeInteger(id))parentPort?.postMessage({id,error:'task_projection_invalid'});
    return;
  }
  const job=parsed.data;
  if(busy){parentPort?.postMessage({id:job.id,error:'task_projection_busy'});return;}
  busy=true;
  try {
    if(path!==job.path){db?.close();db=new Database(job.path,{fileMustExist:true});db.pragma('busy_timeout=1000');db.pragma('foreign_keys=ON');path=job.path;projection=null;}
    if(!projection||projection.key!==job.key||projection.profile!==job.profile)projection=new TaskPerformanceProjection(db!,job.key,job.profile);
    const changed=await projection.update(job.now);
    parentPort?.postMessage({id:job.id,changed,statistics:projection.statistics});
  } catch { parentPort?.postMessage({id:job.id,error:'task_projection_failed'}); }
  finally {busy=false;}
});
