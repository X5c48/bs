const {test}=require('node:test');
const assert=require('node:assert/strict');
const live=require('./dist/live-render-core.js');
const comfy=require('./dist/comfy.js');

const settings={checkpoint:'model.safetensors',controlnet:'scribble.safetensors',strength:.8,
  prompt:'ceramic concept',negative:'text',seed:147,inputImage:'sketch.png'};

test('preview and high resolution use the same first pass, then HD refines at 1280 × 1024',()=>{
  const preview=comfy.liveWorkflow({...settings,input:'sketch',quality:'preview'});
  const final=comfy.liveWorkflow({...settings,input:'sketch',quality:'final'});
  assert.equal(preview[7].class_type,'ControlNetApplyAdvanced');
  assert.deepEqual(preview[9],final[9]);
  assert.equal(preview[11].class_type,'PreviewImage');
  assert.equal(final[12].class_type,'LatentUpscale');
  assert.equal(final[12].inputs.width,1280);
  assert.equal(final[12].inputs.height,1024);
  assert.equal(final[13].class_type,'KSampler');
  assert.ok(final[13].inputs.denoise>0&&final[13].inputs.denoise<.5);
  assert.deepEqual(final[10].inputs.samples,['13',0]);
  assert.equal(final[11].class_type,'SaveImage');
});

test('text uses a clean latent and image input uses VAE encoding without a mandatory ControlNet',()=>{
  const text=comfy.liveWorkflow({...settings,input:'text',quality:'preview'});
  assert.equal(text[4],undefined);
  assert.equal(text[8].class_type,'EmptyLatentImage');
  assert.equal(text[9].inputs.denoise,1);
  for(const input of ['image','sketch']){
    const image=comfy.liveWorkflow({...settings,input,controlnet:'',quality:'preview'});
    assert.equal(image[4].class_type,'LoadImage');
    assert.equal(image[8].class_type,'VAEEncode');
    assert.equal(image[7],undefined);
    assert.ok(image[9].inputs.denoise>0&&image[9].inputs.denoise<1);
  }
});

test('renderLive submits a text workflow without upload and an image workflow with upload',async()=>{
  const calls=[], originalFetch=global.fetch;
  const put=(payload)=>new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});
  global.fetch=async (url,options)=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/upload/image'){
      assert.equal(options.body.get('image').type,'image/png');
      return put({name:'canvas.png',subfolder:'wuying'});
    }
    if(path==='/prompt'){
      const {prompt}=JSON.parse(options.body);
      assert.equal(prompt[2].inputs.text,'ceramic concept');
      assert.equal(prompt[11].class_type,'PreviewImage');
      return put({prompt_id:'job'});
    }
    if(path==='/history/job')return put({job:{outputs:{11:{images:[{filename:'frame.png',type:'temp'}]}}}});
    if(path==='/view')return new Response(new Blob(['pixels'],{type:'image/png'}));
    throw Error('unexpected '+path);
  };
  try{
    const endpoint='https://example.test';
    await comfy.renderLive({...settings,endpoint,input:'text',quality:'preview'});
    assert.deepEqual(calls.splice(0),['/prompt','/history/job','/view']);
    await comfy.renderLive({...settings,endpoint,input:'image',quality:'preview',sourceImage:new Blob(['pixels'],{type:'image/png'})});
    assert.deepEqual(calls,['/upload/image','/prompt','/history/job','/view']);
  }finally{global.fetch=originalFetch;}
});

test('the queue keeps one running render, drops intermediate frames, and gives the HD snapshot priority',async()=>{
  const started=[],completed=[], release=[];
  const queue=live.createQueue({
    execute:job=>{started.push(job.key);return new Promise(resolve=>release.push(resolve));},
    onResult:job=>completed.push(job.key)
  });
  const job=(key,quality='preview')=>({key,quality,route:'a'});
  queue.enqueue(job('first'));
  queue.enqueue(job('middle'));
  queue.enqueue(job('latest'));
  queue.enqueue(job('hd','final'));
  assert.deepEqual(started,['first']);
  release.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,['first','hd']);
  release.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,['first','hd','latest']);
  release.shift()();await queue.whenIdle();
  assert.deepEqual(completed,['first','hd','latest']);
});

test('undoing back to the currently rendering snapshot drops the queued stale frame',async()=>{
  const started=[];
  let release;
  const queue=live.createQueue({
    execute:job=>{
      started.push(job.key);
      if(job.key==='a')return new Promise(resolve=>{release=resolve;});
    }
  });
  queue.enqueue({route:'n',key:'a',quality:'preview'});
  queue.enqueue({route:'n',key:'b',quality:'preview'});
  queue.enqueue({route:'n',key:'a',quality:'preview'});
  release();
  await queue.whenIdle();
  assert.deepEqual(started,['a']);
});

test('results from old connections are discarded while the latest connection can still finish',async()=>{
  let route='a', resolveA;
  const displayed=[];
  const queue=live.createQueue({
    execute:job=>job.route==='a'?new Promise(resolve=>{resolveA=resolve;}):Promise.resolve(),
    accepts:job=>job.route===route,
    onResult:job=>displayed.push(job.key)
  });
  queue.enqueue({key:'old',quality:'preview',route:'a'});
  route='b';
  queue.enqueue({key:'new',quality:'preview',route:'b'});
  resolveA();
  await queue.whenIdle();
  assert.deepEqual(displayed,['new']);
});

test('a timed-out preview releases the queue and ignores a late result', {timeout:1000}, async()=>{
  let finishStalled,stalledSignal;
  const results=[],errors=[];
  const queue=live.createQueue({
    timeoutFor:job=>job.key==='stalled'?15:0,
    execute:(job,signal)=>{
      if(job.key!=='stalled')return 'ready';
      stalledSignal=signal;
      return new Promise(resolve=>{finishStalled=resolve;});
    },
    onResult:job=>results.push(job.key),
    onError:(job,error)=>errors.push([job.key,error.name])
  });
  queue.enqueue({route:'r',key:'stalled',quality:'preview'});
  queue.enqueue({route:'r',key:'fresh',quality:'preview'});
  await queue.whenIdle();
  assert.equal(stalledSignal.aborted,true);
  finishStalled('stale image');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(results,['fresh']);
  assert.deepEqual(errors,[['stalled','TimeoutError']]);
});

test('canceling an automatic final preserves the newest preview and reports no rendering error', {timeout:1000}, async()=>{
  const results=[],errors=[];
  let canceledSignal;
  const queue=live.createQueue({
    execute:(job,signal)=>{
      if(job.quality==='preview')return 'ready';
      canceledSignal=signal;
      return new Promise(()=>{});
    },
    onResult:job=>results.push(job.key),
    onError:(job,error)=>errors.push(error)
  });
  queue.enqueue({route:'r',key:'old',quality:'final',automatic:true});
  queue.enqueue({route:'r',key:'new',quality:'preview'});
  queue.cancelRunning(job=>!job.automatic);
  await queue.whenIdle();
  assert.equal(canceledSignal.aborted,true);
  assert.deepEqual(results,['new']);
  assert.deepEqual(errors,[]);
});

