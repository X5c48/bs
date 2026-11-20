(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const configForm=$('configForm'), renderForm=$('renderForm'), key=$('key');
  const testConnection=$('testConnection'), clearKey=$('clearKey'), testRender=$('testRender');
  const configStatus=$('configStatus'), renderStatus=$('renderStatus'), output=$('outputImage');
  let config=null, busy=false, outputUrl='';
  function say(node,message,error=false){node.textContent=message;node.dataset.error=String(error);}
  function refresh(){
    const label=$('adminState');
    label.dataset.ready=String(!!config?.ready);
    label.textContent=config?.ready?'配置已保存':config?'待配置':'后台未就绪';
    testConnection.disabled=testRender.disabled=busy||!config?.ready;
    clearKey.disabled=busy||!config?.hasKey;
    configForm.querySelector('button[type=submit]').disabled=busy;
    $('imageField').hidden=config?.edit===false;
    $('keyHint').textContent=config?.hasKey?'后台已有密钥。留空可保留同一地址的密钥。':'密钥只保存在运行中的本机后台。';
  }
  async function request(route,body){
    const res=await fetch('/api/'+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
    if(!res.ok){
      const payload=await res.json().catch(()=>null);
      throw new Error(payload?.error||'后台请求失败。');
    }
    return res;
  }
  async function run(status,working,task){
    if(busy)return;
    busy=true;refresh();say(status,working);
    try{await task();}catch(error){say(status,error.message||'请求失败。',true);}
    finally{busy=false;refresh();}
  }
  function fields(){
    return {baseUrl:$('baseUrl').value,model:$('model').value,size:$('size').value,edit:$('inputMode').value==='edit'};
  }
  function showConfig(next){
    config=next;
    $('baseUrl').value=next.baseUrl;$('model').value=next.model;$('size').value=next.size;
    $('inputMode').value=next.edit?'edit':'text';key.value='';refresh();
  }
  async function save(clear=false){
    await run(configStatus,'正在保存…',async()=>{
      const values=clear?config:fields();
      showConfig(await (await request('config',{...values,key:clear?'':key.value,clearKey:clear})).json());
      say(configStatus,clear?'已清除密钥。':config.ready?'已保存，可以测试连接或生成。':'已保存地址与模型，请补填密钥。');
    });
  }
  configForm.onsubmit=event=>{event.preventDefault();save();};
  clearKey.onclick=()=>save(true);
  testConnection.onclick=()=>run(configStatus,'正在检查接口…',async()=>{
    await request('test',{});
    say(configStatus,'模型接口已响应。可再生成一张测试图验证出图权限。');
  });
  renderForm.onsubmit=event=>{
    event.preventDefault();
    if(!config?.ready)return;
    run(renderStatus,'正在生成，请稍候…',async()=>{
      const file=config.edit?$('testImage').files[0]:null;
      if(file?.size>8*1024*1024)throw new Error('参考图需小于 8 MB。');
      const image=file?await new Promise((resolve,reject)=>{
        const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);
      }):undefined;
      const result=await (await request('render',{prompt:$('testPrompt').value,image,revision:config.revision})).blob();
      if(outputUrl)URL.revokeObjectURL(outputUrl);
      outputUrl=URL.createObjectURL(result);output.src=outputUrl;output.hidden=false;$('emptyImage').hidden=true;
      say(renderStatus,'测试图已生成。');
    });
  };
  run(configStatus,'正在读取配置…',async()=>{
    showConfig(await (await request('config')).json());say(configStatus,'');
  });
  const conceptForm=$('conceptConfigForm'), conceptKey=$('conceptKey'), conceptStatus=$('conceptConfigStatus');
  const conceptClear=$('clearConceptKey');
  let conceptConfig=null, conceptBusy=false;

  function showConceptConfig(next){
    conceptConfig=next;
    $('conceptBaseUrl').value=next.baseUrl;
    $('conceptModel').value=next.model;
    conceptKey.value='';
    $('conceptKeyHint').textContent=next.hasKey?'同一地址留空可保留密钥。重启后台后需重新配置。':'文字模型配置保存在运行中的本机后台，重启后需重新填写。';
  }

  async function runConcept(working,task){
    if(conceptBusy)return;
    conceptBusy=true;
    const submit=conceptForm.querySelector('button[type=submit]');
    submit.disabled=conceptClear.disabled=true;
    say(conceptStatus,working);
    try{await task();}catch(error){say(conceptStatus,error.message||'文字模型配置请求失败。',true);}
    finally{conceptBusy=false;submit.disabled=false;conceptClear.disabled=!conceptConfig?.hasKey;}
  }

  async function saveConcept(clearKey=false){
    await runConcept('正在保存文字模型配置…',async()=>{
      const {baseUrl,model}=clearKey?conceptConfig:{baseUrl:$('conceptBaseUrl').value,model:$('conceptModel').value};
      showConceptConfig(await (await request('concept/config',{baseUrl,model,key:clearKey?'':conceptKey.value,clearKey})).json());
      say(conceptStatus,clearKey?'已清除文字密钥。':conceptConfig.ready?'文字模型配置已保存。':'已保存地址与模型，请补填文字密钥。');
    });
  }

  conceptForm.onsubmit=event=>{event.preventDefault();saveConcept();};
  conceptClear.onclick=()=>saveConcept(true);
  runConcept('正在读取文字模型配置…',async()=>{
    showConceptConfig(await (await request('concept/config')).json());
    say(conceptStatus,conceptConfig.ready?'文字模型配置已保存。':'');
  });

  const hubForm=$('hubForm'), hubKey=$('hubKey'), hubStatus=$('hubStatus');
  const hubTest=$('hubTest'), hubClear=$('hubClear');
  let hubConfig=null, hubBusy=false;
  function showHub(next){
    hubConfig=next;hubKey.value='';
    $('hubKeyHint').textContent=next.hasKey?'后台已有密钥。重新填写会替换它。':'尚未填写密钥。';
    $('hubModels').textContent=next.models?.length?'可用模型：'+next.models.map(m=>m.label).join('、'):'';
  }
  function hubButtons(){
    hubForm.querySelector('button[type=submit]').disabled=hubBusy;
    hubTest.disabled=hubBusy||!hubConfig?.ready;
    hubClear.disabled=hubBusy||!hubConfig?.hasKey;
  }
  async function runHub(working,task){
    if(hubBusy)return;
    hubBusy=true;hubButtons();say(hubStatus,working);
    try{await task();}catch(error){say(hubStatus,error.message||'RunningHub 请求失败。',true);}
    finally{hubBusy=false;hubButtons();}
  }
  hubForm.onsubmit=event=>{
    event.preventDefault();
    runHub('正在保存密钥…',async()=>{
      if(!hubKey.value.trim())throw new Error('请先粘贴 API Key。');
      showHub(await (await request('runninghub/config',{key:hubKey.value})).json());
      say(hubStatus,'密钥已保存，可以测试连接。');
    });
  };
  hubClear.onclick=()=>runHub('正在清除…',async()=>{
    showHub(await (await request('runninghub/config',{clearKey:true})).json());
    say(hubStatus,'已清除 RunningHub 密钥。');
  });
  hubTest.onclick=()=>runHub('正在连接 RunningHub…',async()=>{
    const info=await (await request('runninghub/test',{})).json();
    const parts=[];
    if(info.remainMoney!=null)parts.push('余额 '+info.remainMoney);
    if(info.remainCoins!=null)parts.push('RH 币 '+info.remainCoins);
    if(info.currentTaskCounts!=null)parts.push('运行中任务 '+info.currentTaskCounts);
    say(hubStatus,'连接成功。'+(parts.length?parts.join('，')+'。':''));
  });
  runHub('正在读取 RunningHub 配置…',async()=>{
    showHub(await (await request('runninghub/config')).json());
    say(hubStatus,hubConfig.ready?'后台已有 RunningHub 密钥。':'');
  });
})();
