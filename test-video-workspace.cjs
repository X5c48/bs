const { test }=require('node:test');
const assert=require('node:assert/strict');
const { readFileSync }=require('node:fs');
const { runInNewContext }=require('node:vm');

function fixture({ltxWeights=true}={}) {
  const source=crypto.randomUUID(), tail=crypto.randomUUID(), data=new Map(), media=new Map(), calls=[], submitted=[];
    const doc={assets:{[source]:{id:source,name:'台灯首帧',width:640,height:480,adopted:true},
    [tail]:{id:tail,name:'台灯尾帧',width:640,height:480}},blocks:{},jobs:{}};
  const store={
    read:async()=>structuredClone(doc),
    getBlob:async id=>media.get(id),
    change:async (mutator,blobs=[])=>{
      mutator(doc);
      for(const {id,blob} of blobs)media.set(id,blob);
      return structuredClone(doc);
    }
  };
  const window={WuyingWorkspaceComposite:{toPng:async(asset)=>new Blob([asset.name],{type:'image/png'})}};
  const player={
    videoWidth:320,videoHeight:240,duration:3,
    set src(_value){queueMicrotask(()=>this.onloadedmetadata?.());},
    removeAttribute(){},load(){}
  };
  const context={window,crypto,Blob,FormData,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,
    localStorage:{setItem:(key,value)=>data.set(key,value),getItem:key=>data.get(key)},
    document:{createElement:()=>player},
    fetch:async (url,options)=>{
      const path=new URL(url).pathname;
      calls.push(path);
      if(path==='/object_info/CheckpointLoaderSimple')return {ok:true,json:async()=>({CheckpointLoaderSimple:{
        input:{required:{ckpt_name:[ltxWeights?['ltxv-2b-0.9.6-distilled-04-25.safetensors']:[]]}}
      }})};
      if(path==='/object_info/CLIPLoader')return {ok:true,json:async()=>({CLIPLoader:{
        input:{required:{clip_name:[['t5xxl_fp8_e4m3fn.safetensors']]}}
      }})};
      if(path==='/upload/image'){
        const index=calls.filter(entry=>entry===path).length;
        return {ok:true,json:async()=>({name:'frame-'+index+'.png'})};
      }
      if(path==='/prompt'){
        submitted.push(JSON.parse(options.body).prompt);
        return {ok:true,json:async()=>({prompt_id:'provider-job'})};
      }
      if(path==='/history/provider-job')return {ok:true,json:async()=>({'provider-job':{
        outputs:{save:{videos:[{filename:'clip.mp4'}]}}
      }})};
      if(path==='/view')return {ok:true,blob:async()=>new Blob([Buffer.from('00000018667479706d70343200000000','hex')])};
      throw new Error('Unexpected endpoint '+path);
    }
  };
  runInNewContext(readFileSync(__dirname+'/dist/workspace-video.js','utf8'),context);
  const video=window.WuyingVideo;
  video.saveComfy('http://127.0.0.1:8188',JSON.stringify({
    1:{class_type:'LoadImage',inputs:{image:'{{FIRST_FRAME}}'}},
    2:{class_type:'SaveVideo',inputs:{filename_prefix:'{{PROMPT}}'}}
  }));
  const request={provider:'comfy',mode:'image',sourceId:source,prompt:'拍摄台灯展示视频',duration:5,aspect:'16:9'};
  const options={signal:new AbortController().signal,place:()=>({x:320,y:20})};
  return {video,request,options,store,doc,calls,tail,submitted};
}

test('stores the dimensions and duration of the generated video instead of the input defaults',async()=>{
  const {video,request,options,store,doc}=fixture();
  const result=await video.run(store,request,options);
  const output=doc.assets[result.outputId];
  assert.equal(output.width,320);
  assert.equal(output.height,240);
  assert.equal(output.duration,3);
  assert.equal(result.actualDuration,3);
});

test('two starts from the same project only submit the first video task',async()=>{
  const {video,request,options,store,calls}=fixture();
  const results=await Promise.allSettled([
    video.run(store,request,options),video.run(store,request,options)
  ]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.match(results.find(item=>item.status==='rejected').reason.message,/已有视频任务/);
  assert.equal(calls.filter(route=>route==='/prompt').length,1);
});

test('LTX preset checks installed weights, then exposes only first-frame image-to-video',async()=>{
  const available=fixture();
  const preset=await available.video.ltxPreset('http://127.0.0.1:8188');
  assert.equal(Object.values(preset).find(item=>item.class_type==='LTXVImgToVideo').inputs.length,49);
  available.video.saveComfy('http://127.0.0.1:8188',JSON.stringify(preset));
  const caps=available.video.capabilities('comfy');
  assert.equal(caps.modes[0],'image');
  assert.equal(caps.last,false);
  assert.equal(caps.duration,false);
  const missing=fixture({ltxWeights:false});
  await assert.rejects(missing.video.ltxPreset('http://127.0.0.1:8188'),/缺少.*ltxv-2b/);
});
test('one LTX preset can generate text-only video without preparing an image',async()=>{
  const {video,request,options,store,calls,submitted}=fixture();
  video.saveComfyPreset('http://127.0.0.1:8188');
  const caps=video.capabilities('comfy');
  assert.equal([...caps.modes].join(','),'image,frames,text');
  const job=await video.run(store,{...request,mode:'text'},options);
  assert.equal(job.sourceId,null);
  assert.equal(job.firstFrame,undefined);
  assert.equal(calls.includes('/upload/image'),false);
  assert.ok(Object.values(submitted[0]).some(node=>node.class_type==='EmptyLTXVLatentVideo'));
  assert.equal(job.workflowPreset,'ltx-2b');
});

test('LTX first/last preset snapshots both sources and removes the additional guide before decoding',async()=>{
  const {video,request,options,store,calls,tail,submitted}=fixture();
  video.saveComfyPreset('http://127.0.0.1:8188');
  await assert.rejects(video.run(store,{...request,mode:'frames'},options),/请选择尾帧/);
  const job=await video.run(store,{...request,mode:'frames',lastId:tail},options);
  assert.equal(job.lastName,'台灯尾帧');
  assert.equal(await (await store.getBlob(job.firstFrame)).text(),'台灯首帧');
  assert.equal(await (await store.getBlob(job.lastFrame)).text(),'台灯尾帧');
  assert.equal(calls.filter(route=>route==='/upload/image').length,2);
  const graph=submitted[0];
  assert.equal(Object.values(graph).find(node=>node.class_type==='LTXVAddGuide').inputs.frame_idx,48);
  const cropId=Object.keys(graph).find(id=>graph[id].class_type==='LTXVCropGuides');
  assert.equal(Object.values(graph).find(node=>node.class_type==='VAEDecodeTiled').inputs.samples[0],cropId);
});