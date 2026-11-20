'use strict';

// RunningHub 标准模型 API：上传 → 提交 → 轮询 /openapi/v2/query → 下载结果。
// 密钥只留在本机后台进程里，浏览器端只拿到 ready / 模型列表。
const qwenSizes=['1024*1024','1536*1536','768*1152','1024*1536','1152*768','1536*1024','960*1280','1080*1440',
  '1280*960','1440*1080','720*1280','1080*1920','1280*720','1920*1080','1344*576','2048*872'];
const v2Ratios=['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'];
const g2Ratios=['1:1','1:2','2:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9','9:21'];

// 比例最接近者胜；比例相同时取面积更大的（如 1536*1024 优先于 1152*768）。
function closest(values,aspect,read){
  const gap=value=>Math.abs(Math.log(read(value)/aspect));
  const area=value=>value.split(/[:*]/).map(Number).reduce((a,b)=>a*b,1);
  return values.reduce((best,value)=>{
    const d=gap(value)-gap(best);
    return d< -1e-9||Math.abs(d)<=1e-9&&area(value)>area(best)?value:best;
  });
}
const ratio=value=>{const [w,h]=value.split(/[:*]/).map(Number);return w/h;};

const presets={
  'qwen-image-2.0-edit':{label:'千问 2.0 图像编辑',max:3,path:'/openapi/v2/alibaba/qwen-image-2.0/image-edit',
    body:({prompt,urls,aspect})=>({imageUrls:urls,prompt,size:closest(qwenSizes,aspect,ratio)})},
  'seedream-v4.5':{label:'Seedream 4.5 图生图',max:10,path:'/openapi/v2/seedream-v4.5/image-to-image',
    body:({prompt,urls,aspect,resolution})=>{
      const long=resolution==='4k'?4096:2048, wide=aspect>=1;
      const width=Math.round((wide?long:long*aspect)/8)*8, height=Math.round(wide?long/aspect:long);
      return {imageUrls:urls,prompt,width:Math.max(512,width),height:Math.max(512,height),
        sequentialImageGeneration:'disabled',maxImages:1};
    }},
  'seedream-v5-pro':{label:'Seedream V5 Pro · 稳定版',max:10,path:'/openapi/v2/seedream-v5-pro/image-to-image',
    body:({prompt,urls,aspect})=>{
      const dimension=value=>Math.max(1024,Math.round(value/8)*8);
      return {imageUrls:urls,prompt,width:dimension(2048*Math.min(aspect,1)),
        height:dimension(2048*Math.min(1/aspect,1)),resolution:'2k',outputFormat:'png'};
    }},
  'omni-v2':{label:'全能图片 V2 · 官方稳定版',max:14,path:'/openapi/v2/rhart-image-n-g31-flash-official/image-to-image',
    body:({prompt,urls,aspect,resolution})=>({imageUrls:urls,prompt,aspectRatio:closest(v2Ratios,aspect,ratio),resolution})},
  'omni-g2':{label:'全能图片 G-2 · 官方稳定版',max:10,path:'/openapi/v2/rhart-image-g-2-official/image-to-image',
    body:({prompt,urls,aspect,resolution,mode})=>({imageUrls:urls,prompt,aspectRatio:closest(g2Ratios,aspect,ratio),resolution,
      quality:mode==='pro'?'high':'medium'})}
};
const resolutions=['1k','2k','4k'];

const messages={
  802:'RunningHub 密钥无效或已停用。',1002:'RunningHub 密钥无效或已停用。',811:'RunningHub 密钥无效或已停用。',
  1014:'标准模型 API 只支持「企业级-共享」API Key，请在 RunningHub 控制台创建这一类密钥。',
  416:'RunningHub 余额不足。',605:'RunningHub 账户余额不足，请充值后重试。',812:'RunningHub 余额不足。',
  421:'RunningHub 并发已满，请稍后再试。',1003:'RunningHub 请求过于频繁，请稍后再试。',1520:'RunningHub 并发已满，请稍后再试。',
  1011:'模型繁忙，请稍后再试。',1501:'提示词或图片未通过内容审核，请修改后再试。',1505:'该模型不处理真人图像。',
  1007:'模型参数校验失败，请换一个模型或检查提示词长度。',1008:'图片过大，请缩小后再试。'
};

function createRunningHub({ApiError,decodeImage,downloadImage,origin='https://www.runninghub.cn',env={},pollMs=3000,deadlineMs=175000}){
  let key=String(env.WUYING_RUNNINGHUB_KEY||'').trim();
  const models=Object.entries(presets).map(([id,{label,max}])=>({id,label,max}));
  const config=()=>({ready:!!key,hasKey:!!key,models});
  const fail=(code,fallback)=>{
    throw new ApiError(502,(messages[Number(code)]||fallback||'RunningHub 未能完成任务。')+(code?'（错误码 '+code+'）':''));
  };

  async function call(path,body,signal){
    const form=body instanceof FormData;
    const response=await fetch(origin+path,{method:'POST',signal,redirect:'error',
      headers:{Authorization:'Bearer '+key,...(form?{}:{'Content-Type':'application/json'})},
      body:form?body:JSON.stringify(body)});
    let data=null;
    try{ data=await response.json(); }catch{}
    if(!response.ok)fail(data?.errorCode||data?.code,'RunningHub 返回 HTTP '+response.status+'。');
    if(!data||typeof data!=='object')fail(0,'RunningHub 返回了无法解析的内容。');
    if(typeof data.code==='number'&&data.code!==0)fail(data.code,data.msg||data.message);
    if(data.errorCode&&String(data.errorCode)!=='0')fail(data.errorCode,data.errorMessage);
    return data;
  }

  function update(data){
    const entered=typeof data.key==='string'?data.key.trim():'';
    if(entered.length>512||/[^\x21-\x7e]/.test(entered))throw new ApiError(400,'密钥包含无效字符。');
    if(data.clearKey===true)key='';else if(entered)key=entered;
    return config();
  }

  async function test(signal){
    if(!key)throw new ApiError(400,'请先填写 RunningHub API Key。');
    const data=await call('/uc/openapi/accountStatus',{apikey:key},signal);
    const info=data.data||{};
    return {ok:true,remainCoins:info.remainCoins??null,remainMoney:info.remainMoney??null,currentTaskCounts:info.currentTaskCounts??null};
  }

  async function upload(bytes,type,signal){
    const form=new FormData();
    form.append('file',new Blob([bytes],{type}),'wuying.'+type.split('/')[1]);
    const data=await call('/openapi/v2/media/upload/binary',form,signal);
    const url=data.data?.download_url;
    if(typeof url!=='string'||!(/^https:\/\//.test(url)||url.startsWith(origin+'/')))fail(0,'RunningHub 上传后没有返回图片地址。');
    return url;
  }

  const wait=(ms,signal)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,ms);
    signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
  });

  async function render(data,signal){
    if(!key)throw new ApiError(400,'请先在出图后台填写 RunningHub API Key。');
    const preset=Object.hasOwn(presets,data.model)?presets[data.model]:null;
    if(!preset)throw new ApiError(400,'未知的 RunningHub 模型。');
    const prompt=typeof data.prompt==='string'?data.prompt.trim():'';
    if(prompt.length<5||prompt.length>6000)throw new ApiError(400,'提示词需为 5–5000 字。');
    const resolution=data.resolution===undefined?'1k':data.resolution;
    if(!resolutions.includes(resolution))throw new ApiError(400,'分辨率只能是 1K、2K 或 4K。');
    const mode=data.mode===undefined?'standard':data.mode;
    if(!['standard','pro'].includes(mode))throw new ApiError(400,'模式只能是 Standard 或 Pro。');
    const images=Array.isArray(data.images)?data.images:[];
    if(!images.length||images.length>Math.min(4,preset.max))throw new ApiError(400,'这个模型最多接收 '+Math.min(4,preset.max)+' 张图。');
    const aspect=Number(data.aspect);
    if(!(aspect>=0.2&&aspect<=5))throw new ApiError(400,'源图比例无效。');
    const decoded=images.map(image=>decodeImage(image));
    const urls=[];
    for(const {bytes,type} of decoded)urls.push(await upload(bytes,type,signal));
    let task=await call(preset.path,preset.body({prompt,urls,aspect,resolution,mode}),signal);
    const taskId=task.taskId;
    if(!taskId&&!task.results?.length)fail(0,'RunningHub 没有返回任务编号。');
    const started=Date.now();
    while(task.status!=='SUCCESS'){
      if(task.status==='FAILED')fail(task.errorCode,task.errorMessage||'RunningHub 任务失败。');
      if(Date.now()-started>deadlineMs)throw new ApiError(504,'RunningHub 任务超时。任务可能仍在运行，可在控制台「任务与账单」查看。');
      await wait(pollMs,signal);
      task=await call('/openapi/v2/query',{taskId},signal);
    }
    const url=task.results?.find(item=>typeof item?.url==='string'&&item.url)?.url;
    if(!url)fail(0,'RunningHub 任务完成但没有图片结果。');
    return downloadImage(url,signal);
  }

  async function startVideo(data,signal){
    if(!key)throw new ApiError(400,'请先在后台管理填写 RunningHub API Key。');
    const duration=Number(data.duration),prompt=typeof data.prompt==='string'?data.prompt.trim():'';
    if(!['image','text'].includes(data.mode)||!Number.isInteger(duration)||duration<3||duration>15||prompt.length<5||prompt.length>2000)
      throw new ApiError(400,'请选择视频模式和 3–15 秒时长，并输入 5–2000 字的镜头描述。');
    if(data.last)throw new ApiError(400,'当前 RunningHub 模型只接受首帧。');
    const body={prompt,duration:String(duration)};
    if(data.mode==='image'){
      const {bytes,type}=decodeImage(data.first);
      body.firstImageUrl=await upload(bytes,type,signal);
    }else{
      if(data.first||!['16:9','9:16','1:1'].includes(data.aspect))throw new ApiError(400,'请选择有效的视频画幅。');
      body.aspectRatio=data.aspect;
    }
    const task=await call('/openapi/v2/kling-v3-turbo-std/'+data.mode+'-to-video',body,signal);
    if(!task.taskId)fail(0,'RunningHub 未返回视频任务编号。请到任务中心核对后再提交。');
    return {taskId:String(task.taskId),status:task.status||'QUEUED'};
  }

  async function videoStatus(taskId,signal){
    if(!key)throw new ApiError(400,'请先在后台管理填写 RunningHub API Key。');
    if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(taskId))throw new ApiError(400,'视频任务编号无效。');
    const task=await call('/openapi/v2/query',{taskId},signal);
    if(task.status==='FAILED'||task.status==='CANCELED')fail(task.errorCode,task.errorMessage||'视频生成失败或已取消。');
    const result=task.results?.find(item=>typeof item?.url==='string'&&
      (/^(mp4|webm|video\/)/i.test(item.outputType||'')||/\.(mp4|webm)(?:$|\?)/i.test(item.url)));
    if(task.status==='SUCCESS'&&!result)fail(0,'任务完成，但服务商未返回 MP4 或 WebM 视频。');
    return {status:task.status||'QUEUED',url:result?.url};
  }

  return {config,update,test,render,startVideo,videoStatus};
}

module.exports={createRunningHub,presets};
