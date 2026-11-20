(() => {
  'use strict';

  const workbench=window.WuyingWorkbench, board=workbench?.board, graph=workbench?.graph;
  const comfy=window.WuyingComfy, core=window.WuyingLiveCore;
  if(!board||!graph||!comfy||!core)return;
  const $=id=>document.getElementById(id);
  const shell=document.querySelector('.app-shell');
  const endpoint=$('comfyEndpoint'), checkpoint=$('comfyCheckpoint'), controlnet=$('comfyControlnet');
  const engine=$('comfyEngine'), kreaHint=$('kreaHint');
  const isKrea=()=>engine.value==='krea';
  const isApi=()=>engine.value==='api';
  const apiOrigin='http://127.0.0.1:8882';
  const connect=$('testComfy'), models=$('comfyModels'), strength=$('controlStrength'), prompt=$('renderPrompt');
  const thumb=$('controlThumb'), rawPreview=$('controlPreview'), autoRefine=$('autoRefine'), renderStyle=$('renderStyle');
  const suffix=workbench.demo?'-demo':'';
  const endpointKey='wuying.comfyEndpoint'+suffix, prefsKey='wuying.liveModels'+suffix;
  const tabId=crypto.randomUUID();
  const frames=new Map(), attempts=new Map(), stopped=new Map(), refineAttempts=new Map(), inputsCache=new Map();
  const sampleInterval=450, refineDelay=1050, previewDeadline=45000, finalDeadline=120000;
  const toneHints={
    silver:'brushed silver and pale metallic surfaces',moss:'moss green surfaces',dune:'warm sand-colored surfaces',
    blue:'slate blue surfaces',clay:'terracotta surfaces',ink:'dark charcoal surfaces'
  };
  const defaultPrompt='Industrial product design, accurate form, refined materials, crisp studio rendering';
  const photoPrompt='sharp focus across the product, photorealistic product photography, material microtexture, softbox key light, defined contact shadow, plain gray seamless backdrop';
  let address='', providerRevision=0, timer=null, refineTimer=null, lastSample=0, lastInput=0, sourceVersion=0, previewUrl=null, progress=null;
  let prefs={}, kreaModels=null, apiConfig=null;
  endpoint.value='http://127.0.0.1:8188';
  try{
    endpoint.value=localStorage.getItem(endpointKey)||endpoint.value;
    prefs=JSON.parse(localStorage.getItem(prefsKey)||'{}')||{};
  }catch{}
  engine.value=['krea','api'].includes(prefs.engine)?prefs.engine:'sd';
  function syncEngineUI(){
    const api=isApi();
    endpoint.hidden=$('comfyEndpointLabel').hidden=$('comfyAutoHelp').hidden=$('comfyNetworkHelp').hidden=api;
    $('apiConnectionHelp').hidden=!api;
    $('deskStrength').closest('label').hidden=api||isKrea();
    if(autoRefine)autoRefine.closest('label').hidden=api;
    kreaHint.hidden=!isKrea();
    connect.textContent=api?'连接出图后台':'连接并读取模型';
  }
  syncEngineUI();
  if(autoRefine)autoRefine.checked=prefs.autoRefine!==false;
  renderStyle.value=prefs.style==='studio'?'studio':'default';
  $('comfyCorsOrigin').textContent=location.origin==='null'
    ?'本地文件可从工作台预览地址打开。':'--enable-cors-header '+location.origin;
  const connected=()=>isApi()?!!apiConfig?.ready:
    !!address&&(isKrea()?!!kreaModels:!!checkpoint.value)&&address===endpoint.value.trim();
  const changed=()=>window.dispatchEvent(new Event('wuyinglivechange'));
  const history=window.WuyingFlowResults.create('wuying-render-results-v1'+(workbench.projectSuffix||suffix),changed);
  const currentId=()=>graph.activePreview()?.id;
  const resultScope=(id,inputs=graph.inputsFor(id))=>JSON.stringify([id,inputs.visual?.documentId||inputs.visual?.id||'',inputs.text?.id||'']);
  const results=(id=currentId())=>id?history.list(resultScope(id)):[];

  function message(value,error=false){
    const status=$('comfyStatus');
    status.textContent=value;status.classList.toggle('ai-error',error);
  }

  function connectionState(label,ready=false){
    $('connectionLabel').textContent=label;
    $('connectionDot').classList.toggle('is-connected',ready);
    const shortcut=$('openAISettings');
    shortcut.dataset.connected=String(ready);
    shortcut.querySelector('span').textContent=ready?'AI 已连接':'连接 AI';
  }

  function routeFor(id,inputs=graph.inputsFor(id)){
    const view=inputs.visual?.type==='sketch'?board.viewFor(inputs.visual.documentId):'';
    return [providerRevision,id,inputs.visual?.id||'',inputs.text?.id||'',view].join('|');
  }

  function hasContent(inputs){
    if(inputs.text?.prompt.trim()||isApi()&&prompt.value.trim())return true;
    if(isApi()&&apiConfig?.edit===false)return false;
    if(inputs.visual?.type==='image')return !!inputs.visual.image?.src;
    if(inputs.visual?.type!=='sketch')return false;
    const scene=board.sceneFor(inputs.visual.documentId);
    return !!(scene.curve?.nodes.length||scene.ink.length||scene.underlay);
  }

  function accepts(job){
    const node=graph.previewNode(job.id);
    return graph.inBoard()&&connected()&&node?.mode==='ai'&&routeFor(job.id)===job.route;
  }

  function stamp(value){
    return core.hash(value).toString(36)+'-'+value.length;
  }

  function readInput(id){
    const node=graph.previewNode(id);
    if(!connected()||!node||!graph.inBoard()||node.mode!=='ai')return null;
    if(inputsCache.has(id))return inputsCache.get(id);
    const inputs=graph.inputsFor(id);
    const useVisual=!isApi()||apiConfig?.edit;
    const sketch=useVisual&&inputs.visual?.type==='sketch'?board.sceneFor(inputs.visual.documentId):null;
    const image=useVisual&&inputs.visual?.type==='image'?inputs.visual.image?.src:null;
    const hasSketch=!!(sketch?.curve?.nodes.length||sketch?.ink.length||sketch?.underlay);
    const description=inputs.text?.prompt.trim()||'';
    const style=prompt.value.trim();
    const kind=hasSketch?'sketch':image?'image':description||isApi()&&style?'text':null;
    if(!kind||(isKrea()&&(kind!=='text'||inputs.visual)))return null;
    const tone=workbench.currentTone?.();
    const toneHint=kind==='sketch'&&tone&&(tone.tone!=='silver'||tone.explicit)?toneHints[tone.tone]:'';
    const studioLight=renderStyle.value==='studio';
    const viewHint=hasSketch?window.WuyingStudioCore.sketchViews[sketch.view]?.prompt:'';
    const shapeHint=isApi()&&hasSketch?'Preserve the proportions, silhouette, and viewpoint of the supplied design sketch':'';
    const fullPrompt=[viewHint,shapeHint,description,style||defaultPrompt,toneHint,studioLight?photoPrompt:''].filter(Boolean).join(', ');
    const frame=hasSketch?sketch:null;
    const frameStamp=frame?stamp(JSON.stringify([frame.profile,frame.offset,frame.frame,frame.captureBounds,
      frame.curve?.nodes,frame.depth,frame.ink,frame.underlay?.src])):null;
    const key=stamp(JSON.stringify([kind,fullPrompt,strength.value,frameStamp,image]));
    const input={
      id,route:routeFor(id,inputs),scope:resultScope(id,inputs),key,kind,frame,image,
      settings:{prompt:style,style:renderStyle.value,strength:Number(strength.value)},
      draftId:sketch?.id??null,sourceStamp:sketch?window.WuyingBoard.sceneStamp(sketch):null,
      api:isApi()?apiConfig:null,krea:isKrea()?kreaModels:null,endpoint:address,checkpoint:checkpoint.value,
      controlnet:kind==='sketch'&&!isApi()?controlnet.value:'',strength:Number(strength.value),prompt:fullPrompt,studioLight,
      seed:core.hash(id),slot:tabId+'-'+core.hash(id).toString(36)
    };
    inputsCache.set(id,input);
    return input;
  }

  function snapshot(input,quality,automatic=false){
    return {...input,quality,automatic,frame:input.frame?structuredClone(input.frame):null};
  }

  function matches(a,b){
    return !!a&&!!b&&a.route===b.route&&a.key===b.key;
  }

  function remember(map,input){
    map.set(input.id,{route:input.route,key:input.key});
  }

  async function requestApi(path,body,signal){
    let response;
    try{
      response=await fetch(apiOrigin+'/api/'+path,{method:body?'POST':'GET',cache:'no-store',signal,
        ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    }catch(error){
      if(signal.aborted)throw signal.reason;
      throw new Error('无法访问本机出图后台。请先启动「启动出图后台.cmd」。');
    }
    if(!response.ok){
      const payload=await response.json().catch(()=>null);
      throw new Error(payload?.error||'出图后台请求失败。');
    }
    return response;
  }

  async function execute(job,signal){
    const onStatus=message=>{
      if(signal.aborted)return;
      progress={job,message};
      changed();
    };
    onStatus(job.kind==='text'?'正在准备出图…':'正在读取草图…');
    if(job.krea)return comfy.renderKrea({...job,input:job.kind,signal,onStatus});
    const sourceImage=job.kind==='text'?undefined:await board.captureFrame(job.frame,{
      color:!job.controlnet,fillInk:job.kind==='sketch',sourceImage:job.image
    });
    signal.throwIfAborted();
    if(job.api){
      const image=sourceImage?await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);
        reader.readAsDataURL(sourceImage);
      }):undefined;
      signal.throwIfAborted();
      if(!accepts(job))return null;
      onStatus('出图 API 正在生成…');
      const response=await requestApi('render',{prompt:job.prompt,image,revision:job.api.revision},signal);
      return {blob:await response.blob()};
    }
    const colorGuide=job.controlnet&&(job.frame?.underlay||
      job.frame?.ink.some(stroke=>!['graphite','gray'].includes(stroke.color)));
    const colorGuideImage=colorGuide?await board.captureFrame(job.frame,{color:true,fillInk:true}):undefined;
    signal.throwIfAborted();
    if(!accepts(job))return null;
    return comfy.renderLive({...job,input:job.kind,sourceImage,colorGuideImage,signal,onStatus,
      negative:'watermark, unwanted text, distorted proportions, blurry edges, clutter'+
        (job.studioLight?', flat illustration, overexposed highlights, defocus, ghosted edges, background props':'')});
  }

  function storeFrame(job,result){
    if(!result?.blob)return;
    const previous=frames.get(job.id);
    if(previous?.quality==='final'&&job.quality==='preview'&&!job.manualPreview&&matches(previous,job))return;
    if(previous?.src)URL.revokeObjectURL(previous.src);
    frames.set(job.id,{route:job.route,key:job.key,quality:job.quality,manualPreview:job.manualPreview,blob:result.blob,src:URL.createObjectURL(result.blob)});
    if(job.quality==='final')history.add({id:crypto.randomUUID(),scope:job.scope,blob:result.blob,settings:job.settings,draftId:job.draftId,sourceStamp:job.sourceStamp,created:Date.now()});
    if(currentId()===job.id){
      message(job.quality==='final'?'高清渲染已完成，可以下载。':'实时帧已更新。');
      scheduleRefine();
    }
    changed();
  }

  function storeError(job,error){
    const previous=frames.get(job.id);
    const value=error?.name==='TimeoutError'
      ?(job.quality==='final'?'高清细化超过 120 秒。':'实时预览超过 45 秒。')+'请检查 ComfyUI 队列，继续修改或手动重试。'
      :error?.message||'AI 渲染失败';
    const current=readInput(job.id);
    if(current?.route===job.route)remember(attempts,current);
    queue.clearPending(item=>item.route!==job.route);
    if(currentId()===job.id)clearTimers();
    frames.set(job.id,{...(previous?.route===job.route?previous:{}),route:job.route,error:value});
    if(previous?.route!==job.route&&previous?.src)URL.revokeObjectURL(previous.src);
    if(currentId()===job.id)message(value,true);
    changed();
  }

  const queue=core.createQueue({execute,accepts,timeoutFor:job=>job.quality==='final'?finalDeadline:previewDeadline,
    onResult:storeFrame,onError:storeError,onState:changed});

  function automaticAllowed(job){
    const active=graph.activePreview();
    return !isApi()&&active?.id===job.id&&active.auto!==false&&['derive','generate'].includes(shell.dataset.panel);
  }

  function requestSample(){
    const node=graph.activePreview();
    if(!graph.inBoard()||!connected()||node?.mode!=='ai'||!automaticAllowed(node)||timer!==null)return;
    timer=setTimeout(()=>{
      timer=null;
      const active=graph.activePreview();
      if(active?.mode!=='ai'||!automaticAllowed(active)){changed();return;}
      lastSample=performance.now();
      const input=readInput(active.id);
      if(!input){
        const id=currentId();
        attempts.delete(id);
        queue.clearPending(other=>other.id!==id||other.quality==='final');
      }else if(!matches(attempts.get(input.id),input)&&!matches(stopped.get(input.id),input)){
        remember(attempts,input);
        queue.enqueue(snapshot(input,'preview'));
      }
      scheduleRefine();
      changed();
    },Math.max(100,sampleInterval-(performance.now()-lastSample)));
    changed();
  }

  function refineCandidate(){
    if(!autoRefine?.checked)return null;
    const id=currentId(),input=readInput(id),frame=frames.get(id),state=queue.state();
    if(input?.kind!=='sketch'||input.frame.drawing||!automaticAllowed(input)||state.final||state.running?.quality==='final')return null;
    if(!matches(frame,input)||frame.quality!=='preview'||frame.error||matches(stopped.get(id),input)||matches(refineAttempts.get(id),input))return null;
    return input;
  }

  function scheduleRefine(){
    if(refineTimer!==null||!refineCandidate())return;
    refineTimer=setTimeout(()=>{
      refineTimer=null;
      const input=refineCandidate();
      if(input){
        remember(refineAttempts,input);
        queue.enqueue(snapshot(input,'final',true));
      }
      changed();
    },Math.max(160,refineDelay-(performance.now()-lastInput)));
  }

  function clearRefineTimer(){
    if(refineTimer!==null){clearTimeout(refineTimer);refineTimer=null;}
  }

  function clearTimers(){
    if(timer!==null){clearTimeout(timer);timer=null;}
    clearRefineTimer();
  }

  function keepCurrent(job){
    if(!accepts(job))return false;
    if(job.manualPreview||job.quality==='final'&&!job.automatic)return true;
    if(!automaticAllowed(job))return false;
    if(!job.automatic)return true;
    const input=readInput(job.id);
    return !!autoRefine?.checked&&matches(input,job)&&!input.frame?.drawing;
  }

  function discardPending(keep){
    const {preview}=queue.state();
    if(preview&&!keep(preview)&&matches(attempts.get(preview.id),preview))attempts.delete(preview.id);
    queue.clearPending(keep);
  }

  function inputChanged(){
    inputsCache.clear();
    lastInput=performance.now();
    if(!graph.inBoard()){invalidateRoute();return;}
    const {running,preview,final}=queue.state();
    if(preview&&(!automaticAllowed(preview)||!matches(readInput(currentId()),preview)))discardPending(job=>job!==preview);
    if(final?.automatic&&!keepCurrent(final))queue.clearPending(job=>job!==final);
    if(running?.automatic&&!keepCurrent(running))queue.cancelRunning(job=>job!==running);
    clearRefineTimer();
    requestSample();
    if(!running||frames.get(currentId())?.quality==='preview')scheduleRefine();
  }

  function invalidateRoute(){
    inputsCache.clear();
    clearTimers();
    discardPending(keepCurrent);
    queue.cancelRunning(keepCurrent);
    requestSample();
    scheduleRefine();
    changed();
  }

  function cancel(id=currentId()){
    const input=readInput(id);
    if(input){
      remember(stopped,input);
      remember(attempts,input);
    }
    if(currentId()===id)clearTimers();
    queue.clearPending(job=>job.id!==id);
    queue.cancelRunning(job=>job.id!==id);
    if(currentId()===id)message(isApi()?'已停止等待。服务商可能仍在处理本次请求。':'已停止当前出图。修改草图或点高清可再次生成。');
    changed();
  }

  function view(id){
    const node=graph.previewNode(id);
    if(!node)return null;
    const inputs=graph.inputsFor(id),route=routeFor(id,inputs);
    const available=hasContent(inputs);
    const record=frames.get(id),result=connected()&&available&&record?.route===route&&record.src?record:null;
    const {running,preview,final}=queue.state();
    const activeJob=running?.route===route?running:null;
    const waitingFinal=final?.route===route,waiting=preview?.route===route||waitingFinal;
    const input=readInput(id);
    const resultMatches=matches(result,input);
    const settling=!!input&&id===currentId()&&refineTimer!==null;
    const scheduled=!!input&&id===currentId()&&timer!==null&&!matches(attempts.get(id),input);
    const status={result,resultMatches,busy:!!(activeJob||waiting||settling||scheduled),
      finalBusy:!!(waitingFinal||activeJob?.quality==='final'),connected:connected(),drawing:!!input?.frame?.drawing};
    if(status.connected&&isKrea()&&inputs.visual)return {...status,result:null,resultMatches:false,
      label:'本地同步',message:'Krea 2 用于文生图 · 当前草图继续本地上色'};
    if(!status.connected)return {...status,label:'AI 未连接',message:isApi()?'本地预览 · 连接后台后可手动出图':'本地预览 · 连接 AI 后自动出图'};
    if(!inputs.visual&&!inputs.text&&!available)return {...status,label:'等待输入',message:isApi()?'填写渲染提示或接入画面':'接入画面或文字'};
    if(!available)return {...status,label:'等待内容',message:'画几笔、导入图片，或填写文字描述'};
    if(matches(stopped.get(id),input))return {...status,busy:false,finalBusy:false,label:'已停止',
      message:isApi()?'已停止等待 · 可再次手动生成':'已停止出图 · 修改草图或点高清可重新生成'};
    if(activeJob||waiting||scheduled){
      const phase=progress?.job===activeJob?progress.message:'';
      const message=activeJob?.quality==='final'?'正在细化高清图':waitingFinal?'高清图已排队':
        waiting?'AI 出图中 · 已排入最新草图':phase||(scheduled?'等待提交最新草图':'AI 正在出图');
      return {...status,label:activeJob?.quality==='final'?'高清生成中':'AI 生成中',message};
    }
    if(record?.route===route&&record.error)return {...status,label:'生成失败',message:record.error,error:true};
    if(settling)return {...status,label:'准备高清',message:'实时 AI 帧已就绪 · 即将细化高清'};
    if(result&&node.auto===false&&result.quality!=='final'&&!result.manualPreview)return {...status,label:'自动已暂停',message:'自动已暂停 · 显示上一帧'};
    if(result){
      if(isApi())return {...status,label:'API 出图',message:'由出图后台生成'};
      const size=result.quality==='final'?'1280 × 1024':isKrea()?'1024 × 1024':'640 × 512';
      return {...status,label:result.quality==='final'?'高清 '+size:'AI '+size,
        message:(result.quality==='final'?'高清渲染':'实时 AI 帧')+' · '+size};
    }
    if(isApi())return {...status,label:'等待手动出图',message:'API 已连接 · 点高清发送当前输入'};
    return {...status,label:node.auto===false?'自动已暂停':'等待 AI 首帧',
      message:node.auto===false?'自动预览已暂停':'已连接 · 画一笔或输入描述'};
  }

  function renderFinal(options={}){
    if(!connected()){workbench.openAISettings();return;}
    graph.setPreviewMode('ai');
    const input=readInput(currentId());
    if(!input){
      workbench.toast(isApi()?'请填写渲染提示，或接入后台支持的草图、参考图。':
        isKrea()?'Krea 2 渲染节点请只连接一份文字。':'请连接有内容的草图、参考图或文字节点。');
      return;
    }
    clearRefineTimer();
    stopped.delete(input.id);
    const quick=options.quick===true&&!isApi();
    const job=snapshot(input,quick?'preview':'final');
    if(quick){
      job.manualPreview=true;
      remember(refineAttempts,job);
    }
    const result=frames.get(job.id);
    const variant=options.variant===true;
    if(variant)job.seed=crypto.getRandomValues(new Uint32Array(1))[0];
    if(!quick&&!options.force&&!variant&&result?.route===job.route&&result.quality==='final'&&result.key===job.key&&!result.error){
      download(job.id);return;
    }
    queue.clearPending(item=>item.quality==='final'||item.route!==job.route||item.key!==job.key);
    if(queue.enqueue(job)){
      remember(attempts,job);
      message(quick?'快速预览已排队。':'高清渲染已排队。');
    }
  }

  function download(id=currentId(),savedId=null){
    const result=savedId?results(id).find(entry=>entry.id===savedId):view(id)?.result;
    if(!result)return;
    const ext=result.blob.type==='image/jpeg'?'jpg':result.blob.type==='image/webp'?'webp':'png';
    const label=savedId||result.quality==='final'?'高清渲染':'AI 预览';
    workbench.download(result.blob,'物映-'+label+'.'+ext);
  }

  function clearPreview(){
    sourceVersion++;
    thumb.hidden=true;
    thumb.removeAttribute('src');
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    previewUrl=null;
  }

  rawPreview.onclick=async()=>{
    clearPreview();
    const version=sourceVersion;
    const {visual}=graph.inputsFor();
    rawPreview.disabled=true;
    try{
      const scene=visual?.type==='sketch'?board.sceneFor(visual.documentId):null;
      const src=visual?.type==='image'?visual.image?.src:null;
      if(!scene&&!src)throw new Error('当前预览没有画面输入。');
      if(isApi()&&apiConfig?.edit===false)throw new Error('出图后台已设为仅文生图。');
      const blob=await board.captureFrame(scene,{sourceImage:src,color:isApi()||!controlnet.value});
      if(version!==sourceVersion)return;
      previewUrl=URL.createObjectURL(blob);thumb.src=previewUrl;thumb.hidden=false;
    }catch(error){if(version===sourceVersion)message(error.message,true);}
    finally{rawPreview.disabled=false;}
  };

  function storePreferences(){
    const modelPrefs=models.hidden?{checkpoint:prefs.checkpoint,controlnet:prefs.controlnet}:
      {checkpoint:checkpoint.value,controlnet:controlnet.value};
    prefs={...modelPrefs,engine:engine.value,style:renderStyle.value,autoConnect:isApi()?connected():!!address,autoRefine:autoRefine?.checked!==false};
    try{
      localStorage.setItem(endpointKey,endpoint.value.trim());
      localStorage.setItem(prefsKey,JSON.stringify(prefs));
    }catch{}
  }

  function setModelOptions(select,list,selected,placeholder){
    select.replaceChildren(new Option(placeholder,''),...list.map(name=>new Option(name,name)));
    select.value=list.includes(selected)?selected:'';
  }

  function matchingControlnet(checkpointName,nets){
    const xlName=/sdxl|xl[_ .-]|[_ .-]xl|juggernautxl/i;
    const isXL=xlName.test(checkpointName);
    const compatible=nets.filter(name=>xlName.test(name)===isXL);
    const shapes=[/scribble|sketch/i,/line[ _-]?art/i,/canny/i];
    for(const pattern of shapes){
      const model=compatible.find(name=>pattern.test(name));
      if(model)return model;
    }
    return '';
  }

  async function connectProvider(){
    if(connect.disabled)return;
    const entered=endpoint.value.trim();
    address='';kreaModels=apiConfig=null;providerRevision++;invalidateRoute();
    endpoint.disabled=connect.disabled=engine.disabled=true;models.hidden=true;
    connectionState('连接中');message(isApi()?'正在读取出图后台配置…':'正在读取 ComfyUI 模型…');
    const signal=AbortSignal.timeout(12_000);
    try{
      if(isApi()){
        const response=await requestApi('config',null,signal);
        const config=await response.json();
        if(!config.ready)throw new Error('请先在「出图管理」保存地址、模型和密钥。');
        apiConfig=config;
        connectionState('已连接',true);
        message(config.model+' 已就绪 · '+(config.edit?'支持发送草图和参考图':'仅发送文字提示'));
        storePreferences();
        graph.setPreviewMode('ai');
        return;
      }
      if(isKrea()){
        kreaModels=await comfy.testKreaConnection(entered,{signal});
        address=entered;
        connectionState('已连接',true);
        message('Krea 2 Turbo 已就绪。将文字单独接入渲染节点即可生成。');
        storePreferences();
        graph.setPreviewMode('ai');
        return;
      }
      const found=await comfy.testConnection(entered,{signal});
      const checkpoints=found.checkpoints.filter(name=>!/(?:^|[ _./-])(flux|sd3|wan|qwen|chroma)(?:[ _./-]|$)/i.test(name));
      const selected=checkpoints.includes(prefs.checkpoint)?prefs.checkpoint:checkpoints.find(name=>/turbo|lcm/i.test(name))||checkpoints[0]||'';
      setModelOptions(checkpoint,checkpoints,selected,'请选择基础模型');
      const guide=prefs.controlnet===''||found.controlnets.includes(prefs.controlnet)
        ?prefs.controlnet:matchingControlnet(selected,found.controlnets);
      setModelOptions(controlnet,found.controlnets,guide,'图生图控形');
      address=entered;models.hidden=false;
      connectionState(checkpoints.length?'已连接':'缺基础模型',!!selected);
      message(checkpoints.length?'连接成功。相连的输入可自动出图。':'服务可访问，请在 ComfyUI 装好一个 SD 1.5 或 SDXL 检查点后重新连接。',!checkpoints.length);
      storePreferences();
      if(checkpoints.length)graph.setPreviewMode('ai');
    }catch(error){
      connectionState('未连接');
      message(signal.aborted?'连接超时，请核对服务地址和本地网络权限。':error.message,true);
    }finally{endpoint.disabled=connect.disabled=engine.disabled=false;invalidateRoute();}
  }

  connect.onclick=connectProvider;
  function resetConnection(){
    address='';kreaModels=apiConfig=null;providerRevision++;models.hidden=true;connectionState('未连接');invalidateRoute();
  }
  endpoint.oninput=resetConnection;
  engine.onchange=()=>{
    syncEngineUI();
    resetConnection();clearPreview();storePreferences();
    message(isApi()?'先配置出图后台，再点连接。':isKrea()?'连接 ComfyUI 并读取 Krea 2 Turbo 模型。':'连接 ComfyUI 开始草图控形。');
  };
  for(const field of [checkpoint,controlnet])field.addEventListener('change',()=>{
    providerRevision++;connectionState(checkpoint.value?'已连接':'缺基础模型',connected());
    storePreferences();clearPreview();invalidateRoute();
  });
  function updateStrength(){
    $('strengthReadout').value=Number(strength.value).toFixed(2);
    $('deskStrength').value=strength.value;
    $('deskStrengthValue').value=Math.round(Number(strength.value)*100)+'%';
    inputChanged();
  }
  strength.addEventListener('input',updateStrength);
  updateStrength();
  prompt.addEventListener('input',inputChanged);
  $('deskStrength').oninput=event=>{
    strength.value=event.target.value;
    updateStrength();
  };
  renderStyle.onchange=()=>{storePreferences();inputChanged();};
  autoRefine?.addEventListener('change',()=>{
    storePreferences();
    invalidateRoute();
  });
  const presets={
    ps:'Industrial design line sketch, Photoshop marker rendering, translucent color blocks, contour linework, soft cast shadow',
    metal:'Product photography, satin brushed aluminum, softbox reflections, soft studio shadows',
    fabric:'Product photography, woven textile, matte polymer, soft diffused daylight',
    clay:'Industrial product clay model, matte warm white, broad overhead light, clean silhouette'
  };
  document.querySelectorAll('[data-render-preset]').forEach(button=>button.onclick=()=>{
    prompt.value=presets[button.dataset.renderPreset];inputChanged();
  });
  $('generateRender').onclick=renderFinal;

  workbench.live={connected,apiMode:isApi,view,renderFinal,download,cancel,results,resultStorage:history.storage,restoreResult(id){
    const settings=results().find(result=>result.id===id)?.settings;
    if(!settings)return;
    prompt.value=settings.prompt;
    renderStyle.value=settings.style;
    strength.value=settings.strength;
    storePreferences();
    updateStrength();
  },retry(id){
    attempts.delete(id);
    stopped.delete(id);
    requestSample();
  }};
  window.addEventListener('controlsourcechange',clearPreview);
  window.addEventListener('graphchange',invalidateRoute);
  window.addEventListener('graphinputchange',inputChanged);
  window.addEventListener('boardscenechange',inputChanged);
  window.addEventListener('sketchstatechange',inputChanged);
  window.addEventListener('pagehide',event=>{
    if(event.persisted)return;
    history.dispose();
    for(const frame of frames.values())if(frame.src)URL.revokeObjectURL(frame.src);
    if(previewUrl)URL.revokeObjectURL(previewUrl);
  });
  if(prefs.autoConnect===true)connectProvider();
  else changed();
})();
