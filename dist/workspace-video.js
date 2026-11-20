
(() => {
  'use strict';
  const configKey='wuying-comfy-video-v1', ltxModel='ltx-2b';
  const ltxCheckpoint='ltxv-2b-0.9.6-distilled-04-25.safetensors';
  const ltxEncoder='t5xxl_fp8_e4m3fn.safetensors';
  const modeLabels={image:'首帧图生视频',frames:'首尾帧视频',text:'文生视频'};
  const needsFirstFrame=mode=>mode==='image'||mode==='frames';
  const needsLastFrame=(mode,caps)=>mode==='frames'||(mode==='image'&&caps.last);
  const providers={comfy:'本机 ComfyUI 工作流',runninghub:'RunningHub · 可灵 V3 Turbo'};
  const tags={first:'{{FIRST_FRAME}}',last:'{{LAST_FRAME}}',prompt:'{{PROMPT}}',duration:'{{DURATION}}'};
  const urlOf=value=>{
    const url=new URL(value);
    if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||
      url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('填写本机 ComfyUI 地址，例如 http://127.0.0.1:8188。');
    return url.origin;
  };
  function canTake(workflow,key) { return JSON.stringify(workflow).includes('"'+tags[key]+'"'); }
  function saveComfy(endpoint, source) {
    if(!source.trim()){localStorage.removeItem(configKey);return;}
    if(source.length>256*1024)throw new Error('工作流过大。');
    let workflow;
    try{workflow=JSON.parse(source);}
    catch{throw new Error('请粘贴有效的 ComfyUI API 格式 JSON。');}
    if(!workflow||Array.isArray(workflow)||!Object.values(workflow).length||
       !Object.values(workflow).every(node=>node?.class_type&&node.inputs&&typeof node.inputs==='object')||
       !canTake(workflow,'prompt')||canTake(workflow,'last')&&!canTake(workflow,'first')){
      throw new Error('工作流需要有效节点和 {{PROMPT}}。尾帧模板还需要 {{FIRST_FRAME}}。');
    }
    localStorage.setItem(configKey,JSON.stringify({endpoint:urlOf(endpoint),workflow}));
  }
  function saveComfyPreset(endpoint) {
    localStorage.setItem(configKey,JSON.stringify({endpoint:urlOf(endpoint),preset:ltxModel}));
  }
  function comfyConfig() {
    try { return JSON.parse(localStorage.getItem(configKey)||'null'); } catch { return null; }
  }
  function capabilities(provider) {
    if(provider==='runninghub')return {modes:['image','text'],last:false,duration:true};
    const config=comfyConfig();
    if(!config)return {modes:[]};
    if(config.preset===ltxModel)return {modes:Object.keys(modeLabels),last:false,duration:false};
    return {modes:[canTake(config.workflow,'first')?'image':'text'],
      last:canTake(config.workflow,'last'),duration:canTake(config.workflow,'duration')};
  }
  function dataUrl(blob) {
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result);
      reader.onerror=()=>reject(new Error('无法读取视频参考图。'));
      reader.readAsDataURL(blob);
    });
  }

  async function localRequest(endpoint,path,{signal,data,media=false}={}) {
    const options={signal,cache:'no-store'};
    if(data instanceof FormData){options.method='POST';options.body=data;}
    else if(data){options.method='POST';options.headers={'Content-Type':'application/json'};options.body=JSON.stringify(data);}
    let response;
    try { response=await fetch(endpoint+path,options); }
    catch(error) { signal?.throwIfAborted();throw new Error('无法连接本机 ComfyUI 视频工作流。'); }
    if(!response.ok)throw new Error('ComfyUI 请求失败（HTTP '+response.status+'）。请检查工作流和节点。');
    return media?response.blob():response.json();
  }
  async function ltxPreset(origin) {
    const endpoint=urlOf(origin);

    const signal=AbortSignal.timeout(6000);
    const [weights, text]=await Promise.all([
      localRequest(endpoint,'/object_info/CheckpointLoaderSimple',{signal}),
      localRequest(endpoint,'/object_info/CLIPLoader',{signal})
    ]);
    const required=[
      [weights.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0],ltxCheckpoint],
      [text.CLIPLoader?.input?.required?.clip_name?.[0],ltxEncoder]
    ];
    const missing=required.filter(([files,name])=>!files?.includes(name)).map(([,name])=>name);
    if(missing.length)throw new Error('本机 ComfyUI 缺少 '+missing.join('、')+'。安装权重后重试。');

    return ltxWorkflow('image');
  }

  function ltxWorkflow(mode) {
    // The 2B distilled checkpoint uses eight linear-quadratic steps at CFG 1.
    const node=(class_type,inputs)=>({class_type,inputs}), fps=16;
    const width=384,height=288,length=49,batch_size=1;
    const graph={
      1:node('LoadImage',{image:tags.first}),
      2:node('CheckpointLoaderSimple',{ckpt_name:ltxCheckpoint}),
      3:node('CLIPLoader',{clip_name:ltxEncoder,type:'ltxv',device:'default'}),
      4:node('CLIPTextEncode',{text:tags.prompt,clip:['3',0]}),
      5:node('CLIPTextEncode',{text:'motion smear, geometry deformation, flickering, text, watermark',clip:['3',0]}),
      6:node('LTXVConditioning',{positive:['4',0],negative:['5',0],frame_rate:fps}),
      7:node('LTXVImgToVideo',{positive:['6',0],negative:['6',1],vae:['2',2],image:['1',0],
        width,height,length,batch_size,strength:.95}),
      8:node('KSampler',{model:['2',0],positive:['7',0],negative:['7',1],latent_image:['7',2],
        seed:972611,steps:8,cfg:1,sampler_name:'euler',scheduler:'linear_quadratic',denoise:1}),
      9:node('VAEDecodeTiled',{samples:['8',0],vae:['2',2],tile_size:256,overlap:64,temporal_size:24,temporal_overlap:8}),
      10:node('CreateVideo',{images:['9',0],fps}),
      11:node('SaveVideo',{video:['10',0],filename_prefix:'video/wuying-ltx',format:'mp4',codec:'h264'})
    };
    if(mode==='text'){
      delete graph[1];
      graph[7]=node('EmptyLTXVLatentVideo',{width,height,length,batch_size});
      Object.assign(graph[8].inputs,{positive:['6',0],negative:['6',1],latent_image:['7',0]});
    }
    if(mode==='frames'){
      graph[12]=node('LoadImage',{image:tags.last});
      graph[13]=node('LTXVAddGuide',{positive:['7',0],negative:['7',1],latent:['7',2],
        vae:['2',2],image:['12',0],frame_idx:length-1,strength:1});
      Object.assign(graph[8].inputs,{positive:['13',0],negative:['13',1],latent_image:['13',2]});
      graph[14]=node('LTXVCropGuides',{positive:['13',0],negative:['13',1],latent:['8',0]});
      graph[9].inputs.samples=['14',2];
    }
    return graph;
  }

  async function upload(endpoint,blob,signal) {
    const form=new FormData();
    form.append('image',blob,'wuying-video-'+crypto.randomUUID()+'.png');
    form.append('type','input');
    const result=await localRequest(endpoint,'/upload/image',{signal,data:form});
    if(!result.name)throw new Error('ComfyUI 未返回首帧或尾帧文件名。');
    return [result.subfolder,result.name].filter(Boolean).join('/');
  }
  async function submit(job, frames, config, signal) {
    if(job.provider==='runninghub'){
      const first=frames.first?await dataUrl(frames.first):undefined;
      return window.WuyingPlatformApi.request('runninghub/video/start',
        {mode:job.mode,prompt:job.prompt,duration:job.duration,aspect:job.aspect,first},{signal});
    }
    const {endpoint}=config;
    const workflow=config.preset===ltxModel?ltxWorkflow(job.mode):config.workflow;
    const values={
      [tags.first]:frames.first?await upload(endpoint,frames.first,signal):undefined,
      [tags.last]:frames.last?await upload(endpoint,frames.last,signal):undefined,
      [tags.prompt]:job.prompt,[tags.duration]:job.duration
    };
    const prompt=JSON.parse(JSON.stringify(workflow),(_key,value)=>{
      if(typeof value==='string'&&Object.hasOwn(values,value))return values[value];
      return value;
    });
    const result=await localRequest(endpoint,'/prompt',{signal,data:{prompt,client_id:crypto.randomUUID()}});
    if(!result.prompt_id)throw new Error('ComfyUI 未返回视频任务编号。');
    return {taskId:result.prompt_id};
  }
  async function check(job,signal) {
    const {provider,providerTaskId:taskId}=job;
    if(provider==='runninghub'){
      const result=await window.WuyingPlatformApi.request('runninghub/video/status',{taskId},{signal});
      if(result.status!=='SUCCESS')return null;
      return window.WuyingPlatformApi.request('runninghub/video/download',{taskId},{signal,image:true});
    }
    const endpoint=urlOf(job.endpoint);
    const history=(await localRequest(endpoint,'/history/'+encodeURIComponent(taskId),{signal}))[taskId];
    if(!history)return null;
    if(history.status?.status_str==='error')throw new Error('ComfyUI 视频工作流执行失败，请查看本机控制台。');
    const outputs=Object.values(history.outputs||{}).flatMap(node=>
      Object.values(node).filter(Array.isArray).flat());
    const file=outputs.find(item=>/\.(mp4|webm)$/i.test(item?.filename||''));
    if(!file)throw new Error('工作流已完成，但没有 MP4 或 WebM 输出。');
    const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:file.type||'output'});
    const blob=await localRequest(endpoint,'/view?'+query,{signal,media:true});
    return new Blob([blob],{type:/\.webm$/i.test(file.filename)?'video/webm':'video/mp4'});
  }
  function wait(signal) {
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const canceled=()=>{clearTimeout(timer);reject(signal.reason);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',canceled);resolve();},2600);
      signal.addEventListener('abort',canceled,{once:true});
    });
  }

  function readVideoMetadata(blob, signal) {
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const video=document.createElement('video'), url=URL.createObjectURL(blob);
      const timer=setTimeout(()=>done(new Error('读取视频信息超时。')),12000);
      const canceled=()=>done(signal.reason);
      function done(error,info){
        clearTimeout(timer);
        signal.removeEventListener('abort',canceled);
        video.onloadedmetadata=video.onerror=null;
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        if(error)reject(error);
        else resolve(info);
      }
      video.preload='metadata';
      video.onloadedmetadata=()=>{
        const {videoWidth:width,videoHeight:height,duration}=video;
        if(!width||!height){done(new Error('输出没有可播放的视频画面。'));return;}
        done(null,{width,height,duration:Number.isFinite(duration)&&duration>0?duration:undefined});
      };
      video.onerror=()=>done(new Error('浏览器无法播放此视频，请检查模型输出。MP4 可使用 H.264 编码。'));
      signal.addEventListener('abort',canceled,{once:true});
      video.src=url;
    });
  }

  function assertCanStart(doc) {
    if(Object.values(doc.jobs).some(item=>item.kind==='video'&&['submitting','running'].includes(item.status))){
      throw new Error('已有视频任务在查询中。可在视频窗口检查它的状态。');
    }
  }

  async function run(store,options,{signal,onStatus=()=>{},place}={}) {
    const initial=await store.read();
    let job=options.resumeId?initial.jobs[options.resumeId]:null;
    if(options.resumeId&&(!job?.providerTaskId||job.kind!=='video'))throw new Error('找不到可继续查询的视频任务。');
    if(job?.status==='done')return job;
    if(!job){
      assertCanStart(initial);
      const {provider,mode,sourceId,lastId,aspect,prompt,duration}=options;
      const config=provider==='comfy'?comfyConfig():null, caps=capabilities(provider);
      if(!caps.modes.includes(mode))throw new Error('请选择受模型支持的视频模式。');
      const image=needsFirstFrame(mode), tail=needsLastFrame(mode,caps);
      const source=image?initial.assets[sourceId]:null;
      const last=tail?initial.assets[lastId]:null;
      if(image&&(!source?.adopted||source.mediaType==='video'))throw new Error('请先在工作台标记采用一张图。');
      if(tail&&(!last||last.mediaType==='video'))throw new Error('请选择尾帧。');
      if(prompt.length<5||prompt.length>2000||!Number.isInteger(duration)||duration<3||duration>15){
        throw new Error('请输入镜头描述并选择 3–15 秒时长。');
      }
      const frames={}, blobs=[];
      const snapshot=async (frame,asset)=>{
        const id=crypto.randomUUID(), blob=await window.WuyingWorkspaceComposite.toPng(asset,store);
        frames[frame]=blob;
        blobs.push({id,blob});
        return id;
      };
      const firstFrame=image?await snapshot('first',source):undefined;
      const lastFrame=tail?await snapshot('last',last):undefined;
      signal.throwIfAborted();
      const id=crypto.randomUUID();
      job={id,kind:'video',provider,mode,duration,aspect,prompt,sourceId:source?.id??null,sourceName:source?.name??null,
        width:source?.width||1280,height:source?.height||720,lastId:lastFrame?last.id:null,lastName:last?.name,
        inputBlobId:firstFrame,firstFrame,lastFrame,outputId:null,outputs:[],status:'submitting',createdAt:Date.now(),
        ...(config?{endpoint:config.endpoint,workflowPreset:config.preset}:{})};
      await store.change(current=>{
        assertCanStart(current);
        current.jobs[id]=job;
      },blobs);
      onStatus('正在提交视频任务…',job);
      try{
        const result=await submit(job,frames,config,signal);
        job=(await store.change(current=>Object.assign(current.jobs[id],{providerTaskId:result.taskId,status:'running'}))).jobs[id];
      }catch(error){
        await store.change(current=>Object.assign(current.jobs[id],{status:'submit-failed',error:error.message})).catch(()=>{});
        throw error;
      }
    }

    try{
      const deadline=Date.now()+180000;
      while(Date.now()<deadline){
        signal.throwIfAborted();
        onStatus('正在查询视频任务…',job);
        const blob=await check(job,signal);
        if(blob){
          if(!blob.size||blob.size>96*1024*1024||!['video/mp4','video/webm'].includes(blob.type)){
            throw new Error('视频格式或大小不受支持（MP4 / WebM，最多 96 MiB）。');
          }
          const metadata=await readVideoMetadata(blob,signal);
          const latest=(await store.read()).jobs[job.id];
          if(latest.status==='done')return latest;
          const id=crypto.randomUUID(),blobId=crypto.randomUUID();
          const result=await store.change(current=>{
            const saved=current.jobs[job.id];
            if(saved.status==='done')throw new Error('此视频已经由另一页面保存，请刷新工作台。');
            const source=current.assets[job.sourceId];
            const pos=place(source);
            const name=(job.sourceName||'产品')+' · 展示视频';
            current.assets[id]={id,name,...pos,...metadata,createdAt:Date.now(),updatedAt:Date.now(),
              mediaType:'video',videoBlobId:blobId,jobId:job.id,layers:job.firstFrame?
              [{id:crypto.randomUUID(),kind:'image',name:'首帧',visible:true,opacity:1,blobId:job.firstFrame}]:[]};
            Object.assign(saved,{status:'done',outputId:id,actualDuration:metadata.duration,
              outputs:[{id,blobId,name,mediaType:'video',...metadata}],error:null});
          },[{id:blobId,blob}]);
          return result.jobs[job.id];
        }
        await wait(signal);
      }
      throw new Error('视频仍在生成。可稍后继续查询同一任务。');
    }catch(error){
      await store.change(current=>{
        const saved=current.jobs[job.id];
        if(saved.status!=='done')Object.assign(saved,{status:'waiting',error:signal.aborted?'已停止本地查询。':error.message});
      }).catch(()=>{});
      throw error;
    }
  }
    window.WuyingVideo={providers,modeLabels,needsFirstFrame,needsLastFrame,saveComfy,saveComfyPreset,comfyConfig,
    capabilities,ltxPreset,ltxWorkflow,run};
})();
