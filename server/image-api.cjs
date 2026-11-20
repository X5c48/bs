'use strict';

const http = require('node:http');
const https = require('node:https');
const { lookup } = require('node:dns/promises');
const { BlockList } = require('node:net');
const { randomUUID } = require('node:crypto');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { createConceptApi } = require('./concept-api.cjs');
const { createRunningHub } = require('./runninghub.cjs');
const { createImageProfiles } = require('./image-profiles.cjs');

const port = 8882;
const imageLimit = 20 * 1024 * 1024;
const previewOrigins = new Set(['http://127.0.0.1:8881','http://localhost:8881']);
const loopbacks = new Set(['127.0.0.1','localhost']);
const assets = {
  '/admin/': ['index.html','text/html; charset=utf-8'],
  '/admin/admin.js': ['admin.js','text/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css','text/css; charset=utf-8']
};
const privateIp = new BlockList();
for(const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',3]]) {
  privateIp.addSubnet(address,bits);
}

class ApiError extends Error {
  constructor(status,message){ super(message); this.status=status; }
}

function safeBase(value){
  let url;
  try{ url=new URL(String(value||'').trim()); }catch{ throw new ApiError(400,'请填写完整的 API 地址。'); }
  if(url.username||url.password||url.search||url.hash||
    !(url.protocol==='https:'||url.protocol==='http:'&&loopbacks.has(url.hostname))){
    throw new ApiError(400,'API 地址需使用 HTTPS。本机接口可使用 HTTP。请把密钥单独填写。');
  }
  return url.origin+url.pathname.replace(/\/+$/,'').replace(/\/(?:images\/(?:generations|edits)|models)$/,'');
}

function publicProfile(input){
  const baseUrl=safeBase(input.baseUrl);
  const model=typeof input.model==='string'?input.model.trim():'';
  const size=typeof input.size==='string'?input.size.trim():'';
  if(!model||model.length>180||size&&!/^\d{2,5}x\d{2,5}$/.test(size))throw new ApiError(400,'请检查模型 ID 和尺寸。尺寸留空时由模型决定。');
  // image=OpenAI 官方字段（apilio 等 new-api 中转）；image[]=国内部分中转常见字段。
  const imageField=input.imageField==='image'?'image':'image[]';
  return {baseUrl,model,size,edit:input.edit===true,imageField};
}

function keyValue(value){
  const key=typeof value==='string'?value.trim():'';
  if(key.length>2048||/[^\x21-\x7e]/.test(key))throw new ApiError(400,'密钥包含无效字符。');
  return key;
}

async function readBytes(stream,limit){
  const chunks=[];
  let length=0;
  if(stream)for await(const chunk of stream){
    length+=chunk.length;
    if(length>limit)throw new ApiError(413,'请求或返回图片过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,length);
}

async function readJson(req,limit){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new ApiError(415,'需要 JSON 请求。');
  if(Number(req.headers['content-length'])>limit)throw new ApiError(413,'请求或返回图片过大。');
  try{
    const data=JSON.parse((await readBytes(req.iterator({destroyOnReturn:false}),limit)).toString());
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();
    return data;
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError(400,'JSON 请求内容有误。');
  }
}

function imageType(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return '';
}

function decodeBase64(value,limit,status){
  if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value)){
    throw new ApiError(status,'图片数据无效或超出大小限制。');
  }
  const bytes=Buffer.from(value,'base64');
  if(!imageType(bytes)||bytes.length>limit)throw new ApiError(status,'图片需为 PNG、JPEG 或 WebP。');
  return bytes;
}

async function downloadImage(src,signal,limit=imageLimit){
  let url;
  try{ url=new URL(src); }catch{ throw new ApiError(502,'服务商返回了无效的图片地址。'); }
  if(url.protocol!=='https:'||url.username||url.password)throw new ApiError(502,'服务商图片地址需使用公开 HTTPS。');
  const {address}=await lookup(url.hostname,{family:4});
  if(privateIp.check(address))throw new ApiError(502,'服务商图片地址需使用公开 HTTPS。');
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{family:4,autoSelectFamily:false,lookup:(_host,options,done)=>
      options.all?done(null,[{address,family:4}]):done(null,address,4),signal},response=>{
      if(response.statusCode!==200){
        response.destroy();
        reject(new ApiError(502,'服务商的图片地址无法下载。'));
        return;
      }
      readBytes(response,limit).then(resolve,reject);
    });
    request.once('error',reject);
  });
}

async function upstream(profile,key,route,signal,body){
  const headers={Authorization:'Bearer '+key};
  if(typeof body==='string')headers['Content-Type']='application/json';
  const response=await fetch(profile.baseUrl+route,{headers,method:body?'POST':'GET',body,signal,redirect:'error'});
  if(response.ok)return response;
  await response.body?.cancel();
  const code=response.status;
  const message=code===401||code===403?'请检查密钥、账户权限和模型访问权限。':
    code===404?'请检查 API 地址、接口路径和模型 ID。':
    code===429?'请检查接口额度、余额或请求频率。':
    code===400||code===422?'请检查模型、尺寸和是否支持当前出图方式。':'服务商暂时未能处理请求。';
  throw new ApiError(502,'服务商返回 HTTP '+code+'。'+message);
}

async function render(profile,key,data,signal){
  const prompt=typeof data.prompt==='string'?data.prompt.trim():'';
  if(!prompt||prompt.length>4000)throw new ApiError(400,'请输入 1–4000 字的出图提示。');
  const fields={model:profile.model,prompt};
  if(profile.size)fields.size=profile.size;
  let body=JSON.stringify(fields), route='/images/generations';
  const images=data.images??(data.image?[data.image]:[]);
  if(!Array.isArray(images)||images.length>4)throw new ApiError(400,'最多可提交四张输入图。');
  if(images.length){
    if(!profile.edit)throw new ApiError(400,'该接口设置为仅文生图。');
    body=new FormData();
    for(const [name,value] of Object.entries(fields))body.set(name,value);
    const imageField=profile.imageField==='image'?'image':'image[]';
    for(const [index,image] of images.entries()){
      const {bytes,type}=dataImage(image);
      body.append(imageField,new Blob([bytes],{type}),'reference'+(images.length>1?'-'+(index+1):'')+'.'+type.split('/')[1]);
    }
    route='/images/edits';
  }
  const response=await upstream(profile,key,route,signal,body);
  const payload=await readBytes(response.body,Math.ceil(imageLimit/3)*4+65536);
  let first;
  try{ first=JSON.parse(payload.toString()).data?.[0]; }catch{}
  const bytes=first?.b64_json?decodeBase64(first.b64_json,imageLimit,502):
    first?.url?await downloadImage(first.url,signal):null;
  const type=bytes&&imageType(bytes);
  if(!type)throw new ApiError(502,'接口没有返回可读取的图片，请检查是否支持兼容的图片接口。');
  return {bytes,type};
}

function dataImage(value){
  const match=typeof value==='string'&&/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if(!match)throw new ApiError(400,'图片格式无效。');
  const bytes=decodeBase64(match[1],8*1024*1024,400);
  return {bytes,type:imageType(bytes)};
}

function createImageServer({profileFile,profilesFile,env={},runningHubOrigin,runningHubPollMs}={}){
  const profiles=createImageProfiles({file:profilesFile,ApiError,publicProfile,keyValue});
  const concept=createConceptApi({ApiError,readBytes,safeBase,upstream});
  const hub=createRunningHub({ApiError,decodeImage:dataImage,env,origin:runningHubOrigin,pollMs:runningHubPollMs,
    downloadImage:async(url,signal)=>{
      const bytes=runningHubOrigin&&url.startsWith(runningHubOrigin)
        ?Buffer.from(await (await fetch(url,{signal})).arrayBuffer()):await downloadImage(url,signal);
      const type=imageType(bytes);
      if(!type)throw new ApiError(502,'RunningHub 返回的结果不是 PNG、JPEG 或 WebP 图片。');
      return {bytes,type};
    }});
  let hubRunning=false;
  let profile={baseUrl:'',model:'',size:'',edit:true,imageField:'image[]'};
  let key='',revision=randomUUID(),running=false;
  try{ if(profileFile)profile=publicProfile(JSON.parse(readFileSync(profileFile,'utf8'))); }catch{}
  if(env.WUYING_IMAGE_API_BASE){
    try{
      const baseUrl=safeBase(env.WUYING_IMAGE_API_BASE);
      if(!profile.baseUrl)profile={...profile,baseUrl,model:env.WUYING_IMAGE_API_MODEL||''};
      if(profile.baseUrl===baseUrl)key=String(env.WUYING_IMAGE_API_KEY||'').trim();
    }catch{}
  }
  const state=()=>({...profile,ready:!!(key&&profile.model&&profile.baseUrl),hasKey:!!key,revision});
  const describeDefault=()=>({id:'default',name:'原有图片接口',...state()});
  function saveDefault(data){
    const next=publicProfile(data),entered=keyValue(data.key);
    if(profileFile){
      mkdirSync(dirname(profileFile),{recursive:true});
      writeFileSync(profileFile+'.tmp',JSON.stringify(next,null,2));
      renameSync(profileFile+'.tmp',profileFile);
    }
    key=data.clearKey===true?'':entered||(next.baseUrl===profile.baseUrl?key:'');
    profile=next;
    revision=randomUUID();
    return state();
  }
  const json=(res,status,body)=>{
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(body));
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const actual=server.address().port;
    const hosts=['127.0.0.1:'+actual,'localhost:'+actual];
    if(!hosts.includes(req.headers.host))return json(res,403,{error:'出图后台仅允许本机访问。'});
    const origin=req.headers.origin;
    const allowed=hosts.some(host=>'http://'+host===origin)||previewOrigins.has(origin);
    if(origin&&!allowed||req.method==='POST'&&!allowed)return json(res,403,{error:'当前页面来源无法访问出图后台。'});
    if(allowed){
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
      res.setHeader('Vary','Origin');
    }
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const route=req.url;
    const abort=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)abort.abort();});
    try{
      if(req.method==='GET'&&(route==='/'||route==='/admin')){
        res.writeHead(302,{Location:'/admin/'});res.end();return;
      }
      if(req.method==='GET'&&Object.hasOwn(assets,route)){
        const [name,type]=assets[route];
        res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.setHeader('Content-Type',type);
        res.end(readFileSync(join(__dirname,'admin',name)));
        return;
      }
      if(req.method==='GET'&&route==='/api/config')return json(res,200,state());
      if(req.method==='GET'&&route==='/api/concept/config')return json(res,200,concept.config());
      if(req.method==='GET'&&route==='/api/runninghub/config')return json(res,200,hub.config());
      if(req.method==='GET'&&route==='/api/image-profiles'){
        const list=profiles.list();
        if(profile.baseUrl) list.unshift(describeDefault());
        return json(res,200,{profiles:list});
      }
      const profileRoutes=['/api/image-profiles','/api/image-profiles/test','/api/image-profiles/render'];
      const videoRoute=['/api/runninghub/video/start','/api/runninghub/video/status','/api/runninghub/video/download'].includes(route);
      const hubRoutes=['/api/runninghub/config','/api/runninghub/test','/api/runninghub/render'];
      if(req.method!=='POST'||!videoRoute&&![...hubRoutes,...profileRoutes,'/api/config','/api/test','/api/render','/api/concept/config','/api/concept-suggestions'].includes(route))return json(res,404,{error:'接口不存在。'});
      const limit=route==='/api/runninghub/video/start'?30*1024*1024:route==='/api/image-profiles/render'?46*1024*1024:route==='/api/runninghub/render'?40*1024*1024:route==='/api/render'?12*1024*1024:16384;
      const data=await readJson(req,limit);
      if(videoRoute){
        const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(90000)]);
        if(route.endsWith('/start'))return json(res,200,await hub.startVideo(data,signal));
        const result=await hub.videoStatus(data.taskId,signal);
        if(route.endsWith('/status'))return json(res,200,{status:result.status});
        if(result.status!=='SUCCESS'||!result.url)throw new ApiError(409,'视频仍在生成，请稍后查询。');
        const limit=96*1024*1024;
        let bytes;
        if(runningHubOrigin&&new URL(result.url).origin===new URL(runningHubOrigin).origin){
          const response=await fetch(result.url,{signal,redirect:'error'});
          if(!response.ok)throw new ApiError(502,'视频下载失败。');
          bytes=await readBytes(response.body,limit);
        }else bytes=await downloadImage(result.url,signal,limit);
        const type=bytes.toString('ascii',4,8)==='ftyp'?'video/mp4':
          bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?'video/webm':'';
        if(!type)throw new ApiError(502,'RunningHub 返回的内容不是 MP4 或 WebM。');
        res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length});
        res.end(bytes);
        return;
      }
      if(route==='/api/runninghub/config')return json(res,200,hub.update(data));
      if(route==='/api/runninghub/test')return json(res,200,await hub.test(AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])));
      if(route==='/api/runninghub/render'){
        if(hubRunning)throw new ApiError(429,'RunningHub 已有一个任务在运行，请等它完成。');
        hubRunning=true;
        try{
          const result=await hub.render(data,AbortSignal.any([abort.signal,AbortSignal.timeout(190000)]));
          res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length});
          res.end(result.bytes);
        }finally{hubRunning=false;}
        return;
      }
      if(route==='/api/concept/config')return json(res,200,concept.update(data));
      if(route==='/api/concept-suggestions'){
        const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]);
        return json(res,200,await concept.suggest(data,signal));
      }
      if(route==='/api/config')return json(res,200,saveDefault(data));
      if(route==='/api/image-profiles'){
        if(data.id==='default'){
          saveDefault(data);
          return json(res,200,describeDefault());
        }
        return json(res,200,profiles.save(data));
      }
      const named=route.startsWith('/api/image-profiles/');
      const selected=named&&data.id!=='default'?profiles.get(data.id):{...profile,key,revision};
      if(!selected)throw new ApiError(404,'未找到该出图接口，请重新选择。');
      const testing=route.endsWith('/test');
      if(!testing&&data.revision!==selected.revision)throw new ApiError(409,'接口配置已更新，请重新生成。');
      if(!selected.key||!selected.model||!selected.baseUrl)throw new ApiError(400,'请先在后台管理填写该接口的地址、模型和密钥。');
      if(testing){
        const response=await upstream(selected,selected.key,'/models',AbortSignal.any([abort.signal,AbortSignal.timeout(12000)]));
        await response.body?.cancel();
        return json(res,200,{ok:true});
      }
      if(running)throw new ApiError(429,'出图后台已有一个任务正在运行。');
      running=true;
      try{
        const result=await render(selected,selected.key,data,AbortSignal.any([abort.signal,AbortSignal.timeout(115000)]));
        res.writeHead(200,{'Content-Type':result.type,'Content-Length':result.bytes.length});
        res.end(result.bytes);
      }finally{running=false;}
    }catch(error){
      if(res.destroyed)return;
      if(error instanceof ApiError)return json(res,error.status,{error:error.message});
      const timeout=error.name==='TimeoutError'||error.name==='AbortError';
      return json(res,timeout?504:502,{error:timeout?'请求超时，请稍后再试。':'请求未完成，请检查服务地址、网络或后台配置文件。'});
    }
  });
  return server;
}

if(require.main===module){
  const storage=join(__dirname,'..','.wuying-local');
  const server=createImageServer({profileFile:join(storage,'image-api.json'),profilesFile:join(storage,'image-api-profiles.json'),env:process.env});
  server.on('error',error=>{console.error('出图后台启动失败 · '+error.code);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log('物映出图管理  http://127.0.0.1:'+port+'/admin/'));
}
module.exports={createImageServer};
