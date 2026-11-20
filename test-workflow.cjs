const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function load(source){
  const calls=[];
  const window={
    WuyingImageSelection:{enough:points=>points.length>=3},
    WuyingWorkspaceComposite:{toPng:async()=>{if(source)return source;throw new Error('重跑不应读取当前图层');}},
    WuyingComfy:{runImageTool:async options=>{calls.push({...options,tool:true});return {blob:new Blob(['png'],{type:'image/png'})};}},
    WuyingWorkspaceRender:{generate:async options=>{calls.push(options);return new Blob(['png']);}}
  };
  const context=vm.createContext({window,crypto,localStorage:{getItem:()=>null,setItem(){}},
    Blob,Uint32Array,createImageBitmap:async()=>({width:64,height:48,close(){}})});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-workflow.js','utf8'),context);
  return {flow:window.WuyingWorkflow,calls,window};
}

function memoryStore(doc,blobs){
  const added=[];
  return {added,
    read:async()=>structuredClone(doc),
    getBlob:async id=>blobs.get(id)||null,
    change:async(mutate,images=[])=>{mutate(doc);for(const item of images){added.push(item.id);blobs.set(item.id,item.blob);}return structuredClone(doc);}
  };
}

const id=()=>crypto.randomUUID();

test('native image tools reuse the source snapshot and create transparent cutout cards',async()=>{
  const input=new Blob(['source'],{type:'image/png'});
  const {flow,calls}=load(input);
  const source=id(),block=id(),doc={assets:{[source]:{id:source,name:'Lamp',x:10,y:10,width:640,height:480,layers:[{blobId:id()}]}},blocks:{[block]:{x:330,y:10}},jobs:{}};
  const store=memoryStore(doc,new Map());
  const p={provider:'runninghub',cloudModel:'omni-v2'};
  const request={kind:'cutout',inputs:[source],blockId:block,quantity:8,toolEndpoint:'http://localhost:8188',...p};
  assert.equal(flow.runSummary(request,doc.assets[source],p).cloud,false);
  const job=await flow.run(store,request);
  assert.equal(job.settings.provider,undefined);
  assert.equal(job.outputs.length,1);
  assert.equal(doc.assets[job.outputs[0].id].transparent,true);
  assert.equal(calls[0].tool,true);
  assert.equal(flow.outputSize({width:3000,height:1500},{kind:'upscale'}).width,4096);
  doc.assets[source].width=940;
  const replay=await flow.run(store,{rerunOf:job.id,...p});
  assert.equal(replay.inputBlobId,job.inputBlobId);
  assert.equal(replay.settings.width,640);
});


test('new instant render jobs generate each requested stage and save the instructions without old style overrides', async()=>{
  const {flow,calls}=load(new Blob(['source']));
  const main=id(), layer=id();
  const doc={assets:{[main]:{id:main,name:'草稿',width:64,height:48,layers:[{id:layer,blobId:id(),visible:true}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  for(const fidelity of ['line','color','shaded','realistic']){
    const job=await flow.run(store,{kind:'instant',inputs:[main],provider:'runninghub',fidelity,prompt:'旧提示',style:'photo',mode:'pro',aspect:'1:1',resolution:'4k'});
    assert.equal(job.prompt,'');
    assert.equal(job.settings.fidelity,fidelity);
    assert.equal(job.settings.targetFidelity,fidelity);
    assert.equal(job.settings.style,'none');
    assert.equal(job.settings.mode,'standard');
    assert.equal(job.settings.resolution,'match');
    assert.equal(calls.at(-1).prompt,flow.fidelityStages[fidelity].prompt);
    assert.equal(job.settings.renderPrompt,calls.at(-1).prompt);
    assert.deepEqual({...calls.at(-1).size},{width:64,height:48});
  }
});

test('instant render uses a saved target stage without a prompt and keeps snapshot dimensions on rerun', async()=>{
  const {flow,calls}=load();
  const source=id(), prior=id(), input=id();
  const doc={assets:{[source]:{id:source,name:'当前已改尺寸',width:640,height:480,layers:[]}},blocks:{},
    jobs:{[prior]:{id:prior,kind:'instant',sourceId:source,inputBlobId:input,prompt:'',selection:[],references:[],
      outputs:[],settings:{fidelity:'auto',targetFidelity:'color',width:64,height:48,quantity:1}}}};
  const store=memoryStore(doc,new Map([[input,new Blob(['frozen'])]]));
  const job=await flow.run(store,{rerunOf:prior,endpoint:'local',checkpoint:'model'});
  assert.equal(calls[0].kind,'instant');
  assert.match(calls[0].prompt,/flat color/i);
  assert.doesNotMatch(calls[0].prompt,/photoreal/i);
  assert.deepEqual({...calls[0].size},{width:64,height:48});
  assert.equal(job.settings.targetFidelity,'color');
  assert.equal(job.settings.fidelity,'auto');
});

test('instant render resolves automatic progress from the visible result and rejects extra references', async()=>{
  const {flow}=load();
  const source=id(), output=id(), ref=id(), other=id(), job=id(), blob=id();
  const doc={assets:{
    [source]:{id:source,name:'草图',width:64,height:48,layers:[{blobId:blob,visible:true}]},
    [output]:{id:output,jobId:job,name:'色块稿',width:64,height:48,layers:[{blobId:blob,visible:true}]},
    [ref]:{id:ref,layers:[]},[other]:{id:other,layers:[]}
  },blocks:{},jobs:{[job]:{id:job,kind:'instant',settings:{targetFidelity:'color'},outputs:[{id:output,blobId:blob}]}}};
  assert.equal(flow.resolveFidelity(doc,doc.assets[output],'auto'),'shaded');
  assert.equal(flow.resolveFidelity(doc,doc.assets[source],'auto'),'shaded');
  assert.equal(flow.resolveFidelity(doc,{layers:[{kind:'ink',strokes:[{}]}]},'auto'),'color');
  assert.equal(flow.resolveFidelity(doc,doc.assets[output],'line'),'line');
  const request=flow.blockRequest({id:'block',kind:'instant',inputs:[output],fidelity:'shaded',quantity:2});
  assert.equal(request.fidelity,'shaded');
  const summary=flow.runSummary({kind:'instant',inputs:[output],fidelity:'line',aspect:'1:1',resolution:'4k'},doc.assets[output],{checkpoint:'model'});
  assert.deepEqual({...summary.size},{width:64,height:48});
  await assert.rejects(flow.run(memoryStore(doc,new Map()),{kind:'instant',inputs:[ref,other,source],provider:'runninghub'}),/一张参考/);
  await assert.rejects(flow.run(memoryStore(doc,new Map()),{kind:'instant',inputs:[ref,source],roles:{[ref]:'material'},provider:'runninghub'}),/风格或配色/);
});

test('instant render cloud instructions preserve the requested finish instead of forcing a realistic render', ()=>{
  const w={};
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),vm.createContext({window:w}));
  const text=w.WuyingWorkspaceRender.cloudPrompt('instant','Clean line art only; no shading.',[],false);
  assert.match(text,/no shading/);
  assert.match(text,/preserve the source silhouette/i);
  assert.doesNotMatch(text,/realistic product rendering/i);
});

test('a studio candidate can be promoted to the board once, linked to its job', ()=>{
  const {flow}=load();
  const source=id(), job=id(), output=id();
  const doc={assets:{[source]:{id:source,name:'草图',x:100,y:100,width:64,height:48,layers:[]}},blocks:{},
    jobs:{[job]:{id:job,kind:'modify',sourceId:source,outputs:[{id:output,blobId:id(),name:'修改 1',width:64,height:48}]}}};
  assert.equal(flow.promoteOutput(doc,job,output),output);
  const card=doc.assets[output];
  assert.equal(card.jobId,job);
  assert.equal(card.layers[0].blobId,doc.jobs[job].outputs[0].blobId);
  assert.ok(card.x>doc.assets[source].x);
  const count=Object.keys(doc.assets).length;
  flow.promoteOutput(doc,job,output);
  assert.equal(Object.keys(doc.assets).length,count);
  assert.throws(()=>flow.promoteOutput(doc,job,id()),/找不到/);
});

test('rerun reads the frozen input and selection, not the current layers', async()=>{
  const {flow,calls}=load();
  const source=id(), job=id(), input=id();
  const selection=[{x:.1,y:.1},{x:.5,y:.1},{x:.3,y:.6}];
  const doc={assets:{[source]:{id:source,name:'草图',x:0,y:0,width:64,height:48,layers:[]}},blocks:{},
    jobs:{[job]:{id:job,kind:'modify',sourceId:source,inputBlobId:input,prompt:'换成拉丝铝',selection,references:[],
      outputs:[],settings:{strength:.4,quantity:1,seed:7}}}};
  const frozen=new Blob(['frozen']);
  const store=memoryStore(doc,new Map([[input,frozen]]));
  const result=await flow.run(store,{rerunOf:job,endpoint:'http://127.0.0.1:8189',checkpoint:'sd15',quantity:1});
  assert.equal(calls[0].source,frozen);
  assert.equal(JSON.stringify(calls[0].selection),JSON.stringify(selection));
  assert.equal(calls[0].prompt,'换成拉丝铝');
  assert.equal(result.rerunOf,job);
  assert.equal(result.inputBlobId,input);
  assert.equal(result.outputs.length,1);
  assert.equal(JSON.stringify(store.added),JSON.stringify([result.outputs[0].blobId]));
});

test('legacy sourceId + references blocks migrate to inputs with the source last', ()=>{
  const {flow}=load();
  const a=id(),b=id(),src=id();
  const block=flow.migrateBlock({id:'k',kind:'modify',x:0,y:0,sourceId:src,references:[{id:a,role:'color'},{id:b,role:'bogus'}],prompt:'p',quantity:2,strength:.5});
  assert.equal(JSON.stringify(block.inputs),JSON.stringify([a,b,src]));
  assert.equal(JSON.stringify(block.roles),JSON.stringify({[a]:'color'}));
  assert.equal(block.sourceId,undefined);
  assert.equal(block.references,undefined);
  assert.equal(block.mode,'standard');
  assert.equal(block.quantity,2);
  assert.equal(flow.migrateBlock(block),block);
  const empty=flow.migrateBlock({id:'e',kind:'render',sourceId:null,references:[]});
  assert.equal(empty.inputs.length,0);
});

test('output size follows aspect ratio and resolution tier', ()=>{
  const {flow}=load();
  const src={width:1200,height:800};
  assert.equal(JSON.stringify(flow.outputSize(src,{aspect:'original',resolution:'match'})),JSON.stringify({width:1200,height:800}));
  assert.equal(JSON.stringify(flow.outputSize(src,{aspect:'1:1',resolution:'match'})),JSON.stringify({width:1200,height:1200}));
  assert.equal(JSON.stringify(flow.outputSize(src,{aspect:'16:9',resolution:'2k'})),JSON.stringify({width:2048,height:1152}));
  assert.equal(JSON.stringify(flow.outputSize(src,{aspect:'original',resolution:'1k'})),JSON.stringify({width:1024,height:683}));
  assert.equal(JSON.stringify(flow.outputSize(src,{aspect:'custom',customW:1,customH:4,resolution:'1k'})),JSON.stringify({width:256,height:1024}));
  assert.throws(()=>flow.outputSize(src,{aspect:'custom',customW:5,customH:1}),/4:1/);
});

test('block inputs run with the last image as the main image and others as references', async()=>{
  const {flow,calls}=load();
  const ink=[{id:'l',kind:'ink',strokes:[[1]],visible:true}];
  const ref=id(),main=id(),block=id();
  const doc={assets:{[ref]:{id:ref,name:'参考',x:0,y:0,width:64,height:48,layers:ink},[main]:{id:main,name:'主图',x:0,y:300,width:64,height:48,layers:ink}},
    blocks:{[block]:{id:block,kind:'modify',x:300,y:0,inputs:[ref,main]}},jobs:{}};
  const window={WuyingImageSelection:{enough:()=>true},
    WuyingWorkspaceComposite:{toPng:async asset=>new Blob([asset.id])},
    WuyingWorkspaceRender:{generate:async options=>{calls.push(options);return new Blob(['png']);}}};
  const context=vm.createContext({window,crypto,localStorage:{getItem:()=>null,setItem(){}},
    Blob,Uint32Array,createImageBitmap:async()=>({width:64,height:48,close(){}})});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-workflow.js','utf8'),context);
  const live=window.WuyingWorkflow;
  const request=live.blockRequest({...doc.blocks[block],prompt:'把 @2 换成 @1 的颜色',mode:'pro',aspect:'1:1',resolution:'2k',roles:{[ref]:'color'}});
  const job=await live.run(memoryStore(doc,new Map()),{provider:'runninghub',cloudModel:'qwen-image-2.0-edit',...request});
  const call=calls.at(-1);
  assert.equal(await call.source.text(),main);
  assert.equal(call.references.length,1);
  assert.equal(call.references[0].id,ref);
  assert.equal(call.references[0].role,'color');
  assert.equal(call.cloudModel,'omni-g2');
  assert.equal(call.resolution,'2k');
  assert.equal(JSON.stringify(call.size),JSON.stringify({width:2048,height:2048}));
  assert.equal(job.sourceId,main);
  assert.equal(job.settings.mode,'pro');
  assert.equal(Object.values(doc.assets).filter(a=>a.jobId===job.id).length,1);
  await assert.rejects(live.run(memoryStore(doc,new Map()),{provider:'runninghub',kind:'modify',inputs:[ref,ref],prompt:'x'}),/重复/);
  await assert.rejects(live.run(memoryStore(doc,new Map()),{provider:'runninghub',kind:'modify',inputs:[1,2,3,4,5].map(String),prompt:'x'}),/四张/);
});

test('@ mentions map block slots to cloud image order (main image first)', ()=>{
  const w={};
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),vm.createContext({window:w}));
  const text=w.WuyingWorkspaceRender.cloudPrompt('modify','把 @3 换成 @1 的颜色，@2 的材质，@4 不存在',[{role:'color'},{role:'material'}],false);
  assert.match(text,/^把 image 1 换成 image 2 的颜色，image 3 的材质，@4 不存在/);
});

test('style presets append to the prompt and reach the renderer', async()=>{
  const {flow,calls}=load();
  assert.equal(flow.composePrompt('换成蓝色','none'),'换成蓝色');
  assert.match(flow.composePrompt('换成蓝色','clay'),/^换成蓝色\n风格：哑光白色黏土/);
  assert.match(flow.composePrompt('','keyshot'),/^风格：.*KeyShot/);
  assert.equal(flow.composePrompt('x','unknown'),'x');
  const ink=[{id:'l',kind:'ink',strokes:[[1]],visible:true}], main=id();
  const doc={assets:{[main]:{id:main,name:'主图',x:0,y:0,width:64,height:48,layers:ink}},blocks:{},jobs:{}};
  const window={WuyingImageSelection:{enough:()=>true},WuyingWorkspaceComposite:{toPng:async()=>new Blob(['a'])},
    WuyingWorkspaceRender:{generate:async options=>{calls.push(options);return new Blob(['png']);}}};
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-workflow.js','utf8'),vm.createContext({window,crypto,
    localStorage:{getItem:()=>null,setItem(){}},Blob,Uint32Array,createImageBitmap:async()=>({width:64,height:48,close(){}})}));
  const job=await window.WuyingWorkflow.run(memoryStore(doc,new Map()),{provider:'runninghub',kind:'modify',inputs:[main],prompt:'加圆角',style:'marker'});
  assert.match(calls.at(-1).prompt,/加圆角\n风格：工业设计马克笔/);
  assert.equal(job.prompt,'加圆角');
  assert.equal(job.settings.style,'marker');
});

test('run summary states model, count and size before a paid cloud run', ()=>{
  const {flow}=load();
  assert.equal(flow.resolveCloudModel('pro','qwen-image-2.0-edit',1),'omni-g2');
  assert.equal(flow.resolveCloudModel('standard','qwen-image-2.0-edit',4),'omni-v2');
  assert.equal(flow.resolveCloudModel('standard','seedream-v4.5',4),'seedream-v4.5');
  const s=flow.runSummary({id:'b',kind:'modify',inputs:['a'],quantity:2,aspect:'16:9',resolution:'1k'},{width:800,height:600},{provider:'runninghub',cloudModel:'qwen-image-2.0-edit'});
  assert.equal(s.cloud,true);assert.equal(s.count,2);
  assert.equal(s.text,'RunningHub · 千问 2.0 图像编辑 · 2 张 · 1024 × 576 · 按次计费');
  const local=flow.runSummary({id:'b',kind:'render',inputs:['a']},{width:800,height:600},{provider:'comfy',checkpoint:'sd15.safetensors'});
  assert.equal(local.cloud,false);assert.match(local.text,/ComfyUI · sd15.*800 × 600 · 本机出图/);
});

test('rerun without a saved snapshot is refused', async()=>{
  const {flow}=load();
  const source=id(), job=id();
  const doc={assets:{[source]:{id:source,name:'草图',layers:[]}},blocks:{},jobs:{[job]:{id:job,kind:'render',sourceId:source,outputs:[]}}};
  await assert.rejects(flow.run(memoryStore(doc,new Map()),{rerunOf:job,endpoint:'x',checkpoint:'y'}),/输入快照/);
});

test('form controls drive prompt and strength and freeze both for a replay', async()=>{
  const {flow,calls}=load(new Blob(['sketch']));
  const source=id(), block=id();
  const doc={assets:{[source]:{id:source,name:'sketch',width:320,height:240,layers:[{blobId:id()}]}},blocks:{[block]:{}},jobs:{}};
  const store=memoryStore(doc,new Map());
  const request=flow.blockRequest({id:block,kind:'form',inputs:[source],form:{preset:'expression',x:-25,y:90}});
  const job=await flow.run(store,{...request,provider:'runninghub'});
  assert.deepEqual({...job.settings.form},{preset:'expression',x:-25,y:90});
  assert.match(calls[0].prompt,/ornamented/);
  assert.match(calls[0].prompt,/organic/);
  assert.ok(calls[0].strength>.65);
  doc.assets[source].width=960;
  const replay=await flow.run(store,{kind:'form',rerunOf:job.id,form:{preset:'edges',x:100,y:-100},prompt:'ignore',provider:'runninghub'});
  assert.equal(calls[1].prompt,calls[0].prompt);
  assert.equal(calls[1].strength,calls[0].strength);
  assert.deepEqual({...calls[1].size},{width:320,height:240});
  assert.equal(replay.inputBlobId,job.inputBlobId);
});

test('palette-only workbench jobs use the same batch count in summary, execution and replay', async()=>{
  const {flow,calls}=load(new Blob(['input']));
  const source=id(), block=id();
  const doc={assets:{[source]:{id:source,name:'input',width:64,height:48,layers:[{blobId:id()}]}},blocks:{[block]:{}},jobs:{}};
  const store=memoryStore(doc,new Map());
  const node={id:block,kind:'color',inputs:[source],palette:['#AABBCC','#080808','#aabbcc'],quantity:8};
  assert.equal(flow.runSummary(node,doc.assets[source],{provider:'runninghub'}).count,8);
  const job=await flow.run(store,{...flow.blockRequest(node),provider:'runninghub'});
  assert.deepEqual(Array.from(job.settings.palette),['#aabbcc','#080808']);
  assert.match(calls[0].prompt,/#aabbcc.*#080808/);
  assert.equal(job.outputs.length,8);
  const replay=await flow.run(store,{rerunOf:job.id,palette:['#ff0000'],provider:'runninghub'});
  assert.equal(replay.outputs.length,8);
  assert.equal(calls[8].prompt,calls[0].prompt);
  assert.equal(flow.runSummary({...node,kind:'form',quantity:8},doc.assets[source],{checkpoint:'model'}).count,1);
});

test('old form jobs keep freeform settings, and a neutral direction still needs a prompt', async()=>{
  const {flow,calls}=load(new Blob(['input']));
  const source=id();
  const doc={assets:{[source]:{id:source,name:'input',width:64,height:48,layers:[{blobId:id()}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  await assert.rejects(flow.run(store,{kind:'form',sourceId:source,form:{preset:'expression',x:0,y:0},provider:'runninghub'}),/方向/);
  const job=await flow.run(store,{kind:'form',sourceId:source,prompt:'Lengthen the handle.',strength:.51,provider:'runninghub'});
  assert.equal(job.settings.form,undefined);
  assert.equal(calls[0].strength,.51);
  assert.equal(calls[0].prompt,'Lengthen the handle.');
});


test('defined views render once per unique angle and label outputs in selection order', async()=>{
  const {flow,calls}=load(new Blob(['source']));
  const source=id(), block=id();
  const doc={assets:{[source]:{id:source,name:'sketch',width:320,height:240,layers:[{blobId:id()}]}},blocks:{[block]:{x:400,y:60}},jobs:{}};
  const store=memoryStore(doc,new Map());
  const node={id:block,kind:'view',inputs:[source],views:['rear','front-right','rear','missing','top'],quantity:4,prompt:'Keep the orange trim.'};
  const req=flow.blockRequest(node);
  assert.equal(flow.runSummary(node,doc.assets[source],{provider:'runninghub'}).count,3);
  const job=await flow.run(store,{...req,provider:'runninghub'});
  assert.deepEqual(Array.from(job.settings.views),['rear','front-right','top']);
  assert.deepEqual(Array.from(job.outputs,out=>out.view),['rear','front-right','top']);
  assert.match(calls[0].prompt,/rear view/i);
  assert.match(calls[1].prompt,/front.right.*three.quarter/i);
  assert.match(calls[2].prompt,/overhead/i);
  assert.ok(calls.every(call=>call.prompt.includes(node.prompt)));
  assert.ok(job.outputs.every(output=>doc.assets[output.id].name===output.name));
  assert.deepEqual(Array.from(flow.normalizeViews(Object.keys(flow.viewPresets))).length,6);
});

test('defined view replay uses frozen inputs, prompts, dimensions and batch order', async()=>{
  const {flow,calls}=load(new Blob(['old frame']));
  const source=id();
  const doc={assets:{[source]:{id:source,name:'input',width:320,height:240,layers:[{blobId:id()}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  const first=await flow.run(store,{kind:'view',sourceId:source,views:['bottom','rear'],strength:.62,provider:'runninghub',seed:10});
  doc.assets[source].width=900;
  const replay=await flow.run(store,{rerunOf:first.id,views:['front'],quantity:1,provider:'runninghub',prompt:'Ignore',strength:.9,seed:20});
  assert.equal(replay.inputBlobId,first.inputBlobId);
  assert.deepEqual(Array.from(replay.outputs,output=>output.view),['bottom','rear']);
  assert.deepEqual(calls.slice(2).map(call=>call.prompt),calls.slice(0,2).map(call=>call.prompt));
  assert.deepEqual({...calls[2].size},{width:320,height:240});
  assert.equal(calls[2].strength,.62);
  assert.equal(calls[2].seed,20);
});

test('text-only viewpoint keeps legacy quantity and requires an angle description', async()=>{
  const {flow,calls}=load(new Blob(['source']));
  const source=id();
  const doc={assets:{[source]:{id:source,name:'product',width:64,height:48,layers:[{blobId:id()}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  await assert.rejects(flow.run(store,{kind:'view',sourceId:source,views:['unknown'],provider:'runninghub'}),/角度/);
  const job=await flow.run(store,{kind:'view',sourceId:source,prompt:'Front at 20 degrees',quantity:4,provider:'runninghub'});
  assert.equal(job.outputs.length,4);
  assert.equal(job.settings.views,undefined);
  assert.equal(calls[0].prompt,'Front at 20 degrees');
});


test('part refinement runs locally using the frozen revision and protected neighbors',async()=>{
  const {flow,calls,window}=load(new Blob(['structured draft'],{type:'image/png'}));
  const points=[{x:.2,y:.2},{x:.7,y:.2},{x:.7,y:.7},{x:.2,y:.7}];
  window.WuyingShapeModel={editRegion:(_parts,id)=>{assert.equal(id,'shade');return {points,protectedAreas:[points]};}};
  const source=id();
  const asset={id:source,name:'Draft',width:640,height:480,layers:[],draft:{revision:'old',parts:[{id:'shade',name:'灯罩'},{id:'base',locked:true}]}};
  const doc={assets:{[source]:asset},blocks:{},jobs:{}}, store=memoryStore(doc,new Map());
  await assert.rejects(flow.run(store,{kind:'form',sourceId:source,prompt:'wider',endpoint:'local',checkpoint:'model'}),/锁定/);
  const options={kind:'modify',sourceId:source,partId:'shade',draftRevision:'old',prompt:'texture',provider:'runninghub',endpoint:'local',checkpoint:'model'};
  const job=await flow.run(store,options);
  assert.equal(calls[0].provider,'comfy');
  assert.equal(job.draftRevision,'old');
  assert.equal(job.partSource.name,'灯罩');
  assert.deepEqual(calls[0].protectedAreas,[points]);
  asset.draft.revision='new';
  await assert.rejects(flow.run(store,options),/已更新/);
  const replay=await flow.run(store,{rerunOf:job.id,provider:'imageapi',endpoint:'local',checkpoint:'model'});
  assert.equal(replay.draftRevision,'old');
  assert.equal(replay.inputBlobId,job.inputBlobId);
  assert.deepEqual(calls[1].protectedAreas,[points]);
});


test('explicitly selecting Seedream V5 Pro sends that model in a Pro workspace operation',async()=>{
  const {flow,calls}=load(new Blob(['source'],{type:'image/png'}));
  const source=id();
  const asset={id:source,name:'input',width:64,height:48,layers:[{blobId:id()}]};
  const store=memoryStore({assets:{[source]:asset},blocks:{},jobs:{}},new Map());
  const prefs={provider:'runninghub',cloudModel:'seedream-v5-pro'};
  assert.equal(flow.ready(prefs),true);
  assert.match(flow.runSummary({kind:'modify',mode:'pro'},asset,prefs).text,/Seedream V5 Pro/);
  const job=await flow.run(store,{...prefs,sourceId:source,kind:'modify',mode:'pro',prompt:'Refine the lamp.'});
  assert.equal(job.settings.cloudModel,'seedream-v5-pro');
  assert.equal(calls[0].cloudModel,'seedream-v5-pro');
});

test('staged rendering freezes a reference and the finish preset for later comparison and replay', async () => {
  const {flow,calls}=load(new Blob(['source']));
  const source=id(), reference=id(), block=id();
  const doc={assets:{[source]:{id:source,name:'台灯',width:64,height:48,layers:[{blobId:id()}]},
    [reference]:{id:reference,name:'背景参考',width:64,height:48,layers:[{blobId:id()}]}},blocks:{[block]:{x:320,y:25}},jobs:{}};
  const store=memoryStore(doc,new Map());
  const job=await flow.run(store,{kind:'instant',blockId:block,inputs:[reference,source],roles:{[reference]:'style'},
    fidelity:'realistic',stageStyle:'keyshot',provider:'runninghub'});
  assert.equal(job.settings.stageStyle,'keyshot');
  assert.match(calls[0].prompt,/KeyShot/);
  assert.equal(job.references[0].id,reference);
  assert.equal(doc.assets[job.outputs[0].id].jobId,job.id);
  delete doc.assets[reference];
  const again=await flow.run(store,{rerunOf:job.id,stageStyle:'clay',provider:'runninghub'});
  assert.equal(again.references[0].blobId,job.references[0].blobId);
  assert.equal(again.settings.stageStyle,'keyshot');
  assert.equal(calls[1].prompt,calls[0].prompt);
});


test('outpaint keeps the source snapshot and exact placement when replayed',async()=>{
  const {flow,calls}=load(new Blob(['source']));
  const source=id(),doc={assets:{[source]:{id:source,name:'台灯',width:64,height:48,layers:[{blobId:id()}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  const first=await flow.run(store,{kind:'outpaint',sourceId:source,outpaint:{direction:'left',percent:25},endpoint:'local',checkpoint:'SDXL',provider:'runninghub'});
  assert.deepEqual({...calls[0].outpaint},{direction:'left',percent:25,x:16,y:0,width:80,height:48});
  assert.equal(calls[0].provider,'comfy');
  assert.equal(first.settings.quantity,1);
  doc.assets[source].width=120;
  const replay=await flow.run(store,{rerunOf:first.id,outpaint:{direction:'bottom',percent:50},endpoint:'local',checkpoint:'SDXL'});
  assert.deepEqual({...calls[1].outpaint},{...calls[0].outpaint});
  assert.equal(replay.inputBlobId,first.inputBlobId);
});

test('live preview ignores older renders that resolve after a new stroke',async()=>{
  const window={};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  const waiting=new Map(), seen=[];
  const {schedule,cancel}=window.WuyingWorkspaceRender.createLatestPreview({
    debounce:0,render:(value,signal)=>new Promise(resolve=>waiting.set(value,{resolve,signal})),
    onState:state=>{if(state.result)seen.push(state.result);}
  });
  const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
  schedule('first');await wait();
  schedule('second');await wait();
  assert.equal(waiting.get('first').signal.aborted,true);
  waiting.get('second').resolve('second');await wait();
  waiting.get('first').resolve('first');await wait();
  assert.deepEqual(seen,['second']);
  cancel();
});

test('实时渲染不中断旧帧：按顺序出帧，期间只保留最新笔触', async () => {
  const window={};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout,structuredClone});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  const waiting=new Map(), started=[], seen=[];
  const live=window.WuyingWorkspaceRender.createLatestPreview({
    debounce:0,keepRunning:true,
    render:(value,signal)=>{started.push(value);return new Promise(resolve=>waiting.set(value,{resolve,signal}));},
    onState:state=>{if(state.result)seen.push(state.result);}
  });
  const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
  live.schedule('a');await wait();
  live.schedule('b');live.schedule('c');await wait();
  assert.deepEqual(started,['a']);
  assert.equal(waiting.get('a').signal.aborted,false);
  waiting.get('a').resolve('A');await wait();
  assert.deepEqual(started,['a','c']);
  waiting.get('c').resolve('C');await wait();
  assert.deepEqual(seen,['A','C']);
  live.schedule('d');await wait();
  live.cancel();
  assert.equal(waiting.get('d').signal.aborted,true);
  waiting.get('d').resolve('D');await wait();
  assert.deepEqual(seen,['A','C']);
});

test('实时快照把未落笔的笔触并进图层且不改原数据', () => {
  const window={};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout,structuredClone});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  const {liveSnapshot}=window.WuyingWorkspaceRender;
  const asset={layers:[{id:'ink',kind:'ink',visible:true,strokes:[{points:[{x:0,y:0}]}]}]};
  const stroke={points:[{x:.1,y:.1},{x:.2,y:.2}],color:'#000',size:4};
  const merged=liveSnapshot(asset,{layerId:'ink',stroke});
  assert.equal(merged.layers[0].strokes.length,2);
  assert.equal(asset.layers[0].strokes.length,1);
  const added=liveSnapshot({layers:[]},{layerId:'missing',stroke});
  assert.equal(added.layers.length,1);
  assert.equal(liveSnapshot({layers:[]},{layerId:'missing',stroke:{...stroke,erase:true}}).layers.length,0);
  assert.equal(liveSnapshot(asset,{layerId:'ink',stroke:{points:[{x:0,y:0}]}}).layers[0].strokes.length,1);
});

test('方案主题编译：自动方向、主体锁定、自定义覆盖', () => {
  const window = {};
  const context = vm.createContext({ window, AbortController, setTimeout, clearTimeout, structuredClone });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/workspace-render.js', 'utf8'), context);
  const { themeDirective } = window.WuyingWorkspaceRender;
  assert.equal(themeDirective(undefined), '');
  assert.equal(themeDirective(null), '');
  assert.equal(themeDirective({}), '');
  assert.equal(themeDirective({ text: '   ' }), '');
  const auto = themeDirective({ text: '北欧极简家居' });
  assert.match(auto, /^Design theme and visual direction: 北欧极简家居\./);
  assert.match(auto, /fixed main subject/);
  assert.match(auto, /preserve its product category, silhouette, proportions, parts and camera angle/);
  assert.match(auto, /only to styling, materials, colors, lighting and scene context/);
  assert.match(auto, /never change the product structure/);
  const manual = themeDirective({ text: '自动主题', custom: 'Warm brushed titanium, soft studio light.' });
  assert.match(manual, /Warm brushed titanium, soft studio light\./);
  assert.doesNotMatch(manual, /自动主题/);
  assert.match(manual, /fixed main subject/);
  assert.match(themeDirective({ text: '有主题', custom: '   ' }), /有主题/);
});
