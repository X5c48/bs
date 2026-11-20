(() => {
  'use strict';

  const modelWidth = 1280, modelHeight = 1024;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const intents = {
    instant: 'Follow the requested finish stage. Preserve the source silhouette, proportions, parts and camera angle.',
    render: 'Product design rendering from the supplied sketch. Follow its outlines, proportions and viewpoint. Define materials, lighting and form clearly.',
    modify: 'Apply the requested change. Preserve the unmentioned details, object proportions, camera and lighting.',
    color: 'Product colorway. Change colors while retaining the same geometry, seams, materials, camera and background.',
    form: 'Product form exploration. Vary the requested geometry while retaining the product category, scale, function and presentation.',
    view: 'Reimagine the same product from the requested camera angle. Preserve its recognizable geometry, materials and details.'
  };
  // renderLive exposes image-to-image strength as preservation, inverse to edit intensity.
  const preservation = {
    modify: [0.95, 0.25],
    color: [0.95, 0.68],
    form: [0.72, 0.25],
    view: [0.58, 0.25]
  };
  const referenceLabels = {
    color: 'Color reference palette',
    material: 'Material reference tones',
    style: 'Style reference palette'
  };

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function toPng(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法导出出图图像。')), 'image/png');
    });
  }

  function isPng(blob) {
    return blob instanceof Blob && blob.size > 0 && blob.type === 'image/png';
  }

  async function alignedInput(source, controlsShape, signal) {
    const bitmap = await createImageBitmap(source);
    try {
      signal?.throwIfAborted();
      const scale = Math.min(modelWidth / bitmap.width, modelHeight / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const padded = width !== modelWidth || height !== modelHeight;
      const x = Math.floor((modelWidth - width) / 2), y = Math.floor((modelHeight - height) / 2);
      const bounds = padded ? { x, y, width, height } : null;
      if (!padded && !controlsShape) return { image:source, bounds };

      const canvas = makeCanvas(modelWidth, modelHeight);
      const context = canvas.getContext('2d', { willReadFrequently:controlsShape });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, modelWidth, modelHeight);
      context.drawImage(bitmap, x, y, width, height);
      const image = padded ? await toPng(canvas) : source;
      if (!controlsShape) return { image, bounds };

      const pixels = context.getImageData(0, 0, modelWidth, modelHeight);
      const data = pixels.data;
      let hasColor = false;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        hasColor ||= chroma > 25;
        const gray = Math.min(.299 * r + .587 * g + .114 * b, 255 - chroma);
        data[i] = data[i + 1] = data[i + 2] = gray;
      }
      if (!hasColor) return { image, bounds };

      context.putImageData(pixels, 0, 0);
      return { image:await toPng(canvas), guide:image, bounds };
    } finally { bitmap.close(); }
  }

  async function cropResult(blob, bounds) {
    if (!bounds && isPng(blob)) return blob;
    const bitmap = await createImageBitmap(blob);
    try {
      const box = bounds || { x:0, y:0, width:modelWidth, height:modelHeight };
      const sx = bitmap.width / modelWidth, sy = bitmap.height / modelHeight;
      const width = Math.max(1, Math.round(box.width * sx));
      const height = Math.max(1, Math.round(box.height * sy));
      const canvas = makeCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, box.x * sx, box.y * sy, box.width * sx, box.height * sy, 0, 0, width, height);
      return await toPng(canvas);
    } finally { bitmap.close(); }
  }

  function colorName(rgb) {
    const [r, g, b] = rgb, max = Math.max(r, g, b), min = Math.min(r, g, b), range = max - min;
    if (range < 28) return max < 55 ? 'near-black' : min > 213 ? 'off-white' : 'gray';
    const turn = max === r ? (g - b) / range : max === g ? 2 + (b - r) / range : 4 + (r - g) / range;
    const hue = ((turn + 6) % 6) * 60;
    const names = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'red'];
    const boundaries = [18, 49, 72, 163, 199, 258, 326, 360];
    const name = names[boundaries.findIndex(boundary => hue <= boundary)];
    if (name === 'orange' && max < 195 && min < 143) return 'warm brown';
    return (max < 105 ? 'dark ' : min > 145 ? 'light ' : '') + name;
  }

  async function imagePalette(blob, limit=10, signal) {
    const bitmap = await createImageBitmap(blob);
    try {
      signal?.throwIfAborted();
      const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = makeCanvas(width, height).getContext('2d', { willReadFrequently:true });
      ctx.drawImage(bitmap, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
        const bucket = buckets.get(key) || {count:0, r:0, g:0, b:0};
        bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
        buckets.set(key, bucket);
      }
      const colors = [...buckets.values()].map(({count, r, g, b}) => {
        const rgb = [r, g, b].map(value => Math.round(value / count));
        // Keep neutrals available, but downweight near-white studio backgrounds.
        const weight = Math.min(...rgb) > 233 ? .25 : 1;
        return {rgb, rank:count * weight};
      }).sort((a, b) => b.rank - a.rank);
      return colors.slice(0, limit).map(({rgb}) =>
        '#'+rgb.map(value => value.toString(16).padStart(2,'0')).join(''));
    } finally { bitmap.close(); }
  }

  async function referencePalette(blob, signal) {
    const colors=await imagePalette(blob,3,signal);
    return colors.map(hex=>{
      const rgb=[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
      return colorName(rgb)+' '+hex;
    }).join(', ');
  }

  const cloudOrigin = 'http://127.0.0.1:8882';
  const cloudRoles = { color:'color reference', material:'material reference', style:'style reference' };

  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('无法读取图片。'));
      reader.readAsDataURL(blob);
    });
  }

  async function sizeOf(blob) {
    const bitmap = await createImageBitmap(blob);
    try { return { width:bitmap.width, height:bitmap.height }; } finally { bitmap.close(); }
  }

  // 云端编辑模型输出比例只能取近似档位，按源图尺寸居中裁切回去，保证图层对齐。
  async function fitTo(blob, width, height) {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      const w = bitmap.width * scale, h = bitmap.height * scale;
      const canvas = makeCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
      return await toPng(canvas);
    } finally { bitmap.close(); }
  }

  async function cloudRender({ model, prompt, image, references, signal, size, mode, resolution }) {
    const { width, height } = size || await sizeOf(image);
    const images = [await dataUrl(image)];
    for (const ref of references) images.push(await dataUrl(ref.blob));
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetch(cloudOrigin + '/api/runninghub/render', {
        method:'POST', cache:'no-store', signal, headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({ model, prompt, images, aspect:width / height, mode, resolution })
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('连不上本机出图后台。请先双击「启动出图后台.cmd」。');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || 'RunningHub 出图失败。');
    }
    return fitTo(await response.blob(), width, height);
  }

  async function profileRender({apiProfile,prompt,image,references,signal,size}) {
    const input=[image,...references.map(reference=>reference.blob)];
    const images=[];
    for(let blob of input){
      signal?.throwIfAborted();
      while(blob.size>8*1024*1024){
        const {width,height}=await sizeOf(blob);
        if(width<=1&&height<=1) throw new Error('图片超过接口的 8 MB 输入限制。');
        blob=await fitTo(blob,Math.max(1,Math.floor(width*.75)),Math.max(1,Math.floor(height*.75)));
      }
      images.push(await dataUrl(blob));
    }
    const result=await window.WuyingPlatformApi.request('image-profiles/render',{
      id:apiProfile.id,revision:apiProfile.revision,prompt:prompt.slice(0,4000),images
    },{image:true,signal});
    const {width,height}=size||await sizeOf(image);
    return fitTo(result,width,height);
  }

  // 用户提示里的 @1–@n 对应 block 输入槽（最后一张是主图）；发给云端时主图排第一，
  // 所以 @n → image 1，@i → image i+1。
  function mentions(text, count) {
    return text.replace(/@([1-4])/g, (all, digit) => {
      const n = Number(digit);
      if (n > count) return all;
      return 'image ' + (n === count ? 1 : n + 1);
    });
  }

  function cloudPrompt(kind, text, references, regional) {
    const lines = [];
    if (text) lines.push(mentions(text, references.length + 1));
    references.forEach(({ role }, i) => {
      lines.push('Use image ' + (i + 2) + ' only as the ' + (cloudRoles[role] || cloudRoles.color) + '; do not copy its shape.');
    });
    lines.push(kind === 'render'
      ? 'Turn image 1, a product design sketch, into a realistic product rendering. Keep its outlines, proportions and viewpoint exactly.'
      : intents[kind] + (regional ? ' Image 1 is a crop; keep its framing and edges.' : ' Edit image 1.'));
    return lines.join(' ');
  }

  async function generateCloud(options, editRegion) {
    const { kind, source, selection, signal, onStatus } = options;
    const references = options.references || [];
    const prompt = cloudPrompt(kind, String(options.prompt || '').trim(), references, editRegion);
    const custom=options.provider==='imageapi', render=custom?profileRender:cloudRender;
    const providerArgs={model:options.cloudModel,apiProfile:options.apiProfile,mode:options.mode,resolution:options.resolution};
    if (editRegion) {
      onStatus?.(custom?'正在裁出选区并上传图片接口…':'正在裁出选区并上传 RunningHub…');
      const mask = window.WuyingImageSelection;
      const prepared = await mask.prepare(source, selection, options.protectedAreas);
      const { width, height } = await sizeOf(prepared.sourceImage);
      const patch = await render({ ...providerArgs,prompt,image:prepared.sourceImage,references,signal });
      signal?.throwIfAborted();
      // 选区外像素由本地合成保证不变，云端只负责选区内的内容。
      return mask.composite(prepared, await fitTo(patch, width, height), { feather:14 });
    }
    onStatus?.(custom?'正在请求图片接口…':'正在上传 RunningHub 并排队…');
    return render({ ...providerArgs,prompt,image:source,references,signal,size:options.size });
  }

  // keepRunning=false：新输入立即中止旧请求（旧结果永不显示）。
  // keepRunning=true（Krea/Krita 式实时）：同一时刻只跑一个请求，期间只保留最新一份输入，
  // 跑完后先显示这一帧再接着跑最新输入。帧按提交顺序出现，旧帧不会盖过新帧。
  function createLatestPreview({render,onState,debounce=650,keepRunning=false}) {
    let timer, active, queued, hasQueued=false;
    function cancel() {
      clearTimeout(timer);
      timer=null;
      hasQueued=false;
      queued=undefined;
      const old=active;
      active=null;
      old?.abort();
    }
    function start(input) {
      const controller=new AbortController();
      active=controller;
      onState({status:'running'});
      Promise.resolve().then(()=>render(input,controller.signal)).then(result=>{
        if(active!==controller)return;
        active=null;
        onState({status:'done',result});
        next();
      },error=>{
        if(active!==controller)return;
        active=null;
        onState({status:'failed',error});
        next();
      });
    }
    function next() {
      if(!hasQueued||active)return;
      const input=queued;
      hasQueued=false;
      queued=undefined;
      start(input);
    }
    function schedule(input) {
      if(!keepRunning)cancel();
      queued=input;
      hasQueued=true;
      // 进行中或已在倒计时：只替换待渲染输入，不重置计时，边画边出帧。
      if(active||timer)return;
      onState({status:'waiting'});
      timer=setTimeout(()=>{timer=null;next();},debounce);
    }
    return {schedule,cancel,busy:()=>!!active};
  }

  // 把还没落笔保存的笔触并进图层快照，实时预览可以边画边更新。
  function liveSnapshot(asset,pending){
    const copy=structuredClone(asset);
    copy.layers||=[];
    const stroke=pending?.stroke;
    if(!stroke||!Array.isArray(stroke.points)||stroke.points.length<2)return copy;
    const layer=copy.layers.find(item=>item.id===pending.layerId);
    if(layer?.kind==='ink'&&layer.visible!==false){
      layer.strokes=[...(layer.strokes||[]),structuredClone(stroke)];
    }else if(!stroke.erase){
      const offset=copy.layers.findIndex(item=>item.id===pending.layerId);
      copy.layers.splice(offset<0?copy.layers.length:offset+1,0,
        {id:'live-pending',name:'live',kind:'ink',visible:true,opacity:1,strokes:[structuredClone(stroke)]});
    }
    return copy;
  }

  async function expandCanvas(options) {
    const {source,signal,endpoint,checkpoint,seed,slot,onStatus,outpaint}=options;
    const {x,y,width,height}=outpaint;
    const base=await createImageBitmap(source);
    try{
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<base.width+x||height<base.height+y){
        throw new Error('扩图尺寸与源图不一致。');
      }
      const paddedWidth=Math.ceil(width/8)*8, paddedHeight=Math.ceil(height/8)*8;
      const input=makeCanvas(paddedWidth,paddedHeight), mask=makeCanvas(paddedWidth,paddedHeight);
      const context=input.getContext('2d');
      context.fillStyle='#fff';
      context.fillRect(0,0,paddedWidth,paddedHeight);
      context.drawImage(base,x,y);
      const area=mask.getContext('2d');
      area.fillStyle='#fff';
      area.fillRect(0,0,paddedWidth,paddedHeight);
      area.fillStyle='#000';
      area.fillRect(x,y,base.width,base.height);
      const [sourceImage,maskImage]=await Promise.all([toPng(input),toPng(mask)]);
      signal?.throwIfAborted();
      const prompt=[options.prompt,'Extend the scene into the new canvas area. Continue the original background, lighting and perspective.'].filter(Boolean).join(' ');
      const {blob}=await window.WuyingComfy.renderRegion({endpoint,checkpoint,seed,slot,onStatus,signal,sourceImage,maskImage,denoise:.92,prompt});
      signal?.throwIfAborted();
      const generated=await createImageBitmap(blob);
      try{
        const canvas=makeCanvas(width,height), output=canvas.getContext('2d');
        output.drawImage(generated,0,0,paddedWidth,paddedHeight);
        output.clearRect(x,y,base.width,base.height);
        output.drawImage(base,x,y);
        return await toPng(canvas);
      }finally{generated.close();}
    }finally{base.close();}
  }

  async function generate(options) {
    const { kind, source, selection, signal, onStatus } = options;
    signal?.throwIfAborted();
    if(kind==='outpaint'){
      if(!isPng(source)||!options.outpaint)throw new Error('扩图需要有效的源图和范围。');
      return expandCanvas(options);
    }
    if (!Object.hasOwn(intents, kind)) throw new Error('未知的出图操作。');
    if (!isPng(source)) throw new Error('出图需要有效的 PNG 源图。');
    if (options.provider === 'runninghub' || options.provider === 'imageapi') {
      const regional = kind === 'modify' && !!selection?.length;
      if (regional && !window.WuyingImageSelection.enough(selection)) throw new Error('请选择一块有效区域。');
      return generateCloud(options, regional);
    }
    const comfy = window.WuyingComfy;
    const mask = window.WuyingImageSelection;
    const { endpoint, checkpoint, seed, slot } = options;
    const amount = Number.isFinite(options.strength) ? clamp(options.strength, .25, .95) : .65;
    const editRegion = kind === 'modify' && !!selection?.length;
    if (editRegion && (!Array.isArray(selection) || selection.length > 1200 ||
        !selection.every(point => Number.isFinite(point?.x) && point.x >= 0 && point.x <= 1 &&
          Number.isFinite(point.y) && point.y >= 0 && point.y <= 1) || !mask.enough(selection))) {
      throw new Error('请选择一块有效区域。');
    }
    const references = options.references || [];
    if (references.length) onStatus?.('正在读取参考图配色…');
    const refPrompts = await Promise.all(references.map(async ({blob, role}) => {
      const label = Object.hasOwn(referenceLabels, role) ? referenceLabels[role] : referenceLabels.color;
      const colors = await referencePalette(blob, signal);
      return colors && label + ': ' + colors + '.';
    }));
    const prompt = [String(options.prompt || '').trim(), ...refPrompts, intents[kind]].filter(Boolean).join(' ');
    const shared = { endpoint, checkpoint, prompt, seed, slot, signal, onStatus };
    signal?.throwIfAborted();

    // Qwen-Image-2.1 高质量整图通道：分体式 diffusion 模型走专用工作流；实时帧仍用 SD1.5 ControlNet。
    if (/^qwen[_ ]?image[_ ]?2\.?1/i.test(String(checkpoint || '')) && !options.live) {
      if (editRegion) throw new Error('选区重绘请换 SD1.5 模型；Qwen-Image-2.1 支持整图渲染与改稿。');
      signal?.throwIfAborted();
      const { blob } = await comfy.renderQwen({ ...shared, negative: 'lowres, worst quality, low quality, blurry, watermark, unwanted text, clutter', sourceImage: source });
      signal?.throwIfAborted();
      const size = options.size;
      if (size) {
        const got = await sizeOf(blob);
        if (got.width !== size.width || got.height !== size.height) return fitTo(blob, size.width, size.height);
      }
      return blob;
    }

    if (editRegion) {
      onStatus?.('正在准备源图和选区遮罩…');
      const prepared = await mask.prepare(source, selection, options.protectedAreas);
      signal?.throwIfAborted();
      const { blob } = await comfy.renderRegion({ ...shared,
        sourceImage:prepared.sourceImage, maskImage:prepared.maskImage, denoise:amount
      });
      signal?.throwIfAborted();
      const output = await mask.composite(prepared, blob, {feather:14});
      signal?.throwIfAborted();
      return output;
    }

    onStatus?.('正在准备源图…');
    const sketch = kind === 'render' || kind === 'instant';
    const controlnet = sketch ? String(options.controlnet || '').trim() : '';
    const { image, guide, bounds } = await alignedInput(source, !!controlnet, signal);
    signal?.throwIfAborted();
    let strength = amount;
    let endPercent;
    if (sketch) {
      // 草图影响力（对标方案 §7.3 Drawing Influence）：0–1.5，联动 end_percent 提前截断控制。
      // 实时渲染不传 influence，走原 strength 行为，链路完全不变。
      if (Number.isFinite(options.influence)) {
        const mapping = influenceMapping(options.influence);
        strength = mapping.strength;
        endPercent = mapping.endPercent;
      }
    } else {
      const [maximum, minimum] = preservation[kind];
      strength = maximum - (maximum - minimum) * (amount - .25) / .7;
    }
    // 实时分辨率跟随档位：始终是 1280×1024 的等比缩放并 8 对齐，裁切坐标系不变。
    const tier=['speed','balanced','quality'].includes(options.liveTier)?options.liveTier:'balanced';
    const latentScale=tier==='speed'?.5:tier==='quality'?.75:.625;
    const latentWidth=Math.round(modelWidth*latentScale/8)*8, latentHeight=Math.round(modelHeight*latentScale/8)*8;
    const { blob } = await comfy.renderLive({ ...shared, input:sketch ? 'sketch' : 'image',
      quality:options.live?'live':options.preview?'preview':'final', sourceImage:image, colorGuideImage:guide, controlnet, strength,
      ...(endPercent !== undefined ? { endPercent } : {}),
      latentWidth,latentHeight,tier,
      negative:'lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, watermark, unwanted text, duplicate objects, clutter, bad anatomy, deformed, oversaturated'
    });
    signal?.throwIfAborted();
    const output = await cropResult(blob, bounds);
    signal?.throwIfAborted();
    // 选了非原始比例或分辨率时，把本机结果居中裁切到目标尺寸。
    const size = options.size;
    if (size) {
      const got = await sizeOf(output);
      if (got.width !== size.width || got.height !== size.height) return fitTo(output, size.width, size.height);
    }
    return output;
  }

  // 草图影响力 → ControlNet 参数映射（方案 §7.3）：
  // strength = min(influence, 1.5)；end_percent = influence ≥ 1 ? 1 : 0.4 + 0.6 × influence。
  // 影响力 0 时 ControlNet 只作用于前 40% 步数，让模型更自由；≥1 时全程控制。
  function influenceMapping(influence) {
    const value = Math.min(1.5, Math.max(0, Number(influence) || 0));
    return { strength: value, endPercent: value >= 1 ? 1 : Math.round((.4 + .6 * value) * 1000) / 1000 };
  }

  // 方案级主题 → 内部提示词。主体锁定恒定；主题只描述风格方向，自定义提示词覆盖方向部分。
  function themeDirective(theme) {
    if (!theme || typeof theme !== 'object') return '';
    const custom = typeof theme.custom === 'string' ? theme.custom.trim().slice(0, 1200) : '';
    const text = typeof theme.text === 'string' ? theme.text.trim().slice(0, 300) : '';
    const direction = custom || (text ? 'Design theme and visual direction: ' + text + '.' : '');
    if (!direction) return '';
    return direction + ' Keep the sketched product as the fixed main subject: preserve its product category, silhouette, proportions, parts and camera angle. Apply this direction only to styling, materials, colors, lighting and scene context; never change the product structure.';
  }

  window.WuyingWorkspaceRender = { generate, cloudPrompt, imagePalette, createLatestPreview, liveSnapshot, themeDirective, influenceMapping };
})();
