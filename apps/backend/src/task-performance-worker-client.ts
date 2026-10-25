import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface ProjectionWorkerResult { changed: boolean; statistics: {historyGroups:number;historyBatches:number;resumedBatches:number} }
/** The worker has no gateway or trading actor. Only derived display rows are published there. */
export class TaskPerformanceWorker {
  private worker: Worker | null = null;
  private nextId=0;
  private stopped=false;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private terminating:Promise<void>|null=null;
  private pending: {id:number;resolve(value:ProjectionWorkerResult):void;reject(error:Error):void} | null=null;
  constructor(private readonly databasePath: string,private readonly timeoutMs=30000) {}
  update(key:string,profile:string,now:number):Promise<ProjectionWorkerResult> {
    if(this.stopped||this.pending||this.terminating)return Promise.reject(new Error('task_projection_busy'));
    if(!this.worker)this.start();
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending={id,resolve,reject};this.worker!.ref();
      this.timer=setTimeout(()=>this.abort('task_projection_timeout'),this.timeoutMs);this.timer.unref?.();
      this.worker!.postMessage({id,key,profile,now,path:resolvePath(this.databasePath)});
    });
  }
  private start():void {
    const compiled=new URL('./task-performance-worker.js',import.meta.url), source=new URL('./task-performance-worker.ts',import.meta.url);
    // Tests/dev execute the current TS source; production always uses the compiled entry.
    const loader = existsSync(compiled) ? null : pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const worker = loader ? new Worker(`import(${JSON.stringify(loader)}).then(({tsImport})=>tsImport(${JSON.stringify(source.href)},${JSON.stringify(import.meta.url)}))`,
      {eval:true,execArgv:[]}) : new Worker(compiled,{execArgv:[]});
    this.worker=worker;
    worker.on('message',(message:{id:number;changed:boolean;statistics:ProjectionWorkerResult['statistics'];error?:string})=>{
      if(this.worker!==worker||this.pending?.id!==message.id)return;
      const pending=this.pending;this.pending=null;this.clearTimer();worker.unref();
      if(message.error)pending.reject(new Error('task_projection_failed'));else pending.resolve({changed:message.changed,statistics:message.statistics});
    });
    const failed=()=>{if(this.worker===worker)this.abort('task_projection_failed');};
    worker.on('error',failed);worker.on('exit',failed);worker.unref();
  }
  async stop():Promise<void> {
    this.stopped=true;this.abort('task_projection_stopped');await this.terminating;
  }
  private clearTimer():void{if(this.timer)clearTimeout(this.timer);this.timer=null;}
  private abort(reason:string):void{
    const worker=this.worker;this.worker=null;const pending=this.pending;this.pending=null;this.clearTimer();
    pending?.reject(new Error(reason));
    if(worker)this.terminating=worker.terminate().then(()=>undefined).finally(()=>{this.terminating=null;});
  }
}
function resolvePath(path:string):string{return resolve(path);}
