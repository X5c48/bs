(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 30_000;
  const GENERATION_TIMEOUT_MS = 300_000;
  const POLL_INTERVAL_MS = 1_500;
  const SAVE_NODE_ID = '11';

  function endpointBase(endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('请输入完整的 ComfyUI 地址，例如 http://127.0.0.1:8188。');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new Error('远程 ComfyUI 地址必须使用 HTTPS，本机可使用 HTTP。');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('ComfyUI 地址请勿包含登录凭据、查询参数或片段。');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  function serverError(payload) {
    const node = Object.values(payload?.node_errors || {})[0];
    const detail = node?.errors?.[0];
    const message = detail?.details || detail?.message || payload?.error?.message;
    return typeof message === 'string' ? message.slice(0, 280) : '';
  }

  async function request(base, path, signal, options = {}) {
    const { image = false, empty = false, ...init } = options;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    requestSignal.throwIfAborted();

    try {
      const response = await fetch(base + path, {
        ...init,
        signal: requestSignal,
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        cache: 'no-store'
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        requestSignal.throwIfAborted();
        const detail = serverError(payload);
        throw Object.assign(
          new Error('ComfyUI 返回 HTTP ' + response.status + (detail ? '。' + detail : '。')),
          { status: response.status }
        );
      }
      if (empty) return;
      if (image) {
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) {
          throw new Error('ComfyUI 返回的文件无法识别为图像。');
        }
        return blob;
      }
      return await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new Error('连接 ComfyUI 超时，请检查服务是否可用。');
      if (error instanceof SyntaxError) throw new Error('ComfyUI 返回了无效响应，请检查服务地址。');
      if (error instanceof TypeError) {
        throw new Error('无法连接 ComfyUI。请检查服务地址、CORS 设置和浏览器的本地网络访问权限。');
      }
      throw error;
    }
  }

  async function testConnection(endpoint, { signal } = {}) {
    const base = endpointBase(endpoint);
    const [checkpoints, controlnets] = await Promise.all([
      request(base, '/models/checkpoints', signal),
      request(base, '/models/controlnet', signal)
    ]);
    if (!Array.isArray(checkpoints) || !Array.isArray(controlnets)
        || [...checkpoints, ...controlnets].some((name) => typeof name !== 'string')) {
      throw new Error('ComfyUI 返回了无效的模型列表。');
    }
    return { checkpoints, controlnets };
  }

  async function testKreaConnection(endpoint, { signal } = {}) {
    const base = endpointBase(endpoint);
    const types = ['UNETLoader', 'CLIPLoader', 'VAELoader'];
    const schemas = await Promise.all(types.map(type => request(base, '/object_info/' + type, signal)));
    const [unetFields, clipFields, vaeFields] = schemas.map((schema, i) => schema?.[types[i]]?.input?.required);
    if (!clipFields?.type?.[0]?.includes('krea2')) {
      throw new Error('此 ComfyUI 版本缺少 Krea 2 支持。');
    }
    const find = (field, pattern) => {
      const names = Array.isArray(field?.[0]) ? field[0] : [];
      const matches = names.filter(name => typeof name === 'string' && pattern.test(name.split(/[\\/]/).at(-1)));
      return matches.find(name => /fp8_scaled/i.test(name)) || matches[0];
    };
    const unet = find(unetFields?.unet_name, /^krea[-_ ]?2[_ -]*turbo.*\.safetensors$/i);
    const clip = find(clipFields?.clip_name, /^qwen3[-_ ]?vl[_ -]*4b.*\.safetensors$/i);
    const vae = find(vaeFields?.vae_name, /^qwen[_ -]image[_ -]vae.*\.safetensors$/i);
    if (!unet || !clip || !vae) {
      throw new Error('请在 ComfyUI 安装 Krea 2 Turbo、Qwen3VL 4B 文本编码器和 Qwen Image VAE。');
    }
    return { unet, clip, vae };
  }

  function workflow({ checkpoint, controlnet, strength, prompt, negative, image, seed }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    return {
      1: node('CheckpointLoaderSimple', { ckpt_name: checkpoint }),
      2: node('CLIPTextEncode', { clip: ['1', 1], text: prompt }),
      3: node('CLIPTextEncode', { clip: ['1', 1], text: negative }),
      4: node('LoadImage', { image }),
      5: node('ImageInvert', { image: ['4', 0] }),
      6: node('ControlNetLoader', { control_net_name: controlnet }),
      7: node('ControlNetApplyAdvanced', {
        positive: ['2', 0], negative: ['3', 0], control_net: ['6', 0], image: ['5', 0],
        strength, start_percent: 0, end_percent: 1
      }),
      8: node('EmptyLatentImage', { width: 640, height: 512, batch_size: 1 }),
      9: node('KSampler', {
        model: ['1', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['8', 0],
        seed, steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1
      }),
      10: node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] }),
      [SAVE_NODE_ID]: node('SaveImage', { images: ['10', 0], filename_prefix: 'Wuying/render' })
    };
  }

  // latentWidth/latentHeight：实时档分辨率，须为 modelWidth/modelHeight 的等比缩放且 8 对齐，
  // 这样 cropResult 仍按同一坐标系裁切，比例不会变形。tier 决定步数与画质。
  function liveWorkflow({input,quality,checkpoint,controlnet,strength,prompt,negative='',inputImage,colorGuide,seed,latentWidth=640,latentHeight=512,tier='balanced'}) {
    const node=(class_type,inputs)=>({class_type,inputs});
    const graph={
      1:node('CheckpointLoaderSimple',{ckpt_name:checkpoint}),
      2:node('CLIPTextEncode',{clip:['1',1],text:prompt}),
      3:node('CLIPTextEncode',{clip:['1',1],text:negative})
    };
    const lineControl=input==='sketch'&&!!controlnet;
    let positive=['2',0],negativeInput=['3',0],denoise=1;
    if(input!=='text')graph[4]=node('LoadImage',{image:inputImage});
    if(lineControl){
      if(/canny/i.test(controlnet)){
        graph[5]=node('Canny',{image:['4',0],low_threshold:.2,high_threshold:.5});
      }else if(!/line[ _-]?art|misto[ _-]?line/i.test(controlnet)){
        graph[5]=node('ImageInvert',{image:['4',0]});
      }
      graph[6]=node('ControlNetLoader',{control_net_name:controlnet});
      graph[7]=node('ControlNetApplyAdvanced',{
        positive,negative:negativeInput,control_net:['6',0],image:[graph[5]?'5':'4',0],
        strength,start_percent:0,end_percent:1,vae:['1',2]
      });
      positive=['7',0];negativeInput=['7',1];
    }
    if(input==='text'||(lineControl&&!colorGuide)){
      graph[8]=node('EmptyLatentImage',{width:latentWidth,height:latentHeight,batch_size:1});
    }else{
      const scaleId=lineControl?'15':'5';
      if(lineControl)graph[14]=node('LoadImage',{image:colorGuide});
      graph[scaleId]=node('ImageScale',{
        image:[lineControl?'14':'4',0],width:latentWidth,height:latentHeight,upscale_method:'bilinear',crop:'disabled'
      });
      graph[8]=node('VAEEncode',{pixels:[scaleId,0],vae:['1',2]});
      // Higher shape strength retains more of the incoming form in img2img.
      denoise=input==='sketch'?(lineControl?.85-strength*.14:.80-strength*.23):.62-strength*.30;
    }
    const turbo=/(?:^|[._ -])turbo(?:[._ -]|$)/i.test(checkpoint);
    const lcm=/(?:^|[._ -])lcm(?:[._ -]|$)/i.test(checkpoint);
    const cyberRealistic=/cyberrealistic/i.test(checkpoint)&&!turbo&&!lcm;
    // live 三档：speed 抢时间、balanced 默认、quality 堆细节。SD1.5 在 live 下同样用 dpmpp_2m + karras。
    const liveSteps=turbo?(tier==='quality'?6:4):lcm?(tier==='quality'?8:tier==='speed'?4:5)
      :cyberRealistic?(tier==='speed'?8:tier==='quality'?20:12)
      :(tier==='speed'?6:tier==='quality'?16:10);
    const liveSample=quality==='live';
    const sample={model:['1',0],positive,negative:negativeInput,seed,
      steps:liveSample?liveSteps:turbo?6:lcm?8:cyberRealistic&&quality==='final'?26:12,cfg:turbo?1:lcm?1.8:cyberRealistic?7:6.3,
      sampler_name:lcm?'lcm':(cyberRealistic||liveSample)?'dpmpp_2m':'euler',
      scheduler:turbo?'sgm_uniform':(cyberRealistic||liveSample)?'karras':'normal'};
    graph[9]=node('KSampler',{...sample,latent_image:['8',0],denoise});
    if(quality==='final'){
      if(cyberRealistic){
        graph[16]=node('VAEDecode',{samples:['9',0],vae:['1',2]});
        graph[17]=node('ImageScale',{image:['16',0],upscale_method:'lanczos',width:1280,height:1024,crop:'disabled'});
        graph[12]=node('VAEEncode',{pixels:['17',0],vae:['1',2]});
      }else{
        graph[12]=node('LatentUpscale',{samples:['9',0],upscale_method:'bilinear',width:1280,height:1024,crop:'disabled'});
      }
      graph[13]=node('KSampler',{...sample,latent_image:['12',0],steps:turbo?10:lcm?12:20,denoise:cyberRealistic?.34:.30});
    }
    graph[10]=node('VAEDecode',{samples:[quality==='final'?'13':'9',0],vae:['1',2]});
    graph[SAVE_NODE_ID]=quality==='final'
      ?node('SaveImage',{images:['10',0],filename_prefix:'Wuying/hd'})
      :node('PreviewImage',{images:['10',0]});
    return graph;
  }


  function kreaWorkflow({ quality, prompt, seed, krea }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    const final = quality === 'final';
    return {
      1: node('UNETLoader', { unet_name: krea.unet, weight_dtype: 'default' }),
      2: node('CLIPLoader', { clip_name: krea.clip, type: 'krea2', device: 'default' }),
      3: node('VAELoader', { vae_name: krea.vae }),
      4: node('CLIPTextEncode', { clip: ['2', 0], text: prompt }),
      5: node('ConditioningZeroOut', { conditioning: ['4', 0] }),
      8: node('EmptyLatentImage', { width: final ? 1280 : 1024, height: 1024, batch_size: 1 }),
      9: node('KSampler', { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['8', 0],
        seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 }),
      10: node('VAEDecode', { samples: ['9', 0], vae: ['3', 0] }),
      [SAVE_NODE_ID]: final
        ? node('SaveImage', { images: ['10', 0], filename_prefix: 'Wuying/krea2' })
        : node('PreviewImage', { images: ['10', 0] })
    };
  }

  function delay(signal,interval) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, interval);
      function cancel() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async function waitForImage(base, promptId, signal, interval) {
    const path = '/history/' + encodeURIComponent(promptId);
    while (true) {
      const history = await request(base, path, signal);
      const job = Object.hasOwn(history || {}, promptId) ? history[promptId] : null;
      if (job?.status?.status_str === 'error') {
        const failure = job.status.messages?.find(([event]) => event === 'execution_error'
          || event === 'execution_interrupted');
        const detail = failure?.[1]?.exception_message;
        throw new Error('ComfyUI 生成失败。' + (typeof detail === 'string' ? detail.slice(0, 280) : ''));
      }
      const image = job?.outputs?.[SAVE_NODE_ID]?.images?.[0];
      if (typeof image?.filename === 'string' && image.filename) return image;
      if (job?.status?.completed) throw new Error('ComfyUI 已完成任务，但没有返回图像。');
      await delay(signal,interval);
    }
  }

  async function runWorkflow({
    endpoint,inputBlob,guideBlob,maskBlob,signal,onStatus,build,slot,cancelPending=false,pollInterval=POLL_INTERVAL_MS
  }){
    signal?.throwIfAborted();
    const base=endpointBase(endpoint),deadline=AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const generationSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    const liveSlot=typeof slot==='string'&&/^[a-z0-9-]{1,100}$/i.test(slot);
    let promptId;
    async function uploadImage(blob,label){
      const random=crypto.getRandomValues(new Uint32Array(2));
      const name='wuying-'+(liveSlot?slot+'-':'')+label+'-'+random[0]+'-'+random[1]+'.png';
      const upload=new FormData();
      upload.set('image',blob,name);
      upload.set('type',liveSlot?'temp':'input');
      upload.set('overwrite','false');
      if(liveSlot)upload.set('subfolder','wuying-live');
      const uploaded=await request(base,'/upload/image',generationSignal,{method:'POST',body:upload});
      if(typeof uploaded?.name!=='string'||!uploaded.name)throw new Error('ComfyUI 未返回上传后的文件名。');
      const path=uploaded.subfolder?uploaded.subfolder+'/'+uploaded.name:uploaded.name;
      return path+(uploaded.type==='temp'?' [temp]':'');
    }
    try{
      let inputImage,colorGuide,maskImage;
      if(inputBlob){
        onStatus?.('正在上传画面…');
        inputImage=await uploadImage(inputBlob,'input');
      }
      if(guideBlob){
        onStatus?.('正在上传配色参考…');
        colorGuide=await uploadImage(guideBlob,'color');
      }
      if(maskBlob){
        onStatus?.('正在上传编辑选区…');
        maskImage=await uploadImage(maskBlob,'mask');
      }
      onStatus?.('正在提交生成任务…');
      generationSignal.throwIfAborted();
      // Let an already submitted live request return its ID so Stop can cancel it.
      const queued=await request(base,'/prompt',cancelPending?null:generationSignal,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:build(inputImage,colorGuide,maskImage)})
      });
      promptId=queued?.prompt_id;
      if(typeof promptId!=='string'||!promptId)throw new Error('ComfyUI 未返回任务编号。'+serverError(queued));
      generationSignal.throwIfAborted();
      onStatus?.('正在生成…');
      const output=await waitForImage(base,promptId,generationSignal,pollInterval);
      const params=new URLSearchParams({filename:output.filename,subfolder:output.subfolder||'',type:output.type||'output'});
      onStatus?.('正在下载生成结果…');
      const blob=await request(base,'/view?'+params,generationSignal,{image:true});
      return {blob,promptId};
    }catch(error){
      if(cancelPending&&promptId&&generationSignal.aborted){
        // Stop this job only. Older servers can only remove it while queued.
        void request(base,'/api/jobs/'+encodeURIComponent(promptId)+'/cancel',AbortSignal.timeout(3_000),{
          method:'POST',empty:true
        }).catch(error=>{
          if(error.status!==404&&error.status!==405)return;
          return request(base,'/queue',AbortSignal.timeout(3_000),{
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delete:[promptId]}),empty:true
          });
        }).catch(()=>{});
      }
      signal?.throwIfAborted();
      if(deadline.aborted)throw new Error('ComfyUI 生成等待超过 5 分钟，请在后端查看队列。');
      throw error;
    }
  }

  async function generate({endpoint,checkpoint,controlnet,strength,prompt,negative='',sketch,signal,onStatus}){
    signal?.throwIfAborted();
    if(typeof checkpoint!=='string'||!checkpoint.trim()||typeof controlnet!=='string'||!controlnet.trim()){
      throw new Error('请先选择 SD1.5 主模型与匹配的 Scribble ControlNet。');
    }
    if(typeof prompt!=='string'||!prompt.trim()||typeof negative!=='string')throw new Error('请填写生成提示词。');
    if(!Number.isFinite(strength)||strength<0||strength>1)throw new Error('草图控形强度须在 0 到 1 之间。');
    if(!(sketch instanceof Blob)||!sketch.size||sketch.type!=='image/png')throw new Error('控形草图必须为 PNG 图像。');
    const seed=crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({endpoint,inputBlob:sketch,signal,onStatus,
      build:image=>workflow({checkpoint,controlnet,strength,prompt,negative,image,seed})});
  }

  async function renderLive(options){
    const {endpoint,input,quality,checkpoint,controlnet,prompt,sourceImage,colorGuideImage,slot,signal,onStatus}=options;
    if(!['sketch','image','text'].includes(input)||!['live','preview','final'].includes(quality))throw new Error('无法识别当前渲染模式。');
    if(typeof checkpoint!=='string'||!checkpoint.trim())throw new Error('请先选择一个支持 SD 1.5 或 SDXL 的基础模型。');
    if(typeof prompt!=='string'||!prompt.trim())throw new Error('请先输入画面描述。');
    if(input!=='text'&&(!(sourceImage instanceof Blob)||!sourceImage.size||sourceImage.type!=='image/png')){
      throw new Error('画面输入需要有效的 PNG 数据。');
    }
    if(colorGuideImage&&(!(colorGuideImage instanceof Blob)||!colorGuideImage.size||colorGuideImage.type!=='image/png'
      ||input!=='sketch'||!controlnet))throw new Error('配色参考需为与草图控形图对齐的 PNG。');
    const strength=Math.min(1,Math.max(0,Number(options.strength)||0));
    const seed=Number.isInteger(options.seed)&&options.seed>=0?options.seed:crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({endpoint,inputBlob:input==='text'?null:sourceImage,guideBlob:colorGuideImage,slot,signal,onStatus,
      cancelPending:true,pollInterval:quality==='live'?200:600,
      build:(inputImage,colorGuide)=>liveWorkflow({...options,inputImage,colorGuide,strength,seed})});
  }

  async function renderKrea(options) {
    const { endpoint, krea, input, quality, prompt, seed, signal, onStatus } = options;
    if (input !== 'text' || !prompt?.trim()) throw new Error('Krea 2 需要文字输入。');
    if (!krea?.unet || !krea.clip || !krea.vae) throw new Error('请先连接 Krea 2 Turbo 模型。');
    return runWorkflow({ endpoint, signal, onStatus, cancelPending:true, pollInterval: 1000,
      build: () => kreaWorkflow({ quality, prompt, seed, krea }) });
  }

  function regionWorkflow({ checkpoint, prompt, denoise, seed, image, mask }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    const turbo = /(?:^|[._ -])turbo(?:[._ -]|$)/i.test(checkpoint);
    const lcm = /(?:^|[._ -])lcm(?:[._ -]|$)/i.test(checkpoint);
    return {
      1: node('CheckpointLoaderSimple', { ckpt_name: checkpoint }),
      2: node('CLIPTextEncode', { clip: ['1', 1], text: prompt }),
      3: node('CLIPTextEncode', { clip: ['1', 1], text: 'blurry, low quality, distorted edges, extra objects, text, watermark' }),
      4: node('LoadImage', { image }),
      5: node('LoadImage', { image: mask }),
      6: node('ImageToMask', { image: ['5', 0], channel: 'red' }),
      7: node('VAEEncode', { pixels: ['4', 0], vae: ['1', 2] }),
      8: node('SetLatentNoiseMask', { samples: ['7', 0], mask: ['6', 0] }),
      9: node('KSampler', {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['8', 0], seed, denoise,
        steps: turbo ? 9 : lcm ? 10 : 26, cfg: turbo ? 1 : lcm ? 1.8 : 6.5,
        sampler_name: lcm ? 'lcm' : 'dpmpp_2m', scheduler: turbo ? 'sgm_uniform' : 'karras'
      }),
      10: node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] }),
      [SAVE_NODE_ID]: node('PreviewImage', { images: ['10', 0] })
    };
  }

  async function renderRegion({ endpoint, checkpoint, prompt, denoise, sourceImage, maskImage, slot, signal, onStatus, seed }) {
    signal?.throwIfAborted();
    if (!checkpoint?.trim() || !prompt?.trim()) throw new Error('请选择基础模型，并说明选区里要改什么。');
    if (!Number.isFinite(denoise) || denoise < .25 || denoise > .95) throw new Error('选区改动强度须在 25% 到 95% 之间。');
    if (![sourceImage, maskImage].every(blob => blob instanceof Blob && blob.type === 'image/png' && blob.size)) {
      throw new Error('改图需要 PNG 原图和同尺寸的选区遮罩。');
    }
    const samplingSeed = Number.isInteger(seed) && seed >= 0 ? seed : crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({
      endpoint, inputBlob: sourceImage, maskBlob: maskImage, slot, signal, onStatus, cancelPending: true, pollInterval: 600,
      build: (image, guide, mask) => regionWorkflow({ checkpoint, prompt, denoise, seed: samplingSeed, image, mask })
    });
  }

  // Adapted from ComfyArt's MIT-licensed cutout-birefnet and upscale-ultrasharp-4x workflows.
  function imageToolWorkflow({kind, image, model, size}) {
    const node=(class_type,inputs)=>({class_type,inputs});
    if(kind==='cutout'){
      return {
        '17':node('LoadImage',{image}),
        '19:14':node('LoadBackgroundRemovalModel',{bg_removal_name:model}),
        '19:13':node('RemoveBackground',{image:['17',0],bg_removal_model:['19:14',0]}),
        '19:15':node('InvertMask',{mask:['19:13',0]}),
        '19:16':node('JoinImageWithAlpha',{image:['17',0],alpha:['19:15',0]}),
        [SAVE_NODE_ID]:node('SaveImage',{filename_prefix:'wuying/cutout',images:['19:16',0]})
      };
    }
    const graph={'1':node('LoadImage',{image})};
    if(model){
      graph['2']=node('UpscaleModelLoader',{model_name:model});
      graph['3']=node('ImageUpscaleWithModel',{upscale_model:['2',0],image:['1',0]});
    }
    const scale=image=>node('ImageScale',{image,...size,upscale_method:'lanczos',crop:'disabled'});
    graph['4']=scale([model?'3':'1',0]);
    graph['5']=node('MaskToImage',{mask:['1',1]});
    graph['6']=scale(['5',0]);
    graph['7']=node('ImageToMask',{image:['6',0],channel:'red'});
    // LoadImage and JoinImageWithAlpha both use a mask whose 1 means transparent.
    graph['9']=node('JoinImageWithAlpha',{image:['4',0],alpha:['7',0]});
    graph[SAVE_NODE_ID]=node('SaveImage',{filename_prefix:'wuying/upscale',images:['9',0]});
    return graph;
  }

  async function runImageTool({kind,endpoint,sourceImage,size,slot,signal,onStatus}) {
    if(kind!=='cutout'&&kind!=='upscale') throw new Error('未知的本机图像工具。');
    if(!(sourceImage instanceof Blob)||!sourceImage.size||sourceImage.type!=='image/png'){
      throw new Error('图像工具需要有效的 PNG 源图。');
    }
    if(kind==='upscale'&&![size?.width,size?.height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=4096)){
      throw new Error('放大后的长边须在 4096 像素以内。');
    }
    const cutout=kind==='cutout';
    const loader=cutout?'LoadBackgroundRemovalModel':'UpscaleModelLoader';
    const field=cutout?'bg_removal_name':'model_name';
    const pattern=cutout?/birefnet/i:/4x[-_ ]?ultrasharp/i;
    const schema=await request(endpointBase(endpoint),'/object_info/'+loader,signal).catch(error=>{
      if(error.status===404) return {};
      throw error;
    });
    const models=schema?.[loader]?.input?.required?.[field]?.[0];
    const model=Array.isArray(models)?models.find(name=>typeof name==='string'&&pattern.test(name)):undefined;
    if(cutout&&!model) throw new Error('去除背景需要本机 ComfyUI 的 BiRefNet 模型与背景移除节点。');
    onStatus?.(cutout?'使用 BiRefNet 去除背景…':model?'使用 UltraSharp 放大…':'使用 Lanczos 放大…');
    return runWorkflow({endpoint,inputBlob:sourceImage,signal,onStatus,slot:slot||'image-tool',cancelPending:true,
      pollInterval:600,build:image=>imageToolWorkflow({kind,image,model,size})});
  }

  const api = { testConnection, testKreaConnection, generate, renderLive, renderKrea, renderRegion, liveWorkflow, kreaWorkflow, runImageTool };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WuyingComfy = api;
}());
