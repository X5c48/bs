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
    const [checkpoints, controlnets, diffusion] = await Promise.all([
      request(base, '/models/checkpoints', signal),
      request(base, '/models/controlnet', signal),
      request(base, '/models/diffusion_models', signal).catch(error => {
        if (error.status === 404) return [];
        throw error;
      })
    ]);
    if (!Array.isArray(checkpoints) || !Array.isArray(controlnets)
        || [...checkpoints, ...controlnets].some((name) => typeof name !== 'string')) {
      throw new Error('ComfyUI 返回了无效的模型列表。');
    }
    // 分体式 Qwen-Image-2.1（diffusion + Qwen3VL 编码器 + VAE）合并进基础模型下拉。
    const qwen = (Array.isArray(diffusion) ? diffusion : [])
      .filter(name => typeof name === 'string' && /^qwen[_ ]?image[_ ]?2\.?1/i.test(name.split(/[\\/]/).at(-1)));
    return { checkpoints: [...checkpoints, ...qwen], controlnets, qwen };
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

  // endPercent：草图影响力联动（<1 时提前截断 ControlNet），不传则全程控制，兼容旧调用与实时链路。
  function workflow({ checkpoint, controlnet, strength, prompt, negative, image, seed, endPercent }) {
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
        strength, start_percent: 0, end_percent: endPercent ?? 1
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
  // SD1.5 / SDXL 的 CLIP 一次只吃 77 token，超长提示词的后半段会被静默丢弃。
  // 表现就是：写了「马克笔灰模、白底无场景」，出图却是照片级白模——风格词根本没进模型。
  // 按逗号语义切成若干块分别编码，再用 ConditioningCombine 拼起来。
  function splitPrompt(text, maxWords = 55) {
    const clean = String(text || '').trim();
    if (!clean) return [''];
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [clean];
    const pieces = clean.split(/\s*,\s*/).filter(Boolean);
    if (pieces.length < 2) {
      const chunks = [];
      for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
      return chunks;
    }
    const chunks = [];
    let current = [], count = 0;
    for (const piece of pieces) {
      const size = piece.split(/\s+/).filter(Boolean).length;
      if (count && count + size > maxWords) {
        chunks.push(current.join(', '));
        current = [piece];
        count = size;
      } else {
        current.push(piece);
        count += size;
      }
    }
    if (current.length) chunks.push(current.join(', '));
    return chunks;
  }

  // 长提示词分块编码：CLIP 一次只吃 77 token，超出的部分会被静默丢弃。
  // 单块时仍落在传入的 firstId 上，短提示词的图结构完全不变。
  function encodeText(graph, node, text, firstId, extraBase, combineBase) {
    const chunks = splitPrompt(text);
    if (chunks.length <= 1) {
      graph[firstId] = node('CLIPTextEncode', { clip: ['1', 1], text: chunks[0] || '' });
      return [String(firstId), 0];
    }
    let previous = null;
    chunks.forEach((chunk, index) => {
      const id = index === 0 ? firstId : extraBase + (index - 1);
      graph[id] = node('CLIPTextEncode', { clip: ['1', 1], text: chunk });
      if (!previous) { previous = [String(id), 0]; return; }
      const combineId = String(combineBase + index - 1);
      graph[combineId] = node('ConditioningCombine', { conditioning_1: previous, conditioning_2: [String(id), 0] });
      previous = [combineId, 0];
    });
    return previous;
  }

  function liveWorkflow({input,quality,checkpoint,controlnet,strength,prompt,negative='',inputImage,colorGuide,seed,latentWidth=640,latentHeight=512,tier='balanced',endPercent,controlStrength,denoiseOverride,sketchPreview}) {
    const node=(class_type,inputs)=>({class_type,inputs});
    const graph={
      1:node('CheckpointLoaderSimple',{ckpt_name:checkpoint})
    };
    const encode = (text, firstId, extraBase, combineBase) => encodeText(graph, node, text, firstId, extraBase, combineBase);
    let positive = encode(prompt, 2, 40, 70);
    let negativeInput = encode(negative, 3, 50, 80);
    // 探索幅度档位会单独给条件强度与重画力度：条件强度和 img2img 力度是两个旋钮，
    // 贴线档需要「条件锁死 + 重画很浅」，只用 strength 反推达不到这个组合。
    const conditionStrength=Number.isFinite(controlStrength)?Math.min(1.5,Math.max(0,controlStrength)):strength;
    const lineControl=input==='sketch'&&!!controlnet;
    let denoise=1;
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
        strength:conditionStrength,start_percent:0,end_percent:endPercent??1,vae:['1',2]
      });
      positive=['7',0];negativeInput=['7',1];
    }
    // 造型探索档位需要以草图本身作 latent 起点，denoise 才有意义。
    // 平时「sketch + ControlNet」走空 latent 全重画（靠条件图控形），贴线档要保留线条就不能这么做。
    const seedFromSketch=lineControl&&!colorGuide&&Number.isFinite(denoiseOverride);
    if(input==='text'||(lineControl&&!colorGuide&&!seedFromSketch)){
      graph[8]=node('EmptyLatentImage',{width:latentWidth,height:latentHeight,batch_size:1});
    }else{
      const scaleId=lineControl?'15':'5';
      if(lineControl)graph[14]=node('LoadImage',{image:colorGuide||inputImage});
      graph[scaleId]=node('ImageScale',{
        image:[lineControl?'14':'4',0],width:latentWidth,height:latentHeight,upscale_method:'bilinear',crop:'disabled'
      });
      graph[8]=node('VAEEncode',{pixels:[scaleId,0],vae:['1',2]});
      // Higher shape strength retains more of the incoming form in img2img.
      denoise=input==='sketch'?(lineControl?.85-strength*.14:.80-strength*.23):.62-strength*.30;
      // 档位显式给的力度优先：贴线档要低到 .4 左右，公式下限是 .58，达不到。
      if(Number.isFinite(denoiseOverride))denoise=Math.min(.95,Math.max(.15,denoiseOverride));
    }
    const turbo=/(?:^|[._ -])turbo(?:[._ -]|$)/i.test(checkpoint);
    const lcm=/(?:^|[._ -])lcm(?:[._ -]|$)/i.test(checkpoint);
    const cyberRealistic=/cyberrealistic/i.test(checkpoint)&&!turbo&&!lcm;
    // live 三档：speed 抢时间、balanced 默认、quality 堆细节。SD1.5 在 live 下同样用 dpmpp_2m + karras。
    const liveSteps=turbo?(tier==='quality'?6:4):lcm?(tier==='quality'?8:tier==='speed'?4:5)
      :cyberRealistic?(tier==='speed'?8:tier==='quality'?20:sketchPreview?11:12)
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

  // A separate client ID isolates preview traffic from other ComfyUI jobs.
  function openSamplingPreview(base, onPreview, signal) {
    if(!onPreview || typeof WebSocket==='undefined') return null;
    const url=new URL(base+'/ws');
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return null;
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const clientId=crypto.randomUUID();
    url.searchParams.set('clientId',clientId);
    let socket;
    try{socket=new WebSocket(url);}catch{return null;}
    socket.binaryType='arraybuffer';
    let ready=false, sent=false;
    socket.addEventListener('message',event=>{
      const bytes=event.data;
      if(sent || signal.aborted || !(bytes instanceof ArrayBuffer) || bytes.byteLength<=8) return;
      const header=new DataView(bytes),type=header.getUint32(0);
      let offset=8,mime;
      if(type===1) mime=header.getUint32(4)===2?'image/png':'image/jpeg';
      else if(type===4){
        offset+=header.getUint32(4);
        if(offset>=bytes.byteLength) return;
        try{mime=JSON.parse(new TextDecoder().decode(bytes.slice(8,offset))).image_type;}catch{return;}
      }
      if(!['image/jpeg','image/png'].includes(mime)) return;
      sent=true;
      onPreview(new Blob([bytes.slice(offset)],{type:mime}));
    });
    const opened=new Promise(resolve=>{
      socket.addEventListener('open',()=>{ready=true;resolve();},{once:true});
      socket.addEventListener('error',resolve,{once:true});
      socket.addEventListener('close',resolve,{once:true});
    });
    return {clientId,async ready(){await Promise.race([opened,delay(signal,100)]);return ready&&socket.readyState===1;},
      close(){socket.close();}};
  }

  async function runWorkflow({
    endpoint,inputBlob,guideBlob,maskBlob,signal,onStatus,build,slot,cancelPending=false,pollInterval=POLL_INTERVAL_MS,onPreview,previewMethod='latent2rgb'
  }){
    signal?.throwIfAborted();
    const base=endpointBase(endpoint),deadline=AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const generationSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    const liveSlot=typeof slot==='string'&&/^[a-z0-9-]{1,100}$/i.test(slot);
    let promptId;
    const sampling=openSamplingPreview(base,onPreview,generationSignal);
    async function uploadImage(blob,label){
      // 实时帧（liveSlot）用固定文件名 + overwrite：每帧一个随机名会让 temp 无限增长，
      // 攒到一定数量会触发 ComfyUI 的批量删除确认闸门并直接退出（历史上出现过整机渲染全挂）。
      const random=crypto.getRandomValues(new Uint32Array(2));
      const name=liveSlot?'wuying-'+slot+'-'+label+'.png'
        :'wuying-'+label+'-'+random[0]+'-'+random[1]+'.png';
      const upload=new FormData();
      upload.set('image',blob,name);
      upload.set('type',liveSlot?'temp':'input');
      upload.set('overwrite',liveSlot?'true':'false');
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
      const preview=await sampling?.ready();
      const queued=await request(base,'/prompt',cancelPending?null:generationSignal,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:build(inputImage,colorGuide,maskImage),
          ...(preview?{client_id:sampling.clientId,extra_data:{preview_method:previewMethod}}:{})})
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
    }finally{sampling?.close();}
  }

  async function generate({endpoint,checkpoint,controlnet,strength,prompt,negative='',sketch,signal,onStatus,endPercent}){
    signal?.throwIfAborted();
    if(typeof checkpoint!=='string'||!checkpoint.trim()||typeof controlnet!=='string'||!controlnet.trim()){
      throw new Error('请先选择 SD1.5 主模型与匹配的 Scribble ControlNet。');
    }
    if(typeof prompt!=='string'||!prompt.trim()||typeof negative!=='string')throw new Error('请填写生成提示词。');
    if(!Number.isFinite(strength)||strength<0||strength>1.5)throw new Error('草图影响力须在 0 到 1.5 之间。');
    if(!(sketch instanceof Blob)||!sketch.size||sketch.type!=='image/png')throw new Error('控形草图必须为 PNG 图像。');
    const seed=crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({endpoint,inputBlob:sketch,signal,onStatus,
      build:image=>workflow({checkpoint,controlnet,strength,prompt,negative,image,seed,endPercent})});
  }

  async function renderLive(options){
    const {endpoint,input,quality,checkpoint,controlnet,prompt,sourceImage,colorGuideImage,slot,signal,onStatus}=options;
    if(!['sketch','image','text'].includes(input)||!['live','preview','final'].includes(quality))throw new Error('无法识别当前渲染模式。');
    if(typeof checkpoint!=='string'||!checkpoint.trim())throw new Error('请先选择一个支持 SD 1.5 或 SDXL 的基础模型。');
    // Qwen 是分体式 diffusion（没有 CLIP/VAE 打包），CheckpointLoaderSimple 必然 400。
    // 这里提前拦住并给出可执行提示，避免用户看到一长串 ckpt_name 报错。
    if(/^qwen[_ ]?image/i.test(checkpoint.trim())){
      throw new Error('Qwen-Image-2.1 不能走 SD 实时通道，请用 Qwen 高质量预览（或换回 SD1.5 模型）。');
    }
    if(typeof prompt!=='string'||!prompt.trim())throw new Error('请先输入画面描述。');
    if(input!=='text'&&(!(sourceImage instanceof Blob)||!sourceImage.size||sourceImage.type!=='image/png')){
      throw new Error('画面输入需要有效的 PNG 数据。');
    }
    if(colorGuideImage&&(!(colorGuideImage instanceof Blob)||!colorGuideImage.size||colorGuideImage.type!=='image/png'
      ||input!=='sketch'||!controlnet))throw new Error('配色参考需为与草图控形图对齐的 PNG。');
    // 实时滑块上限 95%，不受 1.5 影响；出图链路的影响力可到 1.5，经 endPercent 提前截断。
    const strength=Math.min(1.5,Math.max(0,Number(options.strength)||0));
    const seed=Number.isInteger(options.seed)&&options.seed>=0?options.seed:crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({endpoint,inputBlob:input==='text'?null:sourceImage,guideBlob:colorGuideImage,slot,signal,onStatus,
      cancelPending:true,pollInterval:quality==='live'?200:600,onPreview:quality==='live'?options.onPreview:undefined,
      previewMethod:options.sketchPreview&&options.tier==='quality'?'taesd':'latent2rgb',
      build:(inputImage,colorGuide)=>liveWorkflow({...options,inputImage,colorGuide,strength,seed})});
  }

  async function renderKrea(options) {
    const { endpoint, krea, input, quality, prompt, seed, signal, onStatus } = options;
    if (input !== 'text' || !prompt?.trim()) throw new Error('Krea 2 需要文字输入。');
    if (!krea?.unet || !krea.clip || !krea.vae) throw new Error('请先连接 Krea 2 Turbo 模型。');
    return runWorkflow({ endpoint, signal, onStatus, cancelPending:true, pollInterval: 1000,
      build: () => kreaWorkflow({ quality, prompt, seed, krea }) });
  }

  // Qwen-Image-2.1（分体式 diffusion + Qwen3VL 编码器 + VAE，Turbo 8 级 sigma，CFG 1）。
  // 参考图接线（关键）：TextEncodeQwenImage21 的 images 是 Autogrow 动态输入，API 里必须用
  // 扁平键 `images.image_1` 下发，写成 {images:{image_1:[...]}} 会被静默忽略（模型退化成纯文生图）；
  // 同时必须接 vae，否则只做视觉塔编码、不拼参考 latent，造型依然锁不住。
  const QWEN_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';
  // 8 步是 Turbo 的默认档；步数更多时按原曲线分段线性插值，保持同样的下降形状（不改变最后一步归零）。
  function qwenSigmas(steps) {
    const base = QWEN_SIGMAS.split(',').map(Number);
    if (!Number.isInteger(steps) || steps < 4 || steps === 8) return QWEN_SIGMAS;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * (base.length - 1);
      const low = Math.floor(t), high = Math.min(base.length - 1, low + 1);
      out.push(base[low] + (base[high] - base[low]) * (t - low));
    }
    out[out.length - 1] = 0;
    return out.map(value => Math.round(value * 1e6) / 1e6).join(', ');
  }
  function qwenWorkflow({ checkpoint, clip = 'qwen3vl_8b_int8_convrot.safetensors', vae = 'qwen_image_2.1_vae_bf16.safetensors', prompt, negative = '', reference, seed = 0, resolution = 1024, steps = 8 }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    const graph = {
      '1': node('UNETLoader', { unet_name: checkpoint, weight_dtype: 'default' }),
      '2': node('QwenImage21Cache', { model: ['1', 0], device: 'auto', dtype: 'default' }),
      '3': node('CLIPLoader', { clip_name: clip, type: 'qwen_image', device: 'default' }),
      '4': node('VAELoader', { vae_name: vae }),
      '5': node('TextEncodeQwenImage21', { clip: ['3', 0], vae: ['4', 0], prompt, negative_prompt: negative, resolution }),
      '6': node('KSamplerSelect', { sampler_name: 'euler' }),
      '7': node('RandomNoise', { noise_seed: seed, noise_mode: 'fixed' }),
      '8': node('CFGGuider', { model: ['2', 0], cfg: 1, positive: ['5', 0], negative: ['5', 1] }),
      '9': node('ManualSigmas', { sigmas: qwenSigmas(steps) }),
      '10': node('SamplerCustomAdvanced', { noise: ['7', 0], guider: ['8', 0], sampler: ['6', 0], sigmas: ['9', 0], latent_image: ['5', 2] }),
      '12': node('VAEDecode', { samples: ['10', 0], vae: ['4', 0] }),
      '11': node('SaveImage', { images: ['12', 0], filename_prefix: 'Wuying/qwen21' })
    };
    if (reference) {
      graph['14'] = node('LoadImage', { image: reference });
      graph['5'].inputs['images.image_1'] = ['14', 0];
    }
    return graph;
  }

  async function renderQwen(options) {
    const { endpoint, checkpoint, prompt, negative = '', sourceImage, slot, signal, onStatus } = options;
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('请先连接 ComfyUI。');
    if (typeof checkpoint !== 'string' || !/^qwen[_ ]?image[_ ]?2\.?1/i.test(checkpoint.trim())) {
      throw new Error('请选择 Qwen-Image-2.1 系列模型。');
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('请先输入画面描述。');
    if (sourceImage && (!(sourceImage instanceof Blob) || !sourceImage.size || sourceImage.type !== 'image/png')) {
      throw new Error('参考图需要有效的 PNG 数据。');
    }
    const resolution = Number.isInteger(options.resolution) && options.resolution >= 256 && options.resolution <= 4096
      ? options.resolution : 1024;
    const seed = Number.isInteger(options.seed) && options.seed >= 0
      ? options.seed : crypto.getRandomValues(new Uint32Array(1))[0];
    // 质量档加步是唯一还能挖的画质余量（Turbo 默认 8 步）；实时帧固定 8 步保响应。
    const steps = Number.isInteger(options.steps) && options.steps >= 4 && options.steps <= 24 ? options.steps : 8;
    return runWorkflow({
      endpoint, inputBlob: sourceImage || null, slot, signal, onStatus, pollInterval: 600,
      // 实时通道（Qwen 慢速预览）需要取消挂起任务；默认保持旧行为。
      cancelPending: options.cancelPending === true,
      build: reference => qwenWorkflow({ checkpoint: checkpoint.trim(), prompt, negative, reference, seed, resolution, steps })
    });
  }

  // guide + controlnet：情境渲染时用草图约束选区内的造型（Scribble 需黑底白线，故反相）。
  function regionWorkflow({ checkpoint, prompt, negative, denoise, seed, image, mask, guide, controlnet, liveTier, controlStrength = .9 }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    const turbo = /(?:^|[._ -])turbo(?:[._ -]|$)/i.test(checkpoint);
    const lcm = /(?:^|[._ -])lcm(?:[._ -]|$)/i.test(checkpoint);
    const graph = {
      1: node('CheckpointLoaderSimple', { ckpt_name: checkpoint })
    };
    // 场景板的提示词比改图长得多，同样要分块编码，否则环境描述会被 77 token 截掉。
    const encode = (text, firstId, extraBase, combineBase) => encodeText(graph, node, text, firstId, extraBase, combineBase);
    const positive = encode(prompt, 2, 40, 70);
    const negativeInput = encode(negative || 'blurry, low quality, distorted edges, extra objects, text, watermark', 3, 50, 80);
    graph[4] = node('LoadImage', { image });
    graph[5] = node('LoadImage', { image: mask });
    graph[6] = node('ImageToMask', { image: ['5', 0], channel: 'red' });
    graph[7] = node('VAEEncode', { pixels: ['4', 0], vae: ['1', 2] });
    graph[8] = node('SetLatentNoiseMask', { samples: ['7', 0], mask: ['6', 0] });
    graph[9] = node('KSampler', {
      model: ['1', 0], positive, negative: negativeInput, latent_image: ['8', 0], seed, denoise,
      steps: liveTier ? (turbo||lcm?5:liveTier==='speed'?6:12) : turbo ? 9 : lcm ? 10 : 26, cfg: turbo ? 1 : lcm ? 1.8 : 6.5,
      sampler_name: lcm ? 'lcm' : 'dpmpp_2m', scheduler: turbo ? 'sgm_uniform' : 'karras'
    });
    graph[10] = node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] });
    graph[SAVE_NODE_ID] = node('PreviewImage', { images: ['10', 0] });
    if (guide && controlnet) {
      graph[21] = node('LoadImage', { image: guide });
      const lineart = /line[ _-]?art|misto[ _-]?line/i.test(controlnet), canny = /canny/i.test(controlnet);
      if (canny) graph[22] = node('Canny', { image: ['21', 0], low_threshold: .2, high_threshold: .5 });
      else if (!lineart) graph[22] = node('ImageInvert', { image: ['21', 0] });
      graph[23] = node('ControlNetLoader', { control_net_name: controlnet });
      graph[24] = node('ControlNetApplyAdvanced', {
        positive, negative: negativeInput, control_net: ['23', 0], image: [graph[22] ? '22' : '21', 0],
        strength: controlStrength, start_percent: 0, end_percent: 1, vae: ['1', 2]
      });
      graph[9].inputs.positive = ['24', 0];
      graph[9].inputs.negative = ['24', 1];
    }
    return graph;
  }

  async function renderRegion({ endpoint, checkpoint, prompt, negative, denoise, sourceImage, maskImage, guideImage, controlnet, controlStrength, liveTier, slot, signal, onStatus, seed }) {
    signal?.throwIfAborted();
    if (!checkpoint?.trim() || !prompt?.trim()) throw new Error('请选择基础模型，并说明选区里要改什么。');
    if (!Number.isFinite(denoise) || denoise < .25 || denoise > .95) throw new Error('选区改动强度须在 25% 到 95% 之间。');
    if (![sourceImage, maskImage].every(blob => blob instanceof Blob && blob.type === 'image/png' && blob.size)) {
      throw new Error('改图需要 PNG 原图和同尺寸的选区遮罩。');
    }
    if (guideImage && !(guideImage instanceof Blob && guideImage.size)) throw new Error('草图控形图无效。');
    const control = guideImage && typeof controlnet === 'string' && controlnet.trim() ? controlnet.trim() : '';
    const samplingSeed = Number.isInteger(seed) && seed >= 0 ? seed : crypto.getRandomValues(new Uint32Array(1))[0];
    return runWorkflow({
      endpoint, inputBlob: sourceImage, maskBlob: maskImage, guideBlob: control ? guideImage : null, slot, signal, onStatus, cancelPending: true, pollInterval: liveTier?200:600,
      build: (image, guide, mask) => regionWorkflow({ checkpoint, prompt, negative, denoise, seed: samplingSeed, image, mask, guide, controlnet: control, controlStrength, liveTier })
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

  const api = { testConnection, testKreaConnection, generate, renderLive, renderQwen, renderKrea, renderRegion, liveWorkflow, qwenWorkflow, kreaWorkflow, runImageTool, workflow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WuyingComfy = api;
}());
