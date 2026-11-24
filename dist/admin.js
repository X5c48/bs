(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const api=window.WuyingPlatformApi,flow=window.WuyingWorkflow;
  const tabs=Array.from(document.querySelectorAll('[data-panel]'));
  const profileForm=$('apiForm'), list=$('apiList'), endpoint=$('adminComfyEndpoint');
  let profiles=[], selected=null, dirty=false, imageBusy=false, previewUrl, comfyRead='', hubConfig, comfyBusy=false;

  const status=(id,message,error=false)=>{
    $(id).textContent=message;
    $(id).dataset.error=String(error);
  };

  function current(){
    const prefs=flow.modelPrefs();
    $('currentProvider').textContent='当前出图来源 · '+(flow.providerLabel(prefs)||'待选择');
  }
  function use(settings,id){
    flow.saveModel(settings);
    current();
    drawProfiles();
    status(id,'已设为出图来源。工作台与图像编辑室会使用此设置。');
  }
  function choosePanel(key) {
    for(const tab of tabs){
      const active=tab.dataset.panel===key;
      tab.setAttribute('aria-pressed',String(active));
      $('panel-'+tab.dataset.panel).hidden=!active;
    }
  }
  tabs.forEach(tab=>tab.onclick=()=>choosePanel(tab.dataset.panel));
  const video=window.WuyingVideo, savedVideo=video.comfyConfig();
  $('videoComfyEndpoint').value=savedVideo?.endpoint||flow.modelPrefs().endpoint||'http://127.0.0.1:8188';
  const workflowInput=$('videoWorkflowJson');
  let presetSource=null;
  if(savedVideo?.preset==='ltx-2b'){
    presetSource=JSON.stringify(video.ltxWorkflow('image'),null,2);
    workflowInput.value=presetSource;
  }else if(savedVideo)workflowInput.value=JSON.stringify(savedVideo.workflow,null,2);
  $('loadLtxVideo').onclick=async()=>{
    const button=$('loadLtxVideo');
    button.disabled=true;
    status('videoWorkflowStatus','正在检查本机视频模型…');
    try{
      const preset=await video.ltxPreset($('videoComfyEndpoint').value.trim());
      presetSource=JSON.stringify(preset,null,2);
      workflowInput.value=presetSource;
      status('videoWorkflowStatus','已载入 LTX-Video 2B 预设。保存后在工作台切换首帧、首尾帧或文生视频。');
    }catch(error){status('videoWorkflowStatus',error.message,true);}
    finally{button.disabled=false;}
  };
  $('videoWorkflowForm').onsubmit=async event=>{
    event.preventDefault();
    try{
      const endpoint=$('videoComfyEndpoint').value.trim(), source=workflowInput.value;
      if(presetSource!==null&&source.trim()===presetSource){
        await video.ltxPreset(endpoint);
        video.saveComfyPreset(endpoint);
      }else video.saveComfy(endpoint,source);
      status('videoWorkflowStatus','已更新本机视频设置。');
    }catch(error){status('videoWorkflowStatus',error.message,true);}
  };

  function drawProfiles(){
    const active=flow.modelPrefs();
    list.replaceChildren();
    for(const item of profiles){
      const button=document.createElement('button'), title=document.createElement('strong'), detail=document.createElement('small');
      const inUse=active.provider==='imageapi'&&active.apiProfileId===item.id;
      title.textContent=item.name;
      detail.textContent=item.model+(inUse?' · 当前来源':!item.ready?' · 缺少密钥':item.edit?' · 图片编辑':' · 仅文生图');
      button.type='button';
      button.className='admin-item';
      button.disabled=imageBusy;
      button.setAttribute('aria-pressed',String(item.id===selected?.id));
      button.append(title,detail);
      button.onclick=()=>fillProfile(item);
      list.append(button);
    }
    if(!profiles.length){
      const empty=document.createElement('p');
      empty.className='admin-muted';empty.textContent='还没有添加图片接口。';
      list.append(empty);
    }
  }
  function profileButtons(){
    $('saveApi').disabled=$('addApi').disabled=imageBusy;
    $('testApi').disabled=$('tryApi').disabled=imageBusy||dirty||!selected?.ready;
    $('useApi').disabled=imageBusy||dirty||!selected?.ready||!selected.edit;
    $('apiPreview').hidden=!selected?.ready;
  }
  function fillProfile(item){
    if(previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl=undefined;
    $('apiPreviewImage').hidden=true;
    $('apiPreviewImage').removeAttribute('src');
    selected=item;
    dirty=false;
    $('apiTitle').textContent=item?'编辑图片接口':'添加图片接口';
    $('apiName').value=item?.name||'';
    $('apiName').readOnly=item?.id==='default';
    $('apiUrl').value=item?.baseUrl||'';
    $('apiModel').value=item?.model||'';
    $('apiSize').value=item?.size||'';
    $('apiMode').value=item?.edit===false?'text':'edit';
    $('apiImageField').value=item?.imageField==='image'?'image':'image[]';
    $('apiKey').value='';
    $('apiKey').placeholder=item?.hasKey?'已保存，保持同一地址时留空即可':'粘贴服务商提供的密钥';
    status('apiStatus',item&&!item.ready?'请填写 API 密钥。':'');
    profileButtons();
    drawProfiles();
  }

  async function imageTask(label,action){
    if(imageBusy) return;
    imageBusy=true;
    profileButtons();drawProfiles();
    status('apiStatus',label);
    try { await action(); }
    catch(error){status('apiStatus',error.message,true);}
    finally{imageBusy=false;profileButtons();drawProfiles();}
  }
  $('addApi').onclick=()=>{
    fillProfile(null);
    $('apiName').focus();
  };
  // apilio.ai 模型中转：OpenAI 官方格式，填 sk 即可。预填地址和编辑模型，字段用 image。
  $('addApilio').onclick=()=>{
    fillProfile({name:'apilio.ai',baseUrl:'https://apilio.ai/v1',model:'gpt-image-1',edit:true,imageField:'image',size:''});
    $('apiTitle').textContent='添加 apilio.ai 接口';
    status('apiStatus','已预填 apilio.ai。请粘贴在「API Token」页创建的 sk，点「保存接口」；模型可在上方改为模型广场里的图片模型。连不上时地址可换 https://api.apilio.ai/v1 或 https://apicn.apilio.ai/v1。');
    $('apiKey').focus();
  };
  profileForm.oninput=event=>{
    if(event.target.id==='apiPrompt') return;
    dirty=true;
    profileButtons();
  };
  profileForm.onsubmit=event=>{
    event.preventDefault();
    const fields={id:selected?.id,name:$('apiName').value,baseUrl:$('apiUrl').value,model:$('apiModel').value,
      size:$('apiSize').value,edit:$('apiMode').value==='edit',imageField:$('apiImageField').value,key:$('apiKey').value};
    void imageTask('正在保存接口…',async()=>{
      const saved=await api.request('image-profiles',fields);
      const index=profiles.findIndex(item=>item.id===saved.id);
      if(index<0) profiles.push(saved);else profiles[index]=saved;
      fillProfile(saved);
      const prefs=flow.modelPrefs();
      if(prefs.apiProfileId===saved.id){
        flow.saveModel({apiProfileName:saved.name});
        current();
      }
      status('apiStatus',saved.ready?'接口已保存。':'地址和模型已保存，请补填密钥。');
    });
  };
  $('testApi').onclick=()=>void imageTask('正在测试接口…',async()=>{
    const result=await api.request('image-profiles/test',{id:selected.id});
    status('apiStatus',result?.message||'连接成功。',result?.modelMissing===true);
  });
  $('useApi').onclick=()=>{
    if(!selected?.ready||!selected.edit||dirty) return;
    use({provider:'imageapi',apiProfileId:selected.id,apiProfileName:selected.name},'apiStatus');
  };
  $('tryApi').onclick=()=>void imageTask('正在生成试图…',async()=>{
    const prompt=$('apiPrompt').value.trim();
    if(!prompt) throw new Error('请输入出图提示。');
    const blob=await api.request('image-profiles/render',{id:selected.id,revision:selected.revision,prompt},{image:true});
    if(previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(blob);
    $('apiPreviewImage').src=previewUrl;
    $('apiPreviewImage').hidden=false;
    status('apiStatus','试图已返回。');
  });

  function values(select,names,preferred,placeholder){
    select.replaceChildren();
    if(placeholder||!names.length) select.add(new Option(placeholder||'未找到模型',''));
    for(const value of names) select.add(new Option(value,value));
    if(names.includes(preferred)) select.value=preferred;
  }
  function comfyButtons(){
    $('readComfy').disabled=comfyBusy;
    $('useComfy').disabled=comfyBusy||endpoint.value.trim()!==comfyRead||!$('adminCheckpoint').value;
  }
  endpoint.value=flow.imageToolEndpoint();
  endpoint.oninput=()=>{
    comfyRead='';
    comfyButtons();
  };
  $('adminCheckpoint').onchange=comfyButtons;
  $('comfyForm').onsubmit=async event=>{
    event.preventDefault();
    if(comfyBusy) return;
    const address=endpoint.value.trim(),prefs=flow.modelPrefs();
    comfyBusy=true;comfyRead='';comfyButtons();
    status('comfyStatus','正在读取本机模型…');
    try{
      const models=await flow.checkModel(address);
      if(endpoint.value.trim()!==address) return;
      values($('adminCheckpoint'),models.checkpoints,prefs.checkpoint);
      values($('adminControlnet'),models.controlnets,prefs.controlnet,'无');
      comfyRead=address;
      status('comfyStatus',models.checkpoints.length?'已读取模型，可以选择并使用。':'服务在线，未找到基础模型。',!models.checkpoints.length);
    }catch(error){status('comfyStatus',error.message,true);}
    finally{comfyBusy=false;comfyButtons();}
  };
  $('useComfy').onclick=()=>{
    if(endpoint.value.trim()!==comfyRead||!$('adminCheckpoint').value) return;
    use({provider:'comfy',endpoint:comfyRead,checkpoint:$('adminCheckpoint').value,controlnet:$('adminControlnet').value},'comfyStatus');
  };

  function showHub(config){
    hubConfig=config;
    $('adminHubKey').value='';
    $('adminHubKey').placeholder=config.hasKey?'已保存，重新填写可替换':'粘贴企业级-共享 API Key';
    $('testHub').disabled=$('useHub').disabled=!config.ready;
  }
  $('hubAdminForm').onsubmit=async event=>{
    event.preventDefault();
    const key=$('adminHubKey').value.trim();
    if(!key){status('hubAdminStatus','请粘贴 API Key。',true);return;}
    try {
      showHub(await api.request('runninghub/config',{key}));
      status('hubAdminStatus','密钥已保存。');
    }catch(error){status('hubAdminStatus',error.message,true);}
  };
  $('testHub').onclick=async()=>{
    $('testHub').disabled=true;
    status('hubAdminStatus','正在检查 RunningHub…');
    try{
      const info=await flow.checkCloud();
      status('hubAdminStatus','连接成功'+(info.remainMoney!=null?' · 余额 ¥'+info.remainMoney:'')+(info.remainCoins!=null?' · 剩余 RH 币 '+info.remainCoins:''));
    }catch(error){status('hubAdminStatus',error.message,true);}
    finally{$('testHub').disabled=!hubConfig?.ready;}
  };
  $('useHub').onclick=()=>{
    if(hubConfig?.ready) use({provider:'runninghub',cloudModel:$('adminHubModel').value},'hubAdminStatus');
  };
  for(const model of flow.cloudModels) $('adminHubModel').add(new Option(flow.cloudNames[model]||model,model));
  const prefs=flow.modelPrefs();
  if(flow.cloudModels.includes(prefs.cloudModel)) $('adminHubModel').value=prefs.cloudModel;

  function showText(config){
    $('textUrl').value=config.baseUrl||'';
    $('textModel').value=config.model||'';
    $('textKey').value='';
    $('textKey').placeholder=config.hasKey?'已保存，保持同一地址时留空即可':'粘贴文字接口密钥';
  }
  $('textAdminForm').onsubmit=async event=>{
    event.preventDefault();
    try{
      const result=await api.request('concept/config',{baseUrl:$('textUrl').value,model:$('textModel').value,key:$('textKey').value});
      showText(result);
      status('textAdminStatus',result.ready?'文字接口已保存。':'已保存地址和模型，请补填密钥。');
    }catch(error){status('textAdminStatus',error.message,true);}
  };

  current();
  const initial=new URLSearchParams(location.search).get('source');
  if(tabs.some(tab=>tab.dataset.panel===initial)) choosePanel(initial);
  void imageTask('正在读取接口…',async()=>{
    profiles=await api.list();
    fillProfile(profiles.find(item=>item.id===prefs.apiProfileId)||profiles[0]||null);
  });
  void api.request('runninghub/config').then(showHub).catch(error=>status('hubAdminStatus',error.message,true));
  void api.request('concept/config').then(showText).catch(error=>status('textAdminStatus',error.message,true));
  window.addEventListener('pagehide',()=>{if(previewUrl) URL.revokeObjectURL(previewUrl);});
})();

