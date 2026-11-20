(function(root,factory){
  const live=factory();
  if(typeof module==='object'&&module.exports)module.exports=live;
  else root.WuyingLiveCore=live;
})(globalThis,function(){
  'use strict';

  function createQueue({execute,accepts=()=>true,timeoutFor=()=>0,onResult=()=>{},onError=()=>{},onState=()=>{}}){
    let running=null, preview=null, final=null, controller=null;
    const waiters=[];
    const state=()=>({running,preview,final});
    const same=(a,b)=>a&&a.route===b.route&&a.key===b.key&&a.quality===b.quality;
    function changed(){
      onState(state());
      if(!running&&!preview&&!final)for(const resolve of waiters.splice(0))resolve();
    }

    async function pump(){
      if(running)return;
      while(final||preview){
        const job=final||preview;
        if(final)final=null;
        else preview=null;
        if(!accepts(job))continue;
        running=job;
        controller=new AbortController();
        const activeController=controller;
        const {signal}=activeController;
        const deadline=timeoutFor(job);
        const timeout=deadline>0?setTimeout(()=>{
          activeController.abort(new DOMException('渲染超时','TimeoutError'));
        },deadline):null;
        let interrupt;
        const canceled=new Promise((_,reject)=>{
          interrupt=()=>reject(signal.reason);
          signal.addEventListener('abort',interrupt,{once:true});
        });
        changed();
        try{
          const task=signal.aborted?canceled:execute(job,signal);
          const result=await Promise.race([task,canceled]);
          if(!signal.aborted&&accepts(job))onResult(job,result);
        }catch(error){
          if(accepts(job)&&(!signal.aborted||signal.reason?.name==='TimeoutError'))onError(job,error);
        }finally{
          if(timeout!==null)clearTimeout(timeout);
          signal.removeEventListener('abort',interrupt);
          running=null;
          controller=null;
        }
      }
      changed();
    }

    return {
      enqueue(job){
        if(same(running,job)&&!controller.signal.aborted){
          if(job.quality==='preview'&&preview){preview=null;changed();}
          return false;
        }
        if(same(preview,job)||same(final,job))return false;
        if(job.quality==='final')final=job;
        else preview=job;
        if(running)changed();
        else pump();
        return true;
      },
      clearPending(keep=()=>false){
        const removedPreview=preview&&!keep(preview),removedFinal=final&&!keep(final);
        if(removedPreview)preview=null;
        if(removedFinal)final=null;
        if(removedPreview||removedFinal)changed();
      },
      cancelRunning(keep=()=>false){
        if(running&&!keep(running))controller.abort();
      },
      state,
      whenIdle(){
        return running||preview||final?new Promise(resolve=>waiters.push(resolve)):Promise.resolve();
      }
    };
  }

  function hash(text){
    let value=2166136261;
    for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);
    return value>>>0;
  }

  return {createQueue,hash};
});
