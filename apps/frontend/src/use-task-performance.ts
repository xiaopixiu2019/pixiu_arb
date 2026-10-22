import { useEffect, useState } from 'react';
import type { TaskPerformanceSummary } from '@gate-crossex/shared-types';
import { api } from './api.js';
export function useTaskPerformance(profileId: string|null|undefined) {
  const [state,setState]=useState<{profile:string;data:TaskPerformanceSummary}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();let busy=false, generation=0;
    if(!profileId)return ()=>controller.abort();
    const read=async()=>{
      if(busy)return;busy=true;const requestGeneration=generation;
      try {const data=await api.taskPerformance(controller.signal);
        if(!controller.signal.aborted && generation===requestGeneration)setState(data.profileId===profileId?{profile:profileId,data}:null);
      } catch {if(!controller.signal.aborted && generation===requestGeneration)setState(old=>old?.profile===profileId
        ?{...old,data:{...old.data,stale:true,reason:'task_data_unavailable'}}:null);} finally {busy=false;}
    };
    const reset=()=>{generation+=1;setState(null);};
    window.addEventListener('financial-context-changed',reset);
    void read();const timer=window.setInterval(()=>void read(),5000);
    return ()=>{controller.abort();window.clearInterval(timer);window.removeEventListener('financial-context-changed',reset);};
  },[profileId]);
  return state && state.profile===profileId?state.data:null;
}
