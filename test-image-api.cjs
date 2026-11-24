const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const {createImageServer}=require('./server/image-api.cjs');
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMt0AAAAASUVORK5CYII=';
async function start(server,t){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>server.close());
  return 'http://127.0.0.1:'+server.address().port;
}
test('local admin keeps credentials server-side and routes text and sketch requests to the selected API',async t=>{
  const seen=[];
  const upstream=await start(createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    seen.push({path:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:[{b64_json:pixel}]}));
  }),t);
  const base=await start(createImageServer(),t);
  const api=(path,body,origin='http://127.0.0.1:8881')=>fetch(base+'/api/'+path,body?{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)
  }:{headers:{Origin:origin}});
  const publicSettings={baseUrl:upstream+'/v1',model:'fake-image',edit:true,size:''};
  assert.equal((await api('config',{...publicSettings,key:'test-private'},'https://other.example')).status,403);
  const config=await (await api('config',{...publicSettings,key:'test-private'})).json();
  assert.equal(config.ready,true);
  assert.doesNotMatch(JSON.stringify(config),/test-private/);
  assert.equal((await api('test',{})).status,200);
  const text=await api('render',{prompt:'white box',revision:config.revision});
  assert.equal(text.status,200);
  assert.equal(text.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await text.arrayBuffer()),Buffer.from(pixel,'base64'));
  const edit=await api('render',{prompt:'shape',image:'data:image/png;base64,'+pixel,revision:config.revision});
  assert.equal(edit.status,200);
  await edit.arrayBuffer();
  assert.deepEqual(seen.map(r=>r.path),['/v1/models','/v1/images/generations','/v1/images/edits']);
  assert.ok(seen.every(r=>r.auth==='Bearer test-private'));
  assert.equal(JSON.parse(seen[1].body).model,'fake-image');
  assert.match(seen[2].body,/name="image\[\]"; filename="reference.png"/);
  const newConfig=await (await api('config',{...publicSettings,baseUrl:upstream+'/other'})).json();
  assert.equal(newConfig.ready,false);
  assert.equal((await api('render',{prompt:'old',revision:config.revision})).status,409);
  assert.equal(seen.length,3);
});

test('named image APIs keep separate credentials and render through the selected editable profile',async t=>{
  const seen=[];
  const upstream=await start(createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    seen.push({path:req.url,key:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    res.end(JSON.stringify({data:[{b64_json:pixel}]}));
  }),t);
  const base=await start(createImageServer(),t);
  const api=(action,body,origin='http://127.0.0.1:8881')=>fetch(base+'/api/image-profiles'+action,{
    method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined
  });
  const create=(name,key,edit)=>api('',{name,key,edit,model:name,baseUrl:upstream+'/v1'});
  const a=await (await create('Alpha','secret-alpha',true)).json();
  const b=await (await create('Beta','secret-beta',false)).json();
  assert.ok(a.id&&b.id&&a.id!==b.id);
  const list=await (await api('')).json();
  assert.deepEqual(list.profiles.map(p=>p.name),['Alpha','Beta']);
  assert.doesNotMatch(JSON.stringify(list),/secret-/);
  assert.equal((await api('/test',{id:a.id})).status,200);
  const png='data:image/png;base64,'+pixel;
  const out=await api('/render',{id:a.id,revision:a.revision,prompt:'keep shape',images:[png,png]});
  assert.equal(out.status,200);
  await out.arrayBuffer();
  assert.equal(seen[1].key,'Bearer secret-alpha');
  assert.equal((seen[1].body.match(/name="image\[\]"/g)||[]).length,2);
  const text=await api('/render',{id:b.id,revision:b.revision,prompt:'a desk lamp'});
  assert.equal(text.status,200);
  await text.arrayBuffer();
  assert.equal(seen[2].key,'Bearer secret-beta');
  assert.equal((await api('/render',{id:a.id,revision:'stale',prompt:'x',images:[png]})).status,409);
  assert.equal((await api('/test',{id:a.id},'https://foreign.example')).status,403);
  const moved=await (await api('',{...a,baseUrl:upstream+'/new',key:''})).json();
  assert.equal(moved.ready,false);
});

test('named interface metadata survives restart while keys stay out of local files',async t=>{
  const {mkdtemp,readFile,rm,rmdir}=require('node:fs/promises');
  const {tmpdir}=require('node:os');
  const {join}=require('node:path');
  const dir=await mkdtemp(join(tmpdir(),'wuying-profiles-'));
  const file=join(dir,'profiles.json');
  t.after(async()=>{await rm(file,{force:true});await rm(file+'.tmp',{force:true});await rmdir(dir);});
  const settings={profilesFile:file};
  const base=await start(createImageServer(settings),t);
  const saved=await fetch(base+'/api/image-profiles',{method:'POST',headers:{Origin:'http://127.0.0.1:8881','Content-Type':'application/json'},
    body:JSON.stringify({name:'Disk',key:'not-in-file',edit:true,baseUrl:'https://example.test/v1',model:'test-model'})});
  assert.equal(saved.status,200);
  assert.doesNotMatch(await readFile(file,'utf8'),/not-in-file/);
  const restarted=await start(createImageServer(settings),t);
  const list=await (await fetch(restarted+'/api/image-profiles')).json();
  assert.equal(list.profiles[0].name,'Disk');
  assert.equal(list.profiles[0].ready,false);
});


test('apilio.ai preset uses OpenAI image field, accepts address and survives restart',async t=>{
  const {mkdtemp,readFile,rm,rmdir}=require('node:fs/promises');
  const {tmpdir}=require('node:os');
  const {join}=require('node:path');
  const seen=[];
  const upstream=await start(createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    seen.push({path:req.url,key:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:[{b64_json:pixel}]}));
  }),t);
  const dir=await mkdtemp(join(tmpdir(),'wuying-apilio-'));
  const file=join(dir,'profiles.json');
  t.after(async()=>{await rm(file,{force:true});await rm(file+'.tmp',{force:true});await rmdir(dir);});
  const base=await start(createImageServer({profilesFile:file}),t);
  const api=(action,body)=>fetch(base+'/api/image-profiles'+action,{method:body?'POST':'GET',
    headers:{Origin:'http://127.0.0.1:8881','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const saved=await (await api('',{name:'apilio.ai',key:'sk-test-key',edit:true,
    baseUrl:upstream+'/v1',model:'gpt-image-1',imageField:'image',size:''})).json();
  assert.equal(saved.imageField,'image');
  assert.equal(saved.ready,true);
  // 重启后元数据（含字段格式）仍在，密钥不落盘。
  assert.match(await readFile(file,'utf8'),/"imageField": "image"/);
  assert.doesNotMatch(await readFile(file,'utf8'),/sk-test-key/);
  const restarted=await start(createImageServer({profilesFile:file}),t);
  const kept=await (await fetch(restarted+'/api/image-profiles')).json();
  assert.equal(kept.profiles[0].imageField,'image');
  assert.equal(kept.profiles[0].ready,false);
  // 重启后密钥不落盘，发图用仍持有密钥的原实例；字段名必须是 OpenAI 官方的 image。
  const list=await (await fetch(base+'/api/image-profiles')).json();
  const out=await fetch(base+'/api/image-profiles/render',{method:'POST',
    headers:{Origin:'http://127.0.0.1:8881','Content-Type':'application/json'},
    body:JSON.stringify({id:list.profiles[0].id,revision:list.profiles[0].revision,
      prompt:'a product',image:'data:image/png;base64,'+pixel})});
  assert.equal(out.status,200);
  await out.arrayBuffer();
  assert.equal(seen.at(-1).path,'/v1/images/edits');
  assert.match(seen.at(-1).body,/name="image"; filename="reference\.png"/);
  assert.doesNotMatch(seen.at(-1).body,/name="image\[\]"/);
  assert.equal(seen.at(-1).key,'Bearer sk-test-key');
});

test('connection test reports the provider message, the key tail and checks the model id',async t=>{
  const models=await start(createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'gpt-image-1'},{id:'gemini-nano-banana-2.1-2k'}]}));
    res.statusCode=404;res.end(JSON.stringify({error:{message:'no such route'}}));
  }),t);
  const denied=await start(createServer((req,res)=>{
    res.statusCode=401;res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({error:{code:'invalid_request',message:'Invalid token (request id: MA20261123095037)'}}));
  }),t);
  const base=await start(createImageServer(),t);
  const call=(action,body)=>fetch(base+'/api/image-profiles'+action,{method:body?'POST':'GET',
    headers:{Origin:'http://127.0.0.1:8881','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const profile=await (await call('',{name:'apilio.ai',key:'sk-good-key-1234',edit:true,
    baseUrl:models+'/v1',model:'gemini-nano-banana-2.1-2k',imageField:'image'})).json();
  const ok=await (await call('/test',{id:profile.id})).json();
  assert.equal(ok.checked,true);
  assert.equal(ok.modelMissing,false);
  assert.match(ok.message,/可用/);
  const wrong=await (await call('',{...profile,key:'',model:'nano-banana-x'})).json();
  const missing=await (await call('/test',{id:wrong.id})).json();
  assert.equal(missing.modelMissing,true);
  assert.match(missing.message,/gpt-image-1/);
  const deniedProfile=await (await call('',{name:'denied',key:'sk-bad-key-9999',edit:true,
    baseUrl:denied+'/v1',model:'gemini-nano-banana-2.1-2k'})).json();
  const logs=[],original=console.error;
  console.error=(...args)=>logs.push(args.join(' '));
  let bad;
  try{ bad=await call('/test',{id:deniedProfile.id}); }
  finally{ console.error=original; }
  assert.equal(bad.status,502);
  const text=(await bad.json()).error;
  assert.match(text,/HTTP 401/);
  // 只给归类后的诊断和自家密钥尾号，服务商原文留在服务端日志里。
  assert.match(text,/拒绝了该密钥/);
  assert.match(text,/…9999/);
  assert.doesNotMatch(text,/Invalid token/);
  assert.doesNotMatch(text,/MA2026/);
  assert.match(logs.join('\n'),/Invalid token/);
  const plain=await (await call('',{name:'plain',key:'sk-plain-7777',edit:true,
    baseUrl:models+'/plain/v1',model:'whatever'})).json();
  const degraded=await (await call('/test',{id:plain.id})).json();
  assert.equal(degraded.checked,false);
  assert.match(degraded.message,/连接成功/);
});
