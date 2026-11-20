(() => {
  'use strict';
  const origin='http://127.0.0.1:8882';

  async function request(route,body,{signal,image=false}={}){
    const options={cache:'no-store',signal};
    if(body!==undefined) Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    let response;
    try { response=await fetch(origin+'/api/'+route,options); }
    catch(error){
      signal?.throwIfAborted();
      throw new Error('无法连接物映后台，请启动「启动出图后台.cmd」。');
    }
    if(!response.ok){
      if(response.status===404&&route.startsWith('runninghub/video/')){
        throw new Error('当前出图后台尚未载入视频接口。请更新并重启出图后台，然后在后台管理重新填写 RunningHub 密钥。');
      }
      if(response.status===404&&route==='image-profiles') throw new Error('后台还未加载当前版本，请重新启动出图后台。');
      const payload=await response.json().catch(()=>null);
      throw new Error(payload?.error||'物映后台返回 HTTP '+response.status+'。');
    }
    return image?response.blob():response.json();
  }

  async function list(options){
    const result=await request('image-profiles',undefined,options);
    if(!Array.isArray(result.profiles)) throw new Error('无法读取图片接口列表。');
    return result.profiles;
  }

  async function getProfile(id,options){
    const profiles=await list(options);
    const profile=profiles.find(item=>item.id===id);
    if(!profile?.edit||!profile.ready) throw new Error('请在「后台管理」选择已配置密钥的图片编辑接口。');
    return profile;
  }

  async function fillSelect(select,preferred,options){
    const profiles=await list(options);
    options?.signal?.throwIfAborted();
    select.replaceChildren(new Option('选择已添加的接口',''));
    for(const profile of profiles){
      const label=profile.name+' · '+profile.model+(!profile.ready?'（缺少密钥）':!profile.edit?'（仅文生图）':'');
      const option=new Option(label,profile.id);
      option.disabled=!profile.ready||!profile.edit;
      select.add(option);
    }
    const selected=profiles.find(profile=>profile.id===preferred&&profile.ready&&profile.edit)
      ||profiles.find(profile=>profile.ready&&profile.edit);
    select.value=selected?.id||'';
    return profiles;
  }

  window.WuyingPlatformApi={origin,request,list,getProfile,fillSelect};
})();

