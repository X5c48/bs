const test = require('node:test');
const assert = require('node:assert/strict');
const { testConnection, generate } = require('./dist/comfy.js');

const endpoint = 'http://localhost:8188';
const sketch = new Blob(['sketch'], { type: 'image/png' });
const resultImage = new Blob(['rendered image'], { type: 'image/png' });

test('native upscale uses the ComfyArt model when available and exact Lanczos target dimensions', async t=>{
  const {runImageTool}=require('./dist/comfy.js');
  for(const models of [['4x-UltraSharp.pth'],[]]){
    const fetch=t.mock.method(global,'fetch',async (url,init)=>{
      const {pathname}=new URL(url);
      if(pathname==='/object_info/UpscaleModelLoader') return Response.json({UpscaleModelLoader:{input:{required:{model_name:[models]}}}});
      if(pathname==='/upload/image') return Response.json({name:'lamp.png',type:'temp'});
      if(pathname==='/prompt'){
        const graph=JSON.parse(init.body).prompt;
        assert.equal(Object.values(graph).some(node=>node.class_type==='ImageUpscaleWithModel'),!!models.length);
        const resize=Object.values(graph).find(node=>node.class_type==='ImageScale').inputs;
        assert.deepEqual([resize.width,resize.height,resize.upscale_method],[640,480,'lanczos']);
        assert.equal(graph['11'].class_type,'SaveImage');
        const [, join]=Object.entries(graph).find(([,node])=>node.class_type==='JoinImageWithAlpha');
        assert.equal(graph[join.inputs.alpha[0]].class_type,'ImageToMask');
        return Response.json({prompt_id:'upscale'});
      }
      if(pathname==='/history/upscale') return Response.json({upscale:{outputs:{'11':{images:[{filename:'studio.png'}]}}}});
      if(pathname==='/view') return new Response(resultImage);
      throw new Error('Unexpected route '+pathname);
    });
    const result=await runImageTool({kind:'upscale',endpoint,sourceImage:sketch,size:{width:640,height:480}});
    assert.equal(await result.blob.text(),'rendered image');
    fetch.mock.restore();
  }
});

test('native cutout uses the BiRefNet alpha graph and explains missing model before upload', async t=>{
  const {runImageTool}=require('./dist/comfy.js');
  let installed=false, reachedPrompt=false;
  t.mock.method(global,'fetch',async (url,init)=>{
    const {pathname}=new URL(url);
    if(pathname==='/object_info/LoadBackgroundRemovalModel'){
      return Response.json({LoadBackgroundRemovalModel:{input:{required:{bg_removal_name:[installed?['birefnet.safetensors']:[]]}}}});
    }
    if(pathname==='/upload/image') return Response.json({name:'lamp.png',type:'temp'});
    if(pathname==='/prompt'){
      const graph=JSON.parse(init.body).prompt;
      assert.equal(graph['19:14'].inputs.bg_removal_name,'birefnet.safetensors');
      assert.equal(graph['19:16'].class_type,'JoinImageWithAlpha');
      reachedPrompt=true;
      return Response.json({prompt_id:'cutout'});
    }
    if(pathname==='/history/cutout') return Response.json({cutout:{outputs:{'11':{images:[{filename:'alpha.png'}]}}}});
    if(pathname==='/view') return new Response(resultImage);
    throw new Error('Unexpected route '+pathname);
  });
  const request={kind:'cutout',endpoint,sourceImage:sketch,size:{width:320,height:240}};
  await assert.rejects(runImageTool(request),/BiRefNet/);
  assert.equal(reachedPrompt,false);
  installed=true;
  assert.equal((await runImageTool(request)).blob.type,'image/png');
  assert.equal(reachedPrompt,true);
});


test('regional edits use the selected source pixels and a separate mask', async (t) => {
  const { renderRegion } = require('./dist/comfy.js');
  const source = new Blob(['selected-image-B'], { type: 'image/png' });
  const mask = new Blob(['selection-mask'], { type: 'image/png' });
  const uploaded = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/upload/image') {
      const data = await init.body.get('image').text();
      uploaded.push(data);
      return Response.json({ name: data + '.png', type: 'temp' });
    }
    if (pathname === '/prompt') {
      const graph = JSON.parse(init.body).prompt;
      const node = name => Object.entries(graph).find(([, value]) => value.class_type === name);
      const [, sampler] = node('KSampler');
      const [latentId, latent] = node('SetLatentNoiseMask');
      const [maskId, maskNode] = node('ImageToMask');
      assert.equal(maskNode.inputs.channel, 'red');
      assert.equal(graph[maskNode.inputs.image[0]].inputs.image, 'selection-mask.png [temp]');
      assert.deepEqual(latent.inputs.mask, [maskId, 0]);
      const [, encode] = node('VAEEncode');
      assert.equal(graph[encode.inputs.pixels[0]].inputs.image, 'selected-image-B.png [temp]');
      assert.deepEqual(sampler.inputs.latent_image, [latentId, 0]);
      assert.equal(sampler.inputs.denoise, 0.72);
      return Response.json({ prompt_id: 'region-job' });
    }
    if (pathname === '/history/region-job') {
      return Response.json({ 'region-job': { outputs: { 11: { images: [{ filename: 'edit.png', type: 'temp' }] } } } });
    }
    if (pathname === '/view') return new Response(resultImage);
    assert.fail('Unexpected route ' + pathname);
  });
  const result = await renderRegion({
    endpoint, checkpoint: 'sd15.safetensors', prompt: 'brushed copper', denoise: 0.72,
    sourceImage: source, maskImage: mask, slot: 'region-test'
  });
  assert.deepEqual(uploaded, ['selected-image-B', 'selection-mask']);
  assert.equal(result.promptId, 'region-job');
  assert.equal(await result.blob.text(), 'rendered image');
});

const settings = {
  endpoint,
  checkpoint: 'sd15.safetensors',
  controlnet: 'scribble.safetensors',
  strength: 0.86,
  prompt: 'blue radio, brushed aluminum, studio lighting',
  negative: 'changed shape',
  sketch
};

test('lists installed model choices through native routes', async (t) => {
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(init.mode, 'cors');
    assert.equal(init.credentials, 'omit');
    if (url === 'https://comfy.example/proxy/models/checkpoints') {
      return Response.json(['sd15.safetensors']);
    }
    if (url === 'https://comfy.example/proxy/models/diffusion_models') {
      return new Response(null, { status: 404 });
    }
    assert.equal(url, 'https://comfy.example/proxy/models/controlnet');
    return Response.json(['scribble.safetensors']);
  });
  assert.deepEqual(await testConnection('https://comfy.example/proxy/'), {
    checkpoints: ['sd15.safetensors'], controlnets: ['scribble.safetensors'], qwen: []
  });
});

test('uploads the sketch and runs a scribble-conditioned workflow', async (t) => {
  const statuses = [];
  const paths = [];
  let saveNodeId;
  t.mock.method(global, 'fetch', async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    paths.push(pathname);
    switch (pathname) {
      case '/upload/image': {
        assert.equal(init.method, 'POST');
        assert.equal(init.body.get('image').type, 'image/png');
        assert.equal(await init.body.get('image').text(), 'sketch');
        assert.equal(init.body.get('type'), 'input');
        return Response.json({ name: 'sketch.png', subfolder: 'wuying' });
      }
      case '/prompt': {
        const { prompt } = JSON.parse(init.body);
        const byClass = (name) => Object.entries(prompt).find(([, node]) => node.class_type === name);
        const [loadId, load] = byClass('LoadImage');
        const [invertId, invert] = byClass('ImageInvert');
        const [controlId, control] = byClass('ControlNetLoader');
        const [applyId, apply] = byClass('ControlNetApplyAdvanced');
        const [latentId, latent] = byClass('EmptyLatentImage');
        assert.equal(byClass('CheckpointLoaderSimple')[1].inputs.ckpt_name, settings.checkpoint);
        assert.equal(load.inputs.image, 'wuying/sketch.png');
        assert.deepEqual(invert.inputs.image, [loadId, 0]);
        assert.equal(control.inputs.control_net_name, settings.controlnet);
        assert.deepEqual(apply.inputs.image, [invertId, 0]);
        assert.deepEqual(apply.inputs.control_net, [controlId, 0]);
        assert.equal(apply.inputs.strength, settings.strength);
        assert.equal(prompt[apply.inputs.positive[0]].inputs.text, settings.prompt);
        assert.equal(prompt[apply.inputs.negative[0]].inputs.text, settings.negative);
        assert.equal(latent.inputs.width / latent.inputs.height, 1.25);
        const sample = byClass('KSampler')[1];
        assert.deepEqual(sample.inputs.positive, [applyId, 0]);
        assert.deepEqual(sample.inputs.negative, [applyId, 1]);
        assert.deepEqual(sample.inputs.latent_image, [latentId, 0]);
        [saveNodeId] = byClass('SaveImage');
        return Response.json({ prompt_id: 'job-123' });
      }
      case '/history/job-123':
        return Response.json({
          'job-123': { outputs: { [saveNodeId]: { images: [{ filename: 'final.png', subfolder: 'render', type: 'output' }] } } }
        });
      case '/view':
        assert.deepEqual(Object.fromEntries(searchParams), {
          filename: 'final.png', subfolder: 'render', type: 'output'
        });
        return new Response(resultImage);
      default:
        assert.fail('Unexpected route ' + pathname);
    }
  });
  const result = await generate({ ...settings, onStatus: (status) => statuses.push(status) });
  assert.equal(result.promptId, 'job-123');
  assert.equal(await result.blob.text(), 'rendered image');
  assert.deepEqual(paths, ['/upload/image', '/prompt', '/history/job-123', '/view']);
  assert.equal(statuses.length, 4);
  assert.ok(statuses.every((status) => typeof status === 'string' && status.length > 0));
});

test('reports validation, network, and execution errors', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', async (url) => {
    switch (new URL(url).pathname) {
      case '/upload/image': return Response.json({ name: 'sketch.png' });
      case '/prompt': return Response.json({ prompt_id: 'bad-job' });
      case '/history/bad-job':
        return Response.json({
          'bad-job': { status: { status_str: 'error', messages: [['execution_error', {
            exception_message: 'CUDA out of memory'
          }]] } }
        });
      default: throw new TypeError('Failed to fetch');
    }
  });
  await assert.rejects(testConnection('http://192.168.0.2:8188'), /HTTPS/);
  await assert.rejects(testConnection('https://user:secret@comfy.example'), /凭据/);
  assert.equal(fetchMock.mock.callCount(), 0);
  await assert.rejects(testConnection(endpoint), /CORS/);
  await assert.rejects(generate(settings), /CUDA out of memory/);
});

test('cancelled requests reject as AbortError before contacting ComfyUI', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', async () => assert.fail('Unexpected fetch'));
  await assert.rejects(generate({ ...settings, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('polling waits for a queued job and can be cancelled', async (t) => {
  const controller = new AbortController();
  const paths = [];
  t.mock.method(global, 'fetch', async (url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    switch (pathname) {
      case '/upload/image': return Response.json({ name: 'sketch.png' });
      case '/prompt': return Response.json({ prompt_id: 'pending-job' });
      case '/history/pending-job':
        setTimeout(() => controller.abort(), 0);
        return Response.json({});
      default: assert.fail('Unexpected route ' + pathname);
    }
  });
  await assert.rejects(generate({ ...settings, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(paths, ['/upload/image', '/prompt', '/history/pending-job']);
});

test('Krea 2 reads native model options and sends a text-only Turbo workflow', async (t) => {
  const {testKreaConnection,renderKrea} = require('./dist/comfy.js');
  const fields={
    UNETLoader:{unet_name:[['krea/krea2_turbo_fp8_scaled.safetensors']]},
    CLIPLoader:{type:[['stable_diffusion','krea2']],clip_name:[['qwen3vl_4b_fp8_scaled.safetensors']]},
    VAELoader:{vae_name:[['qwen_image_vae.safetensors']]}
  };
  const routes=[];
  t.mock.method(global,'fetch',async (url,options)=>{
    const path=new URL(url).pathname;
    routes.push(path);
    if(path.startsWith('/object_info/')){
      const name=path.split('/').at(-1);
      return Response.json({[name]:{input:{required:fields[name]}}});
    }
    if(path==='/prompt'){
      const graph=JSON.parse(options.body).prompt;
      assert.ok(Object.values(graph).every(node=>node.class_type!=='LoadImage'));
      assert.equal(graph[1].inputs.unet_name,'krea/krea2_turbo_fp8_scaled.safetensors');
      assert.equal(graph[2].inputs.type,'krea2');
      assert.equal(graph[9].inputs.steps,8);
      assert.deepEqual([graph[8].inputs.width,graph[8].inputs.height],[1280,1024]);
      return Response.json({prompt_id:'krea-job'});
    }
    if(path==='/history/krea-job')return Response.json({'krea-job':{outputs:{11:{images:[{filename:'krea.png'}]}}}});
    if(path==='/view')return new Response(new Blob(['rendered'],{type:'image/png'}));
    assert.fail('Unexpected route '+path);
  });
  const krea=await testKreaConnection(endpoint);
  const job={endpoint,krea,quality:'final',seed:6,prompt:'product concept'};
  await assert.rejects(renderKrea({...job,input:'sketch'}),/文字输入/);
  assert.equal((await renderKrea({...job,input:'text'})).promptId,'krea-job');
  assert.ok(!routes.includes('/upload/image'));
});

test('surfaces native prompt validation details', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    if (new URL(url).pathname === '/upload/image') return Response.json({ name: 'sketch.png' });
    return Response.json({
      error: { message: 'Prompt outputs failed validation' },
      node_errors: { 6: { errors: [{ details: 'Scribble model is missing' }] } }
    }, { status: 400 });
  });
  await assert.rejects(generate(settings), /HTTP 400。Scribble model is missing/);
});

test('uses the conditioning format expected by each sketch ControlNet', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const graph = (controlnet) => liveWorkflow({ ...settings, input:'sketch', inputImage:'lines.png', quality:'preview', controlnet });
  const scribble = graph('control_v11p_sd15_scribble.safetensors');
  assert.equal(scribble[5].class_type, 'ImageInvert');
  assert.deepEqual(scribble[7].inputs.image, ['5', 0]);
  const lineart = graph('mistoline_rank256.safetensors');
  assert.deepEqual(lineart[7].inputs.image, ['4', 0]);
  assert.equal(lineart[5], undefined);
  const canny = graph('control_v11p_sd15_canny.safetensors');
  assert.equal(canny[5].class_type, 'Canny');
  assert.deepEqual(canny[7].inputs.image, ['5', 0]);
});

test('combines a color guide latent with separate line conditioning in both preview and HD passes', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const job = { ...settings, input:'sketch', inputImage:'lines.png', colorGuide:'colors.png', seed:13 };
  const preview = liveWorkflow({ ...job, quality:'preview' });
  const final = liveWorkflow({ ...job, quality:'final' });
  assert.equal(preview[7].class_type,'ControlNetApplyAdvanced');
  const [scaleId] = preview[8].inputs.pixels;
  const [guideId] = preview[scaleId].inputs.image;
  assert.equal(preview[guideId].inputs.image,'colors.png');
  assert.equal(preview[4].inputs.image,'lines.png');
  assert.deepEqual(preview[9].inputs.positive,['7',0]);
  assert.deepEqual(final[13].inputs.positive,['7',0]);
  assert.deepEqual(final[9],preview[9]);
  const sketch = (strength) => liveWorkflow({ ...job, colorGuide:undefined, controlnet:'', strength, quality:'preview' });
  assert.ok(sketch(.9)[9].inputs.denoise < sketch(.2)[9].inputs.denoise);
});

test('uses distinct temporary files for the line and color images in every live attempt', async (t) => {
  const { renderLive } = require('./dist/comfy.js');
  const uploads = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    switch (new URL(url).pathname) {
      case '/upload/image': {
        const file = init.body.get('image');
        assert.equal(init.body.get('type'),'temp');
        assert.equal(init.body.get('overwrite'),'false');
        uploads.push({ name:file.name, data:await file.text() });
        return Response.json({ name:file.name, type:'temp', subfolder:'wuying-live' });
      }
      case '/prompt': {
        const { prompt } = JSON.parse(init.body);
        const files = Object.values(prompt).filter(node => node.class_type==='LoadImage').map(node => node.inputs.image);
        assert.deepEqual(files,uploads.slice(-2).map(file=>'wuying-live/'+file.name+' [temp]'));
        return Response.json({prompt_id:'live-job'});
      }
      case '/history/live-job':
        return Response.json({'live-job':{outputs:{11:{images:[{filename:'live.png',type:'temp'}]}}}});
      case '/view': return new Response(resultImage);
      default: assert.fail('Unexpected '+url);
    }
  });
  const job = { ...settings, input:'sketch', sourceImage:sketch,
    colorGuideImage:new Blob(['guide'],{type:'image/png'}), quality:'preview', slot:'view-1' };
  await renderLive(job);
  await renderLive(job);
  assert.deepEqual(uploads.map(file=>file.data),['sketch','guide','sketch','guide']);
  assert.equal(new Set(uploads.map(file=>file.name)).size,4);
});

for (const legacy of [false, true]) {
  test(legacy ? 'older ComfyUI deletes only our queued prompt' : 'ComfyUI cancels only our job by ID', async (t) => {
    const { renderLive } = require('./dist/comfy.js');
    const abort = new AbortController();
    const paths = [];
    t.mock.method(global, 'fetch', async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/prompt') return Response.json({ prompt_id: 'our/id' });
      if (path === '/history/our%2Fid') {
        abort.abort();
        return Response.json({});
      }
      if (path === '/api/jobs/our%2Fid/cancel') {
        assert.equal(init.method, 'POST');
        assert.equal(init.signal.aborted, false);
        return new Response(null, { status: legacy ? 404 : 200 });
      }
      if (legacy && path === '/queue') {
        assert.deepEqual(JSON.parse(init.body), { delete: ['our/id'] });
        assert.equal(init.signal.aborted, false);
        return new Response(null, { status: 200 });
      }
      assert.fail('Unexpected ' + path);
    });
    await assert.rejects(renderLive({ ...settings, input: 'text', quality: 'preview', signal: abort.signal }), { name: 'AbortError' });
    await new Promise(setImmediate);
    const expected = ['/prompt', '/history/our%2Fid', '/api/jobs/our%2Fid/cancel'];
    if (legacy) expected.push('/queue');
    assert.deepEqual(paths, expected);
  });
}

test('stopping while the live submission is acknowledged still cancels its job', async (t) => {
  const { renderLive } = require('./dist/comfy.js');
  const abort = new AbortController();
  const paths = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/prompt') {
      abort.abort();
      assert.equal(init.signal.aborted, false);
      return Response.json({ prompt_id: 'just-submitted' });
    }
    if (path === '/api/jobs/just-submitted/cancel') return new Response(null, { status: 200 });
    assert.fail('Unexpected ' + path);
  });
  await assert.rejects(renderLive({ ...settings, input: 'text', quality: 'preview', signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(paths, ['/prompt', '/api/jobs/just-submitted/cancel']);
});

test('the CyberRealistic HD workflow preserves image detail through pixel-space scaling', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const options={ ...settings, checkpoint:'CyberRealistic_FINAL_FP16.safetensors', input:'sketch', inputImage:'ink.png' };
  const preview=liveWorkflow({ ...options, quality:'preview' });
  const final=liveWorkflow({ ...options, quality:'final' });
  assert.equal(preview[9].inputs.steps,12);
  assert.equal(final[9].inputs.sampler_name,'dpmpp_2m');
  assert.equal(final[16].class_type,'VAEDecode');
  assert.deepEqual(final[16].inputs.samples,['9',0]);
  assert.equal(final[17].class_type,'ImageScale');
  assert.deepEqual(final[17].inputs,{image:['16',0],upscale_method:'lanczos',width:1280,height:1024,crop:'disabled'});
  assert.equal(final[12].class_type,'VAEEncode');
  assert.deepEqual(final[13].inputs.latent_image,['12',0]);
});

test('实时辅助档用更少步数，最终档不变', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const base = { input:'sketch', checkpoint:'v1-5.safetensors', controlnet:'scribble.safetensors', strength:.6, prompt:'x', inputImage:'a.png', seed:1 };
  const steps = quality => Object.values(liveWorkflow({ ...base, quality })).find(n => n.class_type === 'KSampler').inputs.steps;
  assert.equal(steps('live'), 10);
  assert.equal(steps('preview'), 12);
  assert.equal(steps('live') < steps('preview'), true);
  const turbo = Object.values(liveWorkflow({ ...base, checkpoint:'sdxl_turbo.safetensors', quality:'live' })).find(n => n.class_type === 'KSampler').inputs.steps;
  assert.equal(turbo, 4);
});


test('实时三档：步数递增、采样器统一、latent 尺寸等比且 8 对齐', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const base = { input:'sketch', checkpoint:'v1-5.safetensors', controlnet:'scribble.safetensors', strength:.6, prompt:'x', inputImage:'a.png', colorGuide:'b.png', seed:1, quality:'live' };
  const sample = opts => Object.values(liveWorkflow({ ...base, ...opts })).find(n => n.class_type === 'KSampler').inputs;
  assert.equal(sample({ tier:'speed' }).steps, 6);
  assert.equal(sample({ tier:'balanced' }).steps, 10);
  assert.equal(sample({ tier:'quality' }).steps, 16);
  for (const tier of ['speed','balanced','quality']) {
    assert.equal(sample({ tier }).sampler_name, 'dpmpp_2m');
    assert.equal(sample({ tier }).scheduler, 'karras');
  }
  const cyber = tier => Object.values(liveWorkflow({ ...base, checkpoint:'CyberRealistic_FINAL.safetensors', tier })).find(n => n.class_type === 'KSampler').inputs.steps;
  assert.equal(cyber('speed'), 8); assert.equal(cyber('balanced'), 12); assert.equal(cyber('quality'), 20);
  // latent 尺寸跟随档位，且保持 1280×1024 的 5:4 比例、8 对齐
  for (const [w,h] of [[640,512],[800,640],[960,768]]) {
    const g = liveWorkflow({ ...base, latentWidth:w, latentHeight:h });
    const scale = Object.values(g).find(n => n.class_type === 'ImageScale');
    assert.equal(scale.inputs.width, w); assert.equal(scale.inputs.height, h);
    assert.equal(w % 8, 0); assert.equal(h % 8, 0);
    assert.ok(Math.abs(w / h - 1280 / 1024) < 1e-9, '比例必须等于 5:4，否则裁切会变形');
  }
  // preview / final 不受影响
  assert.equal(sample({ quality:'preview' }).steps, 12);
});

test('高清增强档：latent 跟随档位，二次采样固定放大到 1280×1024 并落盘保存', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const base = { input:'sketch', checkpoint:'v1-5.safetensors', controlnet:'scribble.safetensors', strength:.6, prompt:'x', inputImage:'a.png', colorGuide:'b.png', seed:1 };
  const graph = liveWorkflow({ ...base, colorGuide:undefined, quality:'final', tier:'quality', latentWidth:960, latentHeight:768 });
  assert.equal(graph[8].class_type, 'EmptyLatentImage');
  assert.equal(graph[8].inputs.width, 960);
  assert.equal(graph[8].inputs.height, 768);
  const upscale = Object.values(graph).find(n => n.class_type === 'LatentUpscale');
  assert.equal(upscale.inputs.width, 1280);
  assert.equal(upscale.inputs.height, 1024);
  const saved = Object.values(graph).find(n => n.class_type === 'SaveImage');
  assert.equal(saved.inputs.filename_prefix, 'Wuying/hd');
  // CyberRealistic 走像素空间 lanczos 放大再编码，同样锁定 1280×1024
  const cyber = liveWorkflow({ ...base, checkpoint:'CyberRealistic_FINAL.safetensors', quality:'final', tier:'speed', latentWidth:640, latentHeight:512 });
  const scales = Object.values(cyber).filter(n => n.class_type === 'ImageScale');
  const hd = scales.find(n => n.inputs.width === 1280);
  assert.ok(hd, 'CyberRealistic 高清档必须有 1280×1024 的 lanczos 放大');
  assert.equal(hd.inputs.upscale_method, 'lanczos');
});

test('Qwen-Image-2.1 工作流：Turbo 8 级 sigma、CFG 1、latent 取编码器输出、保存节点对齐', () => {
  const { qwenWorkflow } = require('./dist/comfy.js');
  const graph = qwenWorkflow({ checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors', prompt:'a lamp', seed:7 });
  assert.equal(graph['1'].class_type, 'UNETLoader');
  assert.equal(graph['1'].inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors');
  assert.equal(graph['3'].class_type, 'CLIPLoader');
  assert.equal(graph['3'].inputs.type, 'qwen_image');
  assert.equal(graph['3'].inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors');
  const encode = graph['5'];
  assert.equal(encode.class_type, 'TextEncodeQwenImage21');
  assert.equal(encode.inputs.resolution, 1024);
  assert.ok(!('images' in encode.inputs), '无参考时不应带 images');
  const guider = graph['8'];
  assert.equal(guider.class_type, 'CFGGuider');
  assert.equal(guider.inputs.cfg, 1);
  assert.deepEqual(guider.inputs.positive, ['5', 0]);
  assert.deepEqual(guider.inputs.negative, ['5', 1]);
  const sigmas = graph['9'].inputs.sigmas.split(',').map(Number);
  assert.equal(sigmas.length, 9, 'turbo 固定 8 步（9 级 sigma）');
  const sampler = graph['10'];
  assert.equal(sampler.class_type, 'SamplerCustomAdvanced');
  assert.deepEqual(sampler.inputs.latent_image, ['5', 2], 'latent 必须取编码器输出，跟随参考图长宽比');
  assert.equal(graph['11'].class_type, 'SaveImage');
  assert.equal(graph['11'].inputs.filename_prefix, 'Wuying/qwen21');
  assert.equal(graph['14'], undefined);
});

test('Qwen-Image-2.1 带参考图：LoadImage 供图且以 autogrow 字典接到编码器 images 槽', () => {
  const { qwenWorkflow } = require('./dist/comfy.js');
  const graph = qwenWorkflow({ checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors', prompt:'a lamp', reference:'wuying-live/input-1.png [temp]', seed:1 });
  assert.equal(graph['14'].class_type, 'LoadImage');
  assert.equal(graph['14'].inputs.image, 'wuying-live/input-1.png [temp]');
  assert.deepEqual(graph['5'].inputs.images, { image_1: ['14', 0] });
});

test('Qwen-Image-2.1 校验：非 qwen 模型、缺提示词、缺端点都要拦截', async () => {
  const { renderQwen } = require('./dist/comfy.js');
  await assert.rejects(renderQwen({ endpoint:'http://localhost:8188', checkpoint:'v1-5.safetensors', prompt:'x' }), /Qwen-Image-2\.1/);
  await assert.rejects(renderQwen({ endpoint:'http://localhost:8188', checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors', prompt:'  ' }), /画面描述/);
  await assert.rejects(renderQwen({ endpoint:'', checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors', prompt:'x' }), /ComfyUI/);
});

test('Qwen-Image-2.1 渲染：上传参考图后提交正确工作流并取回结果', async t => {
  const { renderQwen } = require('./dist/comfy.js');
  let submitted;
  const fetch = t.mock.method(global, 'fetch', async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/upload/image') return Response.json({ name:'lamp.png', type:'temp', subfolder:'wuying-live' });
    if (pathname === '/prompt') {
      submitted = JSON.parse(init.body).prompt;
      return Response.json({ prompt_id:'qwen-job' });
    }
    if (pathname === '/history/qwen-job') return Response.json({ 'qwen-job': { outputs: { '11': { images: [{ filename:'qwen.png' }] } } } });
    if (pathname === '/view') return new Response(resultImage);
    throw new Error('Unexpected route ' + pathname);
  });
  const result = await renderQwen({ endpoint, checkpoint:'qwen_image_2.1_turbo_int8_convrot.safetensors', prompt:'a lamp', sourceImage:sketch, seed:42, slot:'live-x' });
  assert.equal(await result.blob.text(), 'rendered image');
  assert.equal(submitted['5'].class_type, 'TextEncodeQwenImage21');
  assert.equal(submitted['14'].class_type, 'LoadImage');
  assert.ok(submitted['14'].inputs.image.startsWith('wuying-live/lamp.png'));
  assert.equal(submitted['7'].inputs.noise_seed, 42);
  fetch.mock.restore();
});

test('连接检测把 Qwen-Image-2.1 diffusion 模型并入基础模型列表，老版本端点缺失可容错', async t => {
  const { testConnection } = require('./dist/comfy.js');
  for (const [diffusion, expectQwen] of [
    [[{ not:'array' }], false],
    [['sd_xl.safetensors', 'qwen_image_2.1_turbo_int8_convrot.safetensors'], true],
    [['only_sd.safetensors'], false]
  ]) {
    const fetch = t.mock.method(global, 'fetch', async url => {
      const { pathname } = new URL(url);
      if (pathname === '/models/checkpoints') return Response.json(['v1-5.safetensors']);
      if (pathname === '/models/controlnet') return Response.json(['scribble.safetensors']);
      if (pathname === '/models/diffusion_models') {
        if (Array.isArray(diffusion)) return Response.json(diffusion);
        return new Response(null, { status: 404 });
      }
      throw new Error('Unexpected route ' + pathname);
    });
    const found = await testConnection('http://localhost:8188');
    fetch.mock.restore();
    assert.equal(found.checkpoints.includes('qwen_image_2.1_turbo_int8_convrot.safetensors'), expectQwen);
    assert.equal(found.checkpoints[0], 'v1-5.safetensors');
    assert.equal(found.qwen.length, expectQwen ? 1 : 0);
  }
});
