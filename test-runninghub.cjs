const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const {createImageServer}=require('./server/image-api.cjs');
const {presets}=require('./server/runninghub.cjs');
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMt0AAAAASUVORK5CYII=';
const source='data:image/png;base64,'+pixel;

async function start(server,t){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  return 'http://127.0.0.1:'+server.address().port;
}

// 假的 RunningHub：上传 → 提交 → 两次轮询（RUNNING、SUCCESS）→ 下载。
function fakeHub(behaviour={}){
  const seen=[];let polls=0,origin='';
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const raw=Buffer.concat(chunks);
    const body=req.headers['content-type']?.startsWith('application/json')?JSON.parse(raw.toString()||'{}'):null;
    seen.push({path:req.url,auth:req.headers.authorization,body,raw});
    const send=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if(req.url==='/uc/openapi/accountStatus')return send({code:0,msg:'success',data:{remainCoins:'120',remainMoney:'8.5',currentTaskCounts:'0'}});
    if(req.url==='/openapi/v2/media/upload/binary')return send({code:0,data:{download_url:origin+'/files/in.png',fileName:'api/in.png'}});
    if(req.url==='/files/out.png'){res.setHeader('Content-Type','image/png');return res.end(Buffer.from(pixel,'base64'));}
    if(req.url==='/files/product.mp4')return res.end(Buffer.from('00000018667479706d70343200000000','hex'));
    if(req.url==='/openapi/v2/query'){
      if(behaviour.video)return send({taskId:'t-video',status:'SUCCESS',results:[{url:origin+'/files/product.mp4',outputType:'mp4'}]});
      polls++;
      if(behaviour.failWith)return send({taskId:'t1',status:'FAILED',errorCode:behaviour.failWith,errorMessage:'x'});
      return send(polls<2?{taskId:'t1',status:'RUNNING'}:{taskId:'t1',status:'SUCCESS',results:[{url:origin+'/files/out.png',outputType:'png'}]});
    }
    if(behaviour.video&&req.url.includes('kling-v3-turbo-std'))return send({taskId:'t-video',status:'QUEUED'});
    if(behaviour.rejectKey)return send({errorCode:'1014',errorMessage:'key type'});
    if(behaviour.rejectBalance)return send({errorCode:'605',errorMessage:'您的账户余额不足，请充值'});
    return send({taskId:'t1',status:'QUEUED',errorCode:'',errorMessage:''});
  });
  return {server,seen,setOrigin:o=>{origin=o;}};
}

async function setup(t,behaviour){
  const hub=fakeHub(behaviour);
  const upstream=await start(hub.server,t);
  hub.setOrigin(upstream);
  const base=await start(createImageServer({runningHubOrigin:upstream,runningHubPollMs:5}),t);
  const api=(path,body,origin='http://127.0.0.1:8881')=>fetch(base+'/api/runninghub/'+path,body?{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)
  }:{headers:{Origin:origin}});
  return {hub,api,upstream};
}

test('RunningHub key stays in the backend and foreign origins are refused',async t=>{
  const {api}=await setup(t);
  assert.equal((await api('config',{key:'rh-secret'},'https://evil.example')).status,403);
  const before=await (await api('config')).json();
  assert.equal(before.ready,false);
  assert.equal((await api('render',{model:'omni-v2',prompt:'a moss green speaker',images:[source],aspect:1})).status,400);
  const saved=await (await api('config',{key:'rh-secret'})).json();
  assert.equal(saved.ready,true);
  assert.doesNotMatch(JSON.stringify(saved),/rh-secret/);
  assert.deepEqual(saved.models.map(m=>m.id),Object.keys(presets));
  const info=await (await api('test',{})).json();
  assert.equal(info.remainMoney,'8.5');
  const cleared=await (await api('config',{clearKey:true})).json();
  assert.equal(cleared.hasKey,false);
});

test('render uploads the sketch, submits, polls until SUCCESS and returns the image',async t=>{
  const {hub,api}=await setup(t);
  await api('config',{key:'rh-secret'});
  const res=await api('render',{model:'qwen-image-2.0-edit',prompt:'把草图渲染成哑光苔绿色便携音箱',images:[source],aspect:1.5});
  assert.equal(res.status,200);
  assert.equal(res.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(pixel,'base64'));
  const paths=hub.seen.map(r=>r.path);
  assert.deepEqual(paths,['/openapi/v2/media/upload/binary',presets['qwen-image-2.0-edit'].path,'/openapi/v2/query','/openapi/v2/query','/files/out.png']);
  assert.ok(hub.seen.slice(0,4).every(r=>r.auth==='Bearer rh-secret'));
  assert.match(hub.seen[0].raw.toString('latin1'),/name="file"; filename="wuying.png"/);
  const submit=hub.seen[1].body;
  assert.equal(submit.size,'1536*1024');
  assert.equal(submit.imageUrls.length,1);
  assert.deepEqual(hub.seen[2].body,{taskId:'t1'});
});

test('preset bodies pick the nearest supported ratio',()=>{
  const urls=['https://x/a.png'];
  assert.equal(presets['omni-v2'].body({prompt:'p',urls,aspect:16/9}).aspectRatio,'16:9');
  assert.equal(presets['omni-g2'].body({prompt:'p',urls,aspect:0.5}).aspectRatio,'1:2');
  const seed=presets['seedream-v4.5'].body({prompt:'p',urls,aspect:0.75});
  assert.equal(seed.height,2048);
  assert.equal(seed.width,1536);
});

test('Pro mode and resolution reach the G-2 request; bad values are refused',async t=>{
  const {hub,api}=await setup(t);
  await api('config',{key:'rh-secret'});
  const res=await api('render',{model:'omni-g2',prompt:'a moss green speaker',images:[source,source,source,source],aspect:1,mode:'pro',resolution:'2k'});
  assert.equal(res.status,200);
  const submit=hub.seen.find(r=>r.path===presets['omni-g2'].path).body;
  assert.equal(submit.quality,'high');
  assert.equal(submit.resolution,'2k');
  assert.equal(submit.imageUrls.length,4);
  assert.equal((await api('render',{model:'omni-g2',prompt:'a moss green speaker',images:[source],aspect:1,resolution:'8k'})).status,400);
  assert.equal((await api('render',{model:'omni-g2',prompt:'a moss green speaker',images:[source],aspect:1,mode:'turbo'})).status,400);
  assert.equal(presets['omni-g2'].body({prompt:'p',urls:[],aspect:1,resolution:'1k',mode:'standard'}).quality,'medium');
  assert.equal(presets['seedream-v4.5'].body({prompt:'p',urls:[],aspect:1,resolution:'4k'}).width,4096);
});

test('RunningHub error codes become readable Chinese messages',async t=>{
  const failed=await setup(t,{failWith:'1501'});
  await failed.api('config',{key:'rh-secret'});
  const res=await failed.api('render',{model:'omni-v2',prompt:'a moss green speaker',images:[source],aspect:1});
  assert.equal(res.status,502);
  assert.match((await res.json()).error,/内容审核.*1501/);

  const wrongKey=await setup(t,{rejectKey:true});
  await wrongKey.api('config',{key:'member-key'});
  const denied=await wrongKey.api('render',{model:'omni-g2',prompt:'a moss green speaker',images:[source],aspect:1});
  assert.match((await denied.json()).error,/企业级-共享.*1014/);

  const bad=await wrongKey.api('render',{model:'nope',prompt:'a moss green speaker',images:[source],aspect:1});
  assert.equal(bad.status,400);

  const noBalance=await setup(t,{rejectBalance:true});
  await noBalance.api('config',{key:'rh-secret'});
  const poor=await noBalance.api('render',{model:'omni-v2',prompt:'a moss green speaker',images:[source],aspect:1});
  assert.equal(poor.status,502);
  assert.match((await poor.json()).error,/余额不足.*605/);
});

test('Seedream V5 Pro stable submits the official image edit request and returns a PNG',async t=>{
  const {hub,api,upstream}=await setup(t);
  const config=await (await api('config',{key:'rh-secret'})).json();
  assert.ok(config.models.some(({id,label})=>id==='seedream-v5-pro'&&label.includes('稳定版')));
  const prompt='Revise the lamp shade with a white matte finish.';
  const res=await api('render',{model:'seedream-v5-pro',prompt,images:[source,source],aspect:.75,mode:'pro',resolution:'4k'});
  assert.equal(res.status,200);
  assert.equal(res.headers.get('content-type'),'image/png');
  await res.arrayBuffer();
  const submit=hub.seen.find(item=>item.path==='/openapi/v2/seedream-v5-pro/image-to-image');
  assert.deepEqual(submit.body,{imageUrls:[upstream+'/files/in.png',upstream+'/files/in.png'],
    prompt,width:1536,height:2048,resolution:'2k',outputFormat:'png'});
  const wide=presets['seedream-v5-pro'].body({prompt,urls:[],aspect:4});
  assert.deepEqual([wide.width,wide.height],[2048,1024]);
});

test('video submit uses only supported model inputs, and the same task id downloads an MP4',async t=>{
  const {api,hub}=await setup(t,{video:true});
  await api('config',{key:'local-video-test-key'});
  const prompt='绕台灯移动镜头，保持底座和灯罩的比例';
  const start=await api('video/start',{mode:'image',first:source,prompt,duration:5});
  assert.equal(start.status,200);
  assert.deepEqual(await start.json(),{taskId:'t-video',status:'QUEUED'});
  const submit=hub.seen.find(item=>item.path.endsWith('image-to-video'));
  assert.equal(submit.body.duration,'5');
  assert.match(submit.body.firstImageUrl,/\/files\/in.png$/);
  assert.equal((await api('video/status',{taskId:'t-video'})).status,200);
  const result=await api('video/download',{taskId:'t-video'});
  assert.equal(result.status,200);
  assert.equal(result.headers.get('content-type'),'video/mp4');
  const text=await api('video/start',{mode:'text',prompt,duration:5,aspect:'9:16'});
  assert.equal(text.status,200);
  const textSubmit=hub.seen.find(item=>item.path.endsWith('text-to-video'));
  assert.equal(textSubmit.body.aspectRatio,'9:16');
  assert.equal(textSubmit.body.firstImageUrl,undefined);
});