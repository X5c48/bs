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

test('Qwen-Image-2.1 路由：整图渲染走专用通道，实时帧与选区重绘被拦截', async () => {
  const png = new Blob(['source'], { type: 'image/png' });
  const calls = [];
  const window = {
    WuyingImageSelection: { enough: points => points.length >= 3, prepare: async () => ({ sourceImage: png, maskImage: png }), composite: async (p, blob) => blob },
    WuyingComfy: {
      renderQwen: async options => { calls.push(['qwen', options]); return { blob: new Blob(['qwenhd'], { type: 'image/png' }) }; },
      renderLive: async options => { calls.push(['live', options]); return { blob: new Blob(['sd'], { type: 'image/png' }) }; }
    }
  };
  const context = vm.createContext({ window, AbortController, setTimeout, clearTimeout, structuredClone, Blob,
    createImageBitmap: async () => ({ width: 64, height: 48, close() {} }),
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray() }) }), toBlob: cb => cb(new Blob(['x'], { type: 'image/png' })) }) } });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/workspace-render.js', 'utf8'), context);
  const { generate } = window.WuyingWorkspaceRender;
  const qwen = 'qwen_image_2.1_turbo_int8_convrot.safetensors';

  // 1. 整图渲染：走 renderQwen，提示词含意图，源图作为参考
  const out = await generate({ kind: 'render', provider: 'comfy', source: png, endpoint: 'http://localhost:8188', checkpoint: qwen, prompt: 'a lamp', seed: 3 });
  assert.equal(await out.text(), 'qwenhd');
  assert.equal(calls[0][0], 'qwen');
  assert.equal(calls[0][1].checkpoint, qwen);
  assert.match(calls[0][1].prompt, /^a lamp .*supplied sketch/);
  assert.equal(calls[0][1].sourceImage, png);
  assert.match(calls[0][1].negative, /lowres/);

  // 2. live:true 走 Qwen 慢速预览通道：分体式 diffusion 进 SD 实时工作流必然 400 失败
  calls.length = 0;
  await generate({ kind: 'render', provider: 'comfy', live: true, liveTier:'balanced', source: png, endpoint: 'http://localhost:8188', checkpoint: qwen, prompt: 'a lamp', controlnet: 'scribble.safetensors' });
  assert.equal(calls[0][0], 'qwen');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].sourceImage, png);
  assert.ok(calls[0][1].resolution <= 640, '实时档必须压低分辨率换响应：' + calls[0][1].resolution);
  assert.equal(calls[0][1].cancelPending, true, '实时帧要能取消在途任务');

  // 3. 选区重绘 + qwen → 明确报错
  await assert.rejects(generate({ kind: 'modify', provider: 'comfy', source: png, endpoint: 'http://localhost:8188', checkpoint: qwen, prompt: 'x', selection: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }), /选区重绘请换 SD1\.5/);
  assert.equal(calls.length, 1);

  // 4. SD1.5 checkpoint 不受影响
  calls.length = 0;
  await generate({ kind: 'render', provider: 'comfy', source: png, endpoint: 'http://localhost:8188', checkpoint: 'v1-5.safetensors', prompt: 'a lamp', controlnet: 'scribble.safetensors', live: false });
  assert.equal(calls[0][0], 'live');
  assert.equal(calls.length, 1);
});

test('草图影响力：render 快照含 influence 并透传出图；旧值回退 strength；instant 默认 0.8', async () => {
  const { flow, calls } = load(new Blob(['source']));
  const main = id();
  const doc = { assets: { [main]: { id:main, name:'草图', width:64, height:48, layers:[{ blobId:id(), visible:true }] } }, blocks:{}, jobs:{} };
  const store = memoryStore(doc, new Map());
  const conn = { provider:'comfy', endpoint:'http://localhost:8188', checkpoint:'v1-5.safetensors', controlnet:'scribble.safetensors' };
  const job = await flow.run(store, { kind:'render', inputs:[main], ...conn, influence:1.2, strength:.9 });
  assert.equal(job.settings.influence, 1.2);
  assert.equal(job.settings.strength, 1, '兼容字段压回 0–1');
  assert.equal(calls.at(-1).influence, 1.2, 'influence 必须透传给出图通道');
  const legacy = await flow.run(store, { kind:'render', inputs:[main], ...conn, strength:.65 });
  assert.equal(legacy.settings.influence, .65, '旧项目无 influence 字段时回退原控形强度');
  const instantJob = await flow.run(store, { kind:'instant', inputs:[main], ...conn, fidelity:'realistic' });
  assert.equal(instantJob.settings.influence, .8, 'instant 未传时用方案默认 0.8');
});

test('explore runs one candidate per chosen direction with its own prompt and seed, and replays the same directions', async()=>{
  const {flow,calls}=load(new Blob(['sketch']));
  const main=id();
  const doc={assets:{[main]:{id:main,name:'台灯',width:64,height:48,layers:[{id:id(),blobId:id(),visible:true}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  const job=await flow.run(store,{kind:'explore',inputs:[main],provider:'runninghub',prompt:'desk lamp',directions:['minimal','retro','tech'],quantity:8});
  assert.equal(job.kind,'explore');
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.kind==='render'));
  assert.deepEqual(job.outputs.map(o=>o.direction),['minimal','retro','tech']);
  assert.ok(job.outputs.every((o,i)=>o.name.includes(flow.directionPresets[job.settings.directions[i]].label)));
  assert.equal(new Set(calls.map(c=>c.prompt)).size,3);
  assert.ok(calls.every(c=>/desk lamp/.test(c.prompt)));
  assert.match(calls[0].prompt,new RegExp(flow.directionPresets.minimal.prompt.slice(0,20).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(new Set(calls.map(c=>c.seed)).size,3);
  const replay=await flow.run(store,{rerunOf:job.id,provider:'runninghub',directions:['organic','rugged']});
  assert.deepEqual(replay.settings.directions,['minimal','retro','tech']);
  assert.deepEqual(calls.slice(3).map(c=>c.prompt),calls.slice(0,3).map(c=>c.prompt));
});

test('explore refuses fewer than two directions and caps at the limit', async()=>{
  const {flow}=load(new Blob(['sketch']));
  const main=id();
  const doc={assets:{[main]:{id:main,name:'台灯',width:64,height:48,layers:[{id:id(),blobId:id(),visible:true}]}},blocks:{},jobs:{}};
  await assert.rejects(flow.run(memoryStore(doc,new Map()),{kind:'explore',inputs:[main],provider:'runninghub',directions:['minimal']}),/至少选择两个/);
  assert.equal(flow.normalizeDirections(['minimal','minimal','bogus','organic']).length,2);
  assert.ok(flow.normalizeDirections(Object.keys(flow.directionPresets).concat('x')).length<=flow.directionLimit);
});

test('scene render needs a photo and a sketch, auto-bounds the sketch, and freezes photo + sketch for replay', async()=>{
  const {flow,calls}=load(new Blob(['composite'],{type:'image/png'}));
  const main=id(), photo=id();
  const ink={id:id(),kind:'ink',visible:true,strokes:[{size:10,points:[{x:.4,y:.5},{x:.6,y:.7}]}]};
  const doc={assets:{[main]:{id:main,name:'客厅',width:1000,height:500,layers:[ink]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  await assert.rejects(flow.run(store,{kind:'scene',inputs:[main],endpoint:'e',checkpoint:'c'}),/场景照片/);
  doc.assets[main].layers=[{id:photo,kind:'image',blobId:id(),visible:true}];
  await assert.rejects(flow.run(store,{kind:'scene',inputs:[main],endpoint:'e',checkpoint:'c'}),/画出产品草图/);
  doc.assets[main].layers=[{id:photo,kind:'image',blobId:id(),visible:true},ink];
  const job=await flow.run(store,{kind:'scene',inputs:[main],endpoint:'e',checkpoint:'c',controlnet:'scribble',prompt:'lamp'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].kind,'scene');
  assert.ok(calls[0].scene.photo && calls[0].scene.sketch);
  const sx=job.selection.map(p=>p.x),sy=job.selection.map(p=>p.y);
  assert.ok(Math.min(...sx)<.4-.005 && Math.min(...sy)<.5-.01 && Math.max(...sx)>.6+.005 && Math.max(...sy)>.7+.01,'选区含笔宽与外扩');
  assert.ok(Math.min(...sx)>.3 && Math.max(...sx)<.7,'选区不应覆盖整张照片');
  assert.ok(job.selection.length>4,'自动选区为凸包而非矩形');
  assert.ok(!job.selection.some(p=>p.x>.62&&p.y<.52),'对角线草图的空角不应被选入');
  assert.equal(job.settings.strength,.85);
  assert.ok(job.scene.photoBlobId && job.scene.sketchBlobId);
  assert.ok(store.added.includes(job.scene.photoBlobId) && store.added.includes(job.scene.sketchBlobId));
  // 照片层被删后，重跑仍用快照
  doc.assets[main].layers=[];
  const replay=await flow.run(store,{rerunOf:job.id,endpoint:'e',checkpoint:'c'});
  assert.deepEqual(replay.selection,job.selection);
  assert.deepEqual(replay.scene,job.scene);
  assert.ok(calls[1].scene.photo);
  // 显式选区优先
  doc.assets[main].layers=[{id:photo,kind:'image',blobId:id(),visible:true},ink];
  const lasso=[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}];
  const picked=await flow.run(store,{kind:'scene',inputs:[main],endpoint:'e',checkpoint:'c',selection:lasso});
  assert.deepEqual(picked.selection,lasso);
});

test('sketch bounds reject a too-small sketch', ()=>{
  const {flow}=load();
  assert.throws(()=>flow.sketchBounds([{size:1,points:[{x:.5,y:.5}]}],{width:4000,height:4000}),/太小/);
});

test('studio presentation runs one output per shot with sized targets, material prompt and replay', async()=>{
  const {flow,calls}=load(new Blob(['render'],{type:'image/png'}));
  const main=id();
  const doc={assets:{[main]:{id:main,name:'台灯',width:1000,height:500,layers:[{id:id(),blobId:id(),visible:true}]}},blocks:{},jobs:{}};
  const store=memoryStore(doc,new Map());
  const conn={endpoint:'e',checkpoint:'c'};
  await assert.rejects(flow.run(store,{kind:'studio',inputs:[main],...conn,shots:[]}),/呈现镜头/);
  const job=await flow.run(store,{kind:'studio',inputs:[main],...conn,material:'aluminum',prompt:'desk lamp'});
  assert.deepEqual(job.settings.shots,['hero','detail'],'默认主图+特写');
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.kind==='studio'));
  assert.deepEqual(calls.map(c=>c.shot),['hero','detail']);
  assert.deepEqual({...calls[0].size},{width:1280,height:640},'主图长边 1280 跟随 2:1');
  assert.deepEqual({...calls[1].size},{width:1280,height:1024},'特写 1280×1024');
  assert.ok(calls.every(c=>/anodized aluminum/.test(c.prompt)&&/desk lamp/.test(c.prompt)),'提示词含材质描述');
  assert.match(calls[0].prompt,/hero shot/);
  assert.match(calls[1].prompt,/Macro close-up/);
  assert.equal(job.settings.strength,.4);
  assert.deepEqual(job.outputs.map(o=>o.shot),['hero','detail']);
  assert.ok(job.outputs[0].name.includes('棚拍主图')&&job.outputs[1].name.includes('材质特写'));
  const lasso=[{x:.1,y:.1},{x:.3,y:.1},{x:.3,y:.3}];
  const picked=await flow.run(store,{kind:'studio',inputs:[main],...conn,shots:['detail'],selection:lasso});
  assert.deepEqual(picked.selection,lasso);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).selection)),lasso);
  assert.equal(picked.settings.material,'auto');
  const replay=await flow.run(store,{rerunOf:job.id,...conn,prompt:'changed'});
  assert.deepEqual([...replay.settings.shots],[...job.settings.shots]);
  assert.equal(calls.at(-2).prompt,calls[0].prompt,'重跑沿用原提示词');
  assert.deepEqual({...flow.shotSize('hero',{width:600,height:900})},{width:856,height:1280});
});

test('studio render: hero uses two-pass final, detail crops selection or centre, Qwen uses its channel', async()=>{
  const calls=[], drawn=[];
  const window={WuyingImageSelection:{},WuyingComfy:{
    renderLive:async o=>{calls.push(['live',o]);return {blob:new Blob(['hd'],{type:'image/png'})};},
    renderQwen:async o=>{calls.push(['qwen',o]);return {blob:new Blob(['q'],{type:'image/png'})};}}};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout,structuredClone,Blob,
    createImageBitmap:async()=>({width:1280,height:1024,close(){}}),
    document:{createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},drawImage(...a){drawn.push(a);},getImageData:()=>({data:new Uint8ClampedArray()})}),toBlob:cb=>cb(new Blob(['x'],{type:'image/png'}))})}});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  const {generate,detailBox}=window.WuyingWorkspaceRender;
  const png=new Blob(['s'],{type:'image/png'});
  const base={kind:'studio',provider:'comfy',source:png,endpoint:'e',checkpoint:'v1-5.safetensors',prompt:'lamp',strength:.4};
  await generate({...base,shot:'hero',size:{width:1280,height:1024}});
  assert.equal(calls[0][0],'live');
  assert.equal(calls[0][1].quality,'final');
  assert.equal(calls[0][1].input,'image');
  assert.equal(calls[0][1].sourceImage,png,'主图用整张源图');
  assert.match(calls[0][1].prompt,/^lamp .*studio product photography/);
  assert.ok(calls[0][1].strength>.7,'保形为主');
  drawn.length=0;
  await generate({...base,shot:'detail'});
  assert.notEqual(calls[1][1].sourceImage,png,'特写用裁切图');
  const centre=detailBox(1000,800);
  assert.deepEqual({...centre},{x:250,y:200,width:500,height:400});
  const sel=detailBox(1000,800,[{x:.1,y:.1},{x:.2,y:.1},{x:.2,y:.2}]);
  assert.ok(Math.abs(sel.width/sel.height-1.25)<.01);
  assert.ok(sel.x<=100&&sel.y<=80&&sel.x+sel.width>=200&&sel.y+sel.height>=160,'选区被框住');
  assert.ok(sel.width<500,'选区特写比中心更近');
  const edge=detailBox(1000,800,[{x:.9,y:.9},{x:1,y:.9},{x:1,y:1}]);
  assert.ok(edge.x+edge.width<=1000.01&&edge.y+edge.height<=800.01,'取景框不出界');
  await generate({...base,shot:'hero',checkpoint:'qwen_image_2.1_turbo.safetensors'});
  assert.equal(calls.at(-1)[0],'qwen');
});

test('studio render: a line-art source goes through ControlNet sketch path instead of img2img', async()=>{
  const calls=[];
  const white=new Uint8ClampedArray(96*72*4).fill(255);
  for(let i=0;i<300;i++) white.fill(0,i*4*20,i*4*20+3);
  const window={WuyingImageSelection:{},WuyingComfy:{renderLive:async o=>{calls.push(o);return {blob:new Blob(['hd'],{type:'image/png'})};}}};
  const context=vm.createContext({window,AbortController,setTimeout,clearTimeout,structuredClone,Blob,
    createImageBitmap:async()=>({width:1280,height:960,close(){}}),
    document:{createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},drawImage(){},putImageData(){},getImageData:()=>({data:white})}),toBlob:cb=>cb(new Blob(['x'],{type:'image/png'}))})}});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  const {generate,looksLikeSketch}=window.WuyingWorkspaceRender;
  const png=new Blob(['s'],{type:'image/png'});
  assert.equal(await looksLikeSketch(png),true);
  await generate({kind:'studio',shot:'hero',provider:'comfy',source:png,endpoint:'e',checkpoint:'v1-5.safetensors',controlnet:'scribble.safetensors',prompt:'lamp'});
  assert.equal(calls[0].input,'sketch');
  assert.equal(calls[0].quality,'final');
  assert.equal(calls[0].controlnet,'scribble.safetensors');
  await generate({kind:'studio',shot:'hero',provider:'comfy',source:png,endpoint:'e',checkpoint:'v1-5.safetensors',prompt:'lamp'});
  assert.equal(calls[1].input,'image','没有 ControlNet 时回退 img2img');
});

/* ── 生成视角严格基于造型数据：结构投影 + 几何锁定 ── */

function renderHarness({controlnets}={}){
  const live=[], qwen=[], canvases=[];
  const png=()=>new Blob(['png'],{type:'image/png'});
  const context2d=()=>({
    fillStyle:'',strokeStyle:'',lineWidth:1,lineJoin:'',lineCap:'',globalAlpha:1,
    fillRect(){},drawImage(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},
    getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
    putImageData(){}
  });
  const document={
    createElement:tag=>{
      if(tag!=='canvas') throw new Error('unexpected '+tag);
      const canvas={width:0,height:0,getContext:()=>context2d(),toBlob:cb=>cb(png())};
      canvases.push(canvas);
      return canvas;
    }
  };
  const window={WuyingShapeModel:require('./dist/shape-model.js'),
    WuyingComfy:{
      renderLive:async options=>{live.push(options);return {blob:png()};},
      renderQwen:async options=>{qwen.push(options);return {blob:png()};}
    },
    WuyingWorkspaceRender:null};
  const context=vm.createContext({window,document,Blob,Uint8ClampedArray,
    createImageBitmap:async()=>({width:640,height:480,close(){}}),
    fetch:async()=>{
      return {json:async()=>({ControlNetLoader:{input:{required:{control_net_name:[['control_v11p_sd15_scribble_fp16']]}}}})};
    }});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-render.js','utf8'),context);
  return {render:window.WuyingWorkspaceRender,live,qwen,canvases,png};
}

test('resolveViewAngle：规范角度表 + 角度球自定义覆盖与钳位',()=>{
  const {render}=renderHarness();
  const angle=(view,custom)=>{const r=render.resolveViewAngle(view,custom);return {azimuth:r.azimuth,elevation:r.elevation};};
  assert.deepEqual(angle('right'),{azimuth:90,elevation:0});
  assert.deepEqual(angle('front-left'),{azimuth:315,elevation:0});
  assert.deepEqual(angle('top'),{azimuth:0,elevation:85});
  assert.deepEqual(angle('bottom'),{azimuth:0,elevation:-85});
  // 角度球精确角度覆盖规范值
  assert.deepEqual(angle('front-right',{azimuth:37,elevation:12}),{azimuth:37,elevation:12});
  assert.equal(angle('front',{azimuth:-45,elevation:0}).azimuth,315); // 负角回绕
  assert.equal(angle('front',{azimuth:0,elevation:120}).elevation,85); // 俯仰钳位
  assert.deepEqual(angle('right',{azimuth:'x'}),{azimuth:90,elevation:0}); // 非法回落
});

test('结构锁定的视角生成：ControlNet 全程控形、强度提升、指令里带几何锁定',async()=>{
  const {render,live,png}=renderHarness();
  const blob=await render.generate({kind:'view',source:png(),structureImage:png(),
    endpoint:'http://127.0.0.1:8188',checkpoint:'v1-5-pruned-emaonly-fp16.safetensors',
    controlnet:'',strength:.5,prompt:'right view'});
  assert.ok(blob instanceof Blob);
  assert.equal(live.length,1);
  const call=live[0];
  assert.equal(call.input,'sketch');
  assert.equal(call.controlnet,'control_v11p_sd15_scribble_fp16');
  assert.equal(call.strength,.82);
  assert.equal(call.endPercent,1);
  assert.match(call.prompt,/exactly as drawn/);
  assert.match(call.prompt,/right view/);
  // 没有结构图时保持原行为：视角生成不走 sketch 通道
  const plain=await render.generate({kind:'view',source:png(),
    endpoint:'http://127.0.0.1:8188',checkpoint:'v1-5-pruned-emaonly-fp16.safetensors',strength:.5,prompt:'right view'});
  assert.ok(plain instanceof Blob);
  assert.equal(live[1].input,'image');
  assert.equal(live[1].controlnet,'');
});

test('Qwen 视角生成把结构投影作为参考图传入，禁止脱离造型',async()=>{
  const {render,qwen,png}=renderHarness();
  await render.generate({kind:'view',source:png(),structureImage:png(),
    endpoint:'http://127.0.0.1:8188',checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors',
    strength:.5,prompt:'front view'});
  assert.equal(qwen.length,1);
  // renderQwen 的参考图参数就是 sourceImage（内部接到 images.image_1）
  assert.ok(qwen[0].sourceImage instanceof Blob,'结构线稿作为参考图');
  assert.match(qwen[0].prompt,/exactly as drawn/);
  assert.equal(qwen[0].negative.includes('blurry'),true,'必须带质量负面词');
  // 没有结构图时用源图作参考（造型仍来自画面本身）
  await render.generate({kind:'view',source:png(),
    endpoint:'http://127.0.0.1:8188',checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors',
    strength:.5,prompt:'front view'});
  assert.ok(qwen[1].sourceImage instanceof Blob);
});

test('视角请求带部件数据时按视角投影结构线稿并随请求下发',async()=>{
  const calls=[];
  const png=new Blob(['source'],{type:'image/png'});
  const window={
    WuyingImageSelection:{enough:()=>true},
    WuyingWorkspaceComposite:{toPng:async()=>png},
    WuyingComfy:{runImageTool:async()=>({blob:new Blob(['png'],{type:'image/png'})})},
    WuyingWorkspaceRender:{
      generate:async options=>{calls.push(options);return new Blob(['png'],{type:'image/png'});},
      resolveViewAngle:(view,custom)=>custom&&Number.isFinite(custom.azimuth)
        ?{azimuth:custom.azimuth,elevation:custom.elevation}:{azimuth:90,elevation:0},
      structureSketchBlob:async()=>new Blob(['struct'],{type:'image/png'})
    }};
  const context=vm.createContext({window,crypto,localStorage:{getItem:()=>null,setItem(){}},
    Blob,Uint32Array,createImageBitmap:async()=>({width:64,height:48,close(){}})});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-workflow.js','utf8'),context);
  const flow=window.WuyingWorkflow;
  const source=id(),block=id();
  const part={id:'p1',shape:'rectangle',name:'底盘',locked:false,x:320,y:240,width:200,height:100,angle:0,depth:20,z:0};
  const doc={assets:{[source]:{id:source,name:'挂钟',width:640,height:480,layers:[{blobId:id()}],
    draft:{revision:'r1',parts:[part]}}},blocks:{[block]:{x:330,y:10}},jobs:{}};
  const store=memoryStore(doc,new Map());
  // 右视：部件数据 → 结构线稿随请求下发，角度球精确角度存进 settings
  const job=await flow.run(store,{kind:'view',sourceId:source,blockId:block,views:['right'],
    endpoint:'http://127.0.0.1:8188',checkpoint:'v1-5',viewAngles:{right:{azimuth:95,elevation:4}}});
  assert.ok(calls[0].structureImage instanceof Blob,'结构投影线稿已下发');
  assert.equal(job.settings.viewAngles.right.azimuth,95);
  // 无部件数据的视角请求不带结构线稿
  const plain=id();
  doc.assets[plain]={id:plain,name:'草图',width:640,height:480,layers:[{blobId:id()}]};
  await flow.run(store,{kind:'view',sourceId:plain,blockId:block,views:['right'],
    endpoint:'http://127.0.0.1:8188',checkpoint:'v1-5'});
  assert.equal(calls[1].structureImage,undefined);
  // 重跑沿用存下的角度（不重新读球）
  await flow.run(store,{rerunOf:job.id,endpoint:'http://127.0.0.1:8188',checkpoint:'v1-5'});
  assert.ok(calls[2].structureImage instanceof Blob);
  assert.equal(job.settings.viewAngles.right.azimuth,95);
});

test('Qwen 通道：分辨率映射按显存上限钳到 1024，出图追加产品摄影与还原约束', async () => {
  const {render,qwen,png}=renderHarness();
  assert.equal(render.qwenResolution('1k'),1024);
  assert.equal(render.qwenResolution('2k'),1024,'8G 显存下单次上限 1024');
  assert.equal(render.qwenResolution(768),768);
  assert.match(render.qwenDirective,/exactly as shown/);
  assert.match(render.qwenNegative,/distorted silhouette/);
  await render.generate({kind:'render',source:png(),endpoint:'http://127.0.0.1:8188',
    checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors',prompt:'a lamp',size:{width:640,height:480}});
  const call=qwen[0];
  const text=call.prompt;
  assert.match(text,/Photorealistic product design render/,'出图必须带摄影脚手架');
  assert.ok(text.indexOf('a lamp')===0,'用户提示词仍在最前');
  assert.match(call.negative,/distorted silhouette/);
  assert.equal(call.sourceImage instanceof Blob,true);
});

test('精细渲染读取三张视图的实际像素，按原输入重跑复用冻结快照',async()=>{
  const primary=new Blob(['white model'],{type:'image/png'});
  const {flow,calls}=load(primary),source=id(),batch=id();
  const outputs=['front','left','top'].map(view=>({id:id(),view,blobId:id()}));
  const blobs=new Map(outputs.map(o=>[o.blobId,new Blob([o.view],{type:'image/png'})]));
  const doc={assets:{[source]:{id:source,name:'白模',width:640,height:480,layers:[{blobId:id()}]}},blocks:{},jobs:{[batch]:{id:batch,outputs}}};
  const store=memoryStore(doc,blobs);
  const references=outputs.map(o=>({id:o.id,role:'ortho-'+o.view,outputJobId:batch}));
  const first=await flow.run(store,{kind:'render',sourceId:source,prompt:'desk lamp',references,endpoint:'local',checkpoint:'model'});
  assert.deepEqual(await Promise.all(calls[0].references.map(r=>r.blob.text())),['front','left','top']);
  for(const o of outputs) blobs.delete(o.blobId);
  const second=await flow.run(store,{rerunOf:first.id,endpoint:'local',checkpoint:'model'});
  assert.deepEqual(second.references,first.references);
  assert.deepEqual(await Promise.all(calls.at(-1).references.map(r=>r.blob.text())),['front','left','top']);
});
