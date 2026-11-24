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
    view: 'Reimagine the same product from the requested camera angle. Preserve its recognizable geometry, materials and details.',
    studio: 'High-end studio product photography. Keep the product identity, silhouette and proportions.',
    scene: 'A single real physical product placed naturally in this photographed scene, built exactly from the sketched outline with no extra parts. Keep the surrounding wall, surfaces and edges continuous. Match the scene lighting, perspective, contact shadows and color temperature. Photorealistic.'
  };
  // renderLive exposes image-to-image strength as preservation, inverse to edit intensity.
  const preservation = {
    modify: [0.95, 0.25],
    color: [0.95, 0.68],
    form: [0.72, 0.25],
    view: [0.58, 0.25],
    studio: [0.9, 0.3]
  };
  const referenceLabels = {
    color: 'Color reference palette',
    material: 'Material reference tones',
    style: 'Style reference palette'
  };
  let sharedControlnetCache = null;

  // 视角预设 → 结构投影角度（方位角/俯仰角，度）。与 WuyingAngleSphere 的扇区一致；
  // 角度球单视角时会用球上的精确角度覆盖这里的规范值。
  const canonicalViewAngles = {
    front: { azimuth: 0, elevation: 0 }, 'front-right': { azimuth: 45, elevation: 0 },
    right: { azimuth: 90, elevation: 0 }, 'rear-right': { azimuth: 135, elevation: 0 },
    rear: { azimuth: 180, elevation: 0 }, 'rear-left': { azimuth: 225, elevation: 0 },
    left: { azimuth: 270, elevation: 0 }, 'front-left': { azimuth: 315, elevation: 0 },
    elevated: { azimuth: 0, elevation: 38 }, top: { azimuth: 0, elevation: 85 },
    bottom: { azimuth: 0, elevation: -85 }
  };
  function resolveViewAngle(view, custom) {
    if (custom && Number.isFinite(custom.azimuth) && Number.isFinite(custom.elevation)) {
      return { azimuth: ((custom.azimuth % 360) + 360) % 360, elevation: Math.max(-85, Math.min(85, custom.elevation)) };
    }
    return { ...(canonicalViewAngles[view] || canonicalViewAngles.front) };
  }

  const geometryLockPrompt = 'Render strictly from the supplied structure sketch: keep every part shape, position, proportion and camera angle exactly as drawn; do not invent, remove, move or restyle any part of the product.';
  // Qwen 通道的提示词脚手架：编辑模型对「产品摄影 + 照参考图还原」这类措辞响应最好。
  const qwenDirective = 'Photorealistic product design render of the object in the reference image. ' +
    'Keep its silhouette, part layout, proportions and camera angle exactly as shown; do not add, remove or move parts. ' +
    'Clean crisp edges, defined seams, studio softbox lighting, soft contact shadow, seamless light gray background, high detail.';
  const qwenNegative = 'lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, watermark, signature, unwanted text, extra objects, duplicate parts, distorted silhouette, deformed, oversaturated, cartoon, illustration';
  // 目标尺寸档位 → Qwen 的 resolution（32 对齐，8G 显存下单次上限 1024）。
  function qwenResolution(resolution) {
    if (Number.isInteger(resolution) && resolution >= 256) return Math.min(1024, resolution);
    return resolution === '2k' || resolution === '4k' ? 1024 : 1024;
  }

  // —— 第 2 阶段实时辅助：造型探索（P7）——
  // 定位见整体规划 6.3 第 7 条：草图阶段只回答「这个形还能怎么走」，
  // 所以风格恒定在白底灰模 / 马克笔明暗，材质中性、无场景，避免过早评价 CMF。
  // 只画一个产品：早期版本写了 "design sheet / construction lines"，模型会理解成
  // 「设计图纸上有多个视图」，于是在空白处补出别的产品。这里把画面约束写死成单件。
  // 明暗用保守措辞（只在暗面铺淡灰），写 "strong / clear / visible" 会把 SD1.5 推向 3D 渲染。
  const sketchStyle = 'Grey marker concept sketch, one single product only, ' +
    'plain white paper, no scene, no background, ' +
    'light grey marker planes and distinct mid-grey shadows at overlapping parts, white highlights, ' +
    'crisp thin exterior contours, lighter seam and construction lines, preserve part junctions, no color, no texture, ' +
    'one object centered, no other objects, faint contact shadow.';
  // 草图阶段负向词：把「照片级 / 场景 / 彩色材质 / 多物体」全部推走。
  const sketchNegative = 'photo, photograph, photorealistic, realistic photo, 3d render, octane render, ' +
    'scene, environment, background scenery, room, indoor, outdoor, grass, sky, wall, table top, floor, props, ' +
    'colored materials, wood grain, marble texture, brushed metal, glossy plastic, reflections of surroundings, ' +
    'product advertising, catalog shot, dramatic lighting, hdr, text, signature, watermark, ' +
    'multiple products, second object, other sketches, multiple views, montage, grid layout, ' +
    'design sheet, blueprint, collage, coffee foam, whipped cream, bubbles, ' +
    'empty white shapes, blank flat fill, scribbled noise, stray strokes, ' +
    'lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, duplicate objects, clutter';

  // 探索幅度三档：区分「听不听草图」靠的是 ControlNet 强度与控制截断点，不是压低重画力度。
  // 压低 denoise 只会把用户的底图原样留下，模型没机会铺明暗；
  // 但 denoise 太高又会把线条冲掉，所以三档取 .62 / .72 / .82 这个能兼顾的区间。
  // controlStrength：条件强度；denoise：重画力度；endPercent：ControlNet 何时松手。
  const exploreTiers = [
    { id:'tight', label:'贴线', note:'线条全程锁住，形态几乎不变', controlStrength:.95, denoise:.62, endPercent:1 },
    { id:'balanced', label:'推敲', note:'允许修顺线条、补结构', controlStrength:.88, denoise:.68, endPercent:.91 },
    { id:'loose', label:'发散', note:'允许改比例与局部形态', controlStrength:.6, denoise:.82, endPercent:.6 }
  ];
  function exploreTier(id) {
    return exploreTiers.find(item => item.id === id) || exploreTiers[1];
  }

  // 造型倾向：三组对偶，各选一边；等价于 Vizcom Variate · Form 的形态倾向快捷词。
  const exploreTendencies = [
    { id:'density', label:'繁简', options:[
      { id:'simple', label:'简', prompt:'simplified form with one dominant volume, minimal seams and few surface breaks' },
      { id:'complex', label:'繁', prompt:'layered form with multiple volumes, visible part breaks and functional details' }
    ] },
    { id:'form', label:'曲直', options:[
      { id:'geometric', label:'几何', prompt:'geometric form with straight edges, planar surfaces and crisp fillets' },
      { id:'organic', label:'有机', prompt:'organic form with continuous curved surfaces and flowing transitions' }
    ] },
    { id:'weight', label:'厚薄', options:[
      { id:'heavy', label:'厚重', prompt:'visually grounded and weighty, low stance, thick sections' },
      { id:'light', label:'轻薄', prompt:'visually light and airy, slim sections, elevated stance' }
    ] }
  ];
  // selection 形如 {density:'simple', form:'organic'}，非法值忽略。
  function tendencySelection(value) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    for (const group of exploreTendencies) {
      const picked = String(value[group.id] || '');
      if (group.options.some(option => option.id === picked)) result[group.id] = picked;
    }
    return result;
  }
  function sketchTendencyDirective(value) {
    const picked = tendencySelection(value);
    const parts = [];
    for (const group of exploreTendencies) {
      const option = group.options.find(item => item.id === picked[group.id]);
      if (option) parts.push(option.prompt);
    }
    return parts.join(', ');
  }
  // 完整提示词：用户描述 + 方向/主题（调用方已拼好）留在前面，风格与倾向追加在后面。
  function sketchStyleDirective(value) {
    const tendency = sketchTendencyDirective(value);
    return sketchStyle + (tendency ? ' Form tendency: ' + tendency + '.' : '');
  }
  // 一次算好某档探索的全部参数，界面与出图共用同一份数值，避免两边漂移。
  function explorePlan(options) {
    const tier = exploreTier(options?.tier);
    return {
      id: tier.id,
      label: tier.label,
      controlStrength: tier.controlStrength,
      denoise: tier.denoise,
      endPercent: tier.endPercent,
      negative: sketchNegative,
      style: sketchStyleDirective(options?.tendency)
    };
  }

  // 把部件几何按指定方位/俯仰投影成结构线稿（白底 + 灰面 + 深色边），
  // 作为「生成视角」的 ControlNet 条件图——输出严格来自现有造型数据。
  async function structureSketchBlob(parts, width, height, azimuth, elevation) {
    const model = window.WuyingShapeModel;
    if (!model || !Array.isArray(parts) || !parts.length || width < 16 || height < 16) return null;
    const list = model.normalizeParts ? model.normalizeParts(parts) : parts;
    const az = (Number(azimuth) || 0) * Math.PI / 180, el = (Number(elevation) || 0) * Math.PI / 180;
    const boxes = list.map(part => model.outlineBounds(part));
    const depth = model.depthSpan(list);
    const cx = (Math.min(...boxes.map(b => b.x)) + Math.max(...boxes.map(b => b.x + b.width))) / 2;
    const cy = (Math.min(...boxes.map(b => b.y)) + Math.max(...boxes.map(b => b.y + b.height))) / 2;
    const cz = (depth.min + depth.max) / 2;
    let radius = 1;
    const drawn = [];
    for (const part of list) {
      const centered = { ...part, x: part.x - cx, y: part.y - cy, z: part.z - cz };
      const farZ = Math.abs(centered.z) + centered.depth / 2;
      for (const p of model.polygon(centered)) radius = Math.max(radius, Math.hypot(p.x, p.y, farZ));
      drawn.push(...model.blockFaces(centered, az, el));
    }
    const canvas = makeCanvas(Math.round(width), Math.round(height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width, canvas.height) * .42 / radius;
    const depthOf = face => face.points.reduce((sum, p) => sum + p.d, 0) / face.points.length;
    for (const face of [...drawn].sort((a, b) => depthOf(b) - depthOf(a))) {
      const points = face.points.map(p => [canvas.width / 2 + p.x * scale, canvas.height / 2 + p.y * scale]);
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      const tone = Math.round(210 + 35 * face.shade);
      context.globalAlpha = face.id === 'front' || face.id === 'back' ? 1 : .75;
      context.fillStyle = 'rgb(' + tone + ',' + tone + ',' + (tone - 6) + ')';
      context.strokeStyle = '#1d1d1f';
      // 细长部件（表针、支柱）的描边按面尺寸收窄，避免结构图里变成实心黑块
      context.lineWidth = Math.min(Math.max(2, canvas.width / 300), Math.max(1.2, Math.min(w, h) * .35));
      context.lineJoin = 'round';
      context.beginPath();
      points.forEach((p, index) => index ? context.lineTo(p[0], p[1]) : context.moveTo(p[0], p[1]));
      context.closePath();
      context.fill();
      context.stroke();
      context.globalAlpha = 1;
    }
    return toPng(canvas);
  }

  // All three drawings share the same world units. Front geometry comes from confirmed nodes.
  function orthoSnapshot(asset) {
    const geometry=window.WuyingShapeModel;
    const front=asset.design?.views?.front;
    const parts=geometry.normalizeParts(asset.draft.parts).map(part=>{
      const outline=front?.outlines?.[part.id] || geometry.outline(part);
      const inspected=window.WuyingSketchRules.inspect(outline);
      if(!inspected.ok) throw new Error('部件轮廓无法投影：'+part.name);
      return {id:part.id,locked:asset.design?.locks?.[part.id]??part.locked??false,
        outline,box:inspected.bounds,z:part.z,depth:part.depth};
    });
    return {revision:asset.draft.revision,parts};
  }

  function orthographicDrawing(snapshot,view,size) {
    const parts=snapshot.parts;
    const extent=(starts,ends)=>{const low=Math.min(...starts),high=Math.max(...ends);
      return {center:(low+high)/2,span:high-low};};
    const x=extent(parts.map(p=>p.box.x),parts.map(p=>p.box.x+p.box.width));
    const y=extent(parts.map(p=>p.box.y),parts.map(p=>p.box.y+p.box.height));
    const z=extent(parts.map(p=>p.z-p.depth/2),parts.map(p=>p.z+p.depth/2));
    const scale=.87*Math.min(size.width/Math.max(1,x.span,z.span),size.height/Math.max(1,y.span,z.span));
    const sheet=makeCanvas(size.width,size.height),ctx=sheet.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,sheet.width,sheet.height);
    const horizontal=view==='left'?z:x,vertical=view==='top'?z:y;
    ctx.translate(sheet.width/2,sheet.height/2);ctx.scale(scale,scale);
    ctx.translate(-horizontal.center,-vertical.center);
    ctx.lineWidth=1.5/scale;ctx.lineJoin='round';ctx.strokeStyle='#303239';ctx.fillStyle='#f2f2f2';
    const order=p=>view==='front'?p.z+p.depth/2:view==='left'?-p.box.x:-p.box.y;
    for(const part of [...parts].sort((a,b)=>order(a)-order(b))){
      ctx.beginPath();
      if(view==='front'){
        const nodes=part.outline.nodes;ctx.moveTo(nodes[0].point.x,nodes[0].point.y);
        nodes.forEach((a,i)=>{const b=nodes[(i+1)%nodes.length];
          ctx.bezierCurveTo(a.out.x,a.out.y,b.in.x,b.in.y,b.point.x,b.point.y);});
      }else if(view==='left'){
        ctx.rect(part.z-part.depth/2,part.box.y,part.depth,part.box.height);
      }else{
        ctx.rect(part.box.x,part.z-part.depth/2,part.box.width,part.depth);
      }
      ctx.closePath();ctx.fill();ctx.stroke();
    }
    return toPng(sheet);
  }

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

  async function alignedInput(source, controlsShape, signal, frameWidth=modelWidth, frameHeight=modelHeight, measureMargins=false) {
    const bitmap = await createImageBitmap(source);
    try {
      signal?.throwIfAborted();
      const scale = Math.min(frameWidth / bitmap.width, frameHeight / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const padded = width !== frameWidth || height !== frameHeight;
      const x = Math.floor((frameWidth - width) / 2), y = Math.floor((frameHeight - height) / 2);
      const bounds = padded ? { x, y, width, height, frameWidth, frameHeight } : null;
      const redraw=padded || (frameWidth!==modelWidth && (width!==bitmap.width || height!==bitmap.height));
      if (!redraw && !controlsShape) return { image:source, bounds };

      const canvas = makeCanvas(frameWidth, frameHeight);
      const context = canvas.getContext('2d', { willReadFrequently:controlsShape });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, frameWidth, frameHeight);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, x, y, width, height);
      const image = redraw ? await toPng(canvas) : source;
      if (!controlsShape) return { image, bounds };

      const pixels = context.getImageData(0, 0, frameWidth, frameHeight);
      const data = pixels.data;
      let hasColor = false;
      let left=width,right=-1,top=height,bottom=-1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        hasColor ||= chroma > 25;
        const gray = Math.min(.299 * r + .587 * g + .114 * b, 255 - chroma);
        if(measureMargins && gray<235){
          const px=(i/4)%frameWidth-x,py=Math.floor(i/4/frameWidth)-y;
          left=Math.min(left,px);right=Math.max(right,px);
          top=Math.min(top,py);bottom=Math.max(bottom,py);
        }
        data[i] = data[i + 1] = data[i + 2] = gray;
      }
      const emptyEdges=[left/width,(width-1-right)/width,top/height,(height-1-bottom)/height];
      const margins=right>=0 && emptyEdges.some(value=>value>=.07)?emptyEdges:undefined;
      if (!hasColor) return { image, bounds, margins };

      context.putImageData(pixels, 0, 0);
      return { image:await toPng(canvas), guide:image, bounds, margins };
    } finally { bitmap.close(); }
  }

  // Fade only the outer area that was already empty in the sketch.
  function clearSketchMargins(context,margins){
    if(!margins) return;
    const {width,height}=context.canvas;
    const edges=[[0,0,width,0], [width,0,0,0], [0,0,0,height], [0,height,0,0]];
    edges.forEach(([x,y,oppositeX,oppositeY],i)=>{
      const fraction=Math.min(.15,margins[i]-.045);
      if(fraction<.025) return;
      const endX=x+(oppositeX-x)*fraction,endY=y+(oppositeY-y)*fraction;
      const feather=context.createLinearGradient(x,y,endX,endY);
      feather.addColorStop(0,'white');
      feather.addColorStop(.72,'white');
      feather.addColorStop(1,'rgba(255,255,255,0)');
      context.fillStyle=feather;
      context.fillRect(oppositeX===x?0:Math.min(x,endX),oppositeY===y?0:Math.min(y,endY),
        oppositeX===x?width:Math.abs(endX-x),oppositeY===y?height:Math.abs(endY-y));
    });
  }

  async function cropResult(blob, bounds, size, margins) {
    if (!bounds && !size && !margins && isPng(blob)) return blob;
    const bitmap = await createImageBitmap(blob);
    try {
      const box = bounds || { x:0, y:0, width:modelWidth, height:modelHeight };
      const sx = bitmap.width / (box.frameWidth || modelWidth), sy = bitmap.height / (box.frameHeight || modelHeight);
      const width = Math.max(1, Math.round(box.width * sx));
      const height = Math.max(1, Math.round(box.height * sy));
      if(size && Math.abs(width/height-size.width/size.height)<.006){
        if(!bounds && !margins && bitmap.width===size.width && bitmap.height===size.height && isPng(blob)) return blob;
        const target=makeCanvas(size.width,size.height),context=target.getContext('2d');
        context.imageSmoothingQuality='high';
        context.drawImage(bitmap,box.x*sx,box.y*sy,box.width*sx,box.height*sy,0,0,size.width,size.height);
        clearSketchMargins(context,margins);
        return toPng(target);
      }
      const canvas = makeCanvas(width, height);
      const context=canvas.getContext('2d');
      context.drawImage(bitmap, box.x * sx, box.y * sy, box.width * sx, box.height * sy, 0, 0, width, height);
      clearSketchMargins(context,margins);
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
      if(role.startsWith('ortho-')){lines.push('Use image '+(i+2)+' as the '+role.slice(6)+' orthographic geometry reference. Preserve its proportions and part layout.');return;}
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

  // 模块 5：情境渲染。底图是不含笔触的照片，草图单独作控形；只重绘选区，选区外逐像素保留照片。
  async function generateScene(options) {    const { source, selection, signal, onStatus, scene } = options;
    const mask = window.WuyingImageSelection;
    if (!isPng(scene?.photo) || !isPng(scene?.sketch)) throw new Error('情境渲染需要照片和草图快照。');
    if (!mask.enough(selection || [])) throw new Error('请圈出产品要放置的区域。');
    onStatus?.('正在裁出草图区域…');
    const base = await mask.prepare(scene.photo, selection);
    signal?.throwIfAborted();
    const amount = Number.isFinite(options.strength) ? clamp(options.strength, .25, .95) : .85;
    if (options.provider === 'runninghub' || options.provider === 'imageapi') {
      const custom = options.provider === 'imageapi', render = custom ? profileRender : cloudRender;
      const withSketch = await mask.prepare(source, selection);
      const { width, height } = await sizeOf(base.sourceImage);
      onStatus?.(custom ? '正在请求图片接口…' : '正在上传 RunningHub 并排队…');
      const prompt = cloudPrompt('scene', String(options.prompt || '').trim(), options.references || [], true);
      const patch = await render({ model:options.cloudModel, apiProfile:options.apiProfile, mode:options.mode, resolution:options.resolution,
        prompt, image:withSketch.sourceImage, references:options.references || [], signal });
      signal?.throwIfAborted();
      return mask.composite(base, await fitTo(patch, width, height), { feather:14 });
    }
    if (/^qwen[_ ]?image[_ ]?2\.?1/i.test(String(options.checkpoint || ''))) throw new Error('情境渲染需要选区重绘，请换 SD1.5 模型。');
    const guide = await mask.prepare(scene.sketch, selection);
    signal?.throwIfAborted();
    const prompt = [String(options.prompt || '').trim(), intents.scene].filter(Boolean).join(' ');
    const { blob } = await window.WuyingComfy.renderRegion({
      endpoint:options.endpoint, checkpoint:options.checkpoint, seed:options.seed, slot:options.slot, signal, onStatus, prompt,
      sourceImage:base.sourceImage, maskImage:base.maskImage, guideImage:guide.sourceImage,
      controlnet:options.controlnet, controlStrength:.95, denoise:amount
    });
    signal?.throwIfAborted();
    return mask.composite(base, await matchEdges(base.sourceImage, blob), { feather:24 });
  }

  // P8 产品渲染 · 实时辅助：Krea 式实物渲染（场景板）。
  // 分工是「合成负责保形，生成负责打光和场景」：
  //   ① 场景板先按像素把产品摆好、抠好，产品轮廓在这一步就是确定的；
  //   ② 第一段只改产品区（浅），给产品重新打光、上材质、落接触阴影；
  //   ③ 第二段只改产品外（深），把色块背景重画成真实环境。
  // 两段的遮罩互斥，产品像素只经历一次浅改，所以换场景提示词不会把产品改变形。
  const sceneBoardDefaults = { productDenoise: .38, sceneDenoise: .75 };

  async function renderSceneBoard(options) {
    const board = window.WuyingSceneBoard;
    if (!board) throw new Error('场景板模块未加载。');
    const { scene, size, resolve, signal, onStatus, checkpoint, endpoint, seed, controlnet, liveTier, slot } = options;
    if (!checkpoint?.trim()) throw new Error('场景板出图需要先选基础模型。');
    if (/^qwen[_ ]?image[_ ]?2\.?1/i.test(String(checkpoint))) {
      throw new Error('场景板依赖分区去噪，需要 SD1.5 模型；Qwen 通道没有局部重绘。');
    }
    onStatus?.('正在合成场景板…');
    // VAE 要求长宽都是 8 的倍数，不对齐会被 ComfyUI 裁掉几像素，合成图和出图尺寸就对不上。
    const aligned = {
      width: Math.max(64, Math.floor(Number(size?.width || 1024) / 8) * 8),
      height: Math.max(64, Math.floor(Number(size?.height || 1024) / 8) * 8)
    };
    const composed = await board.compose(scene, aligned, resolve);
    signal?.throwIfAborted();

    const prompt = board.scenePrompt(scene, options.prompt);
    const productDenoise = Number.isFinite(options.productDenoise)
      ? clamp(options.productDenoise, .25, .55) : sceneBoardDefaults.productDenoise;
    const sceneDenoise = Number.isFinite(options.sceneDenoise)
      ? clamp(options.sceneDenoise, .45, .9) : sceneBoardDefaults.sceneDenoise;
    const samplingSeed = Number.isInteger(seed) && seed >= 0 ? seed : crypto.getRandomValues(new Uint32Array(1))[0];
    const common = {
      endpoint, checkpoint, prompt, negative: board.sceneNegative, controlnet,
      sourceImage: null, maskImage: null, guideImage: composed.outline,
      controlStrength: .9, liveTier, signal
    };

    // 第一段：产品区。denoise 压在 .4 附近，够上光影、不够改形。
    onStatus?.('正在给产品打光上材质…');
    const lit = await window.WuyingComfy.renderRegion({
      ...common, sourceImage: composed.image, maskImage: composed.productMask,
      denoise: productDenoise, seed: samplingSeed, slot: slot + '-lit', onStatus
    });
    signal?.throwIfAborted();

    // 第二段：产品外。这里可以放开重画背景，产品的边缘靠轮廓条件顶住。
    onStatus?.('正在重画场景环境…');
    const placed = await window.WuyingComfy.renderRegion({
      ...common, sourceImage: lit.blob, maskImage: composed.sceneMask,
      denoise: sceneDenoise, seed: samplingSeed + 1, slot: slot + '-scene', onStatus
    });
    return placed.blob;
  }

  // 重绘后 VAE 往返会让背景整体偏色，在选区边缘留下方框。取裁切图四周 6% 宽的边带，
  // 求生成图与原照片的平均色差，从整块补丁里减掉，使边缘与照片对齐。
  async function matchEdges(originalBlob, patchBlob) {
    const [original, patch] = await Promise.all([createImageBitmap(originalBlob), createImageBitmap(patchBlob)]);
    try {
      const width = original.width, height = original.height;
      const read = bitmap => {
        const canvas = makeCanvas(width, height), context = canvas.getContext('2d', { willReadFrequently:true });
        context.drawImage(bitmap, 0, 0, width, height);
        return { canvas, context, data:context.getImageData(0, 0, width, height) };
      };
      const a = read(original).data.data, target = read(patch), b = target.data.data;
      const band = Math.max(4, Math.round(Math.min(width, height) * .06));
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (x >= band && x < width - band && y >= band && y < height - band) continue;
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) sum[c] += b[i + c] - a[i + c];
        count++;
      }
      const shift = sum.map(value => value / Math.max(1, count));
      if (shift.every(value => Math.abs(value) < 1)) return patchBlob;
      for (let i = 0; i < b.length; i += 4) for (let c = 0; c < 3; c++) b[i + c] = clamp(Math.round(b[i + c] - shift[c]), 0, 255);
      target.context.putImageData(target.data, 0, 0);
      return await toPng(target.canvas);
    } finally { original.close(); patch.close(); }
  }

  // 模块 4：材质特写取景框。有选区取选区外接框，否则取中心一半宽；外扩成 5:4 并夹在图内，最小为短边 12%。
  function detailBox(width, height, selection) {
    const ratio = modelWidth / modelHeight;
    let cx = width / 2, cy = height / 2, w = width / 2, h = w / ratio;
    if (Array.isArray(selection) && selection.length >= 3) {
      const xs = selection.map(p => p.x * width), ys = selection.map(p => p.y * height);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
      w = Math.max(x1 - x0, (y1 - y0) * ratio, Math.min(width, height) * .12 * ratio);
      h = w / ratio;
    }
    if (h > height) { h = height; w = h * ratio; }
    if (w > width) { w = width; h = w / ratio; }
    const x = clamp(cx - w / 2, 0, width - w), y = clamp(cy - h / 2, 0, height - h);
    const r = v => Math.round(v * 100) / 100;
    return { x:r(x), y:r(y), width:r(w), height:r(h) };
  }

  async function cropDetail(source, selection) {
    const bitmap = await createImageBitmap(source);
    try {
      const box = detailBox(bitmap.width, bitmap.height, selection);
      const canvas = makeCanvas(modelWidth, modelHeight), context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, modelWidth, modelHeight);
      return { image:await toPng(canvas), box };
    } finally { bitmap.close(); }
  }

  // 线稿判定：缩到 96 像素宽采样，深色像素（亮度 < 200）不足 14% 且几乎无彩色时视为线稿。
  async function looksLikeSketch(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
      const w = 96, h = Math.max(1, Math.round(96 * bitmap.height / bitmap.width));
      const canvas = makeCanvas(w, h), context = canvas.getContext('2d', { willReadFrequently:true });
      context.fillStyle = '#fff'; context.fillRect(0, 0, w, h);
      context.drawImage(bitmap, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      if (!data.length) return false;
      let dark = 0, colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (.299 * r + .587 * g + .114 * b < 200) dark++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++;
      }
      const n = data.length / 4;
      return dark / n < .14 && colored / n < .05;
    } finally { bitmap.close(); }
  }

  // 模块 4：高品质呈现。hero 用源图整图，detail 用裁切放大后的局部；都走 final 两段采样（Qwen 走 1024 通道，云端走编辑接口）。
  async function generateStudio(options) {
    const { source, signal, onStatus } = options;
    const shot = options.shot === 'detail' ? 'detail' : 'hero';
    const size = options.size;
    onStatus?.(shot === 'detail' ? '正在裁出特写区域…' : '正在准备棚拍主图…');
    const image = shot === 'detail' ? (await cropDetail(source, options.selection)).image : source;
    signal?.throwIfAborted();
    const fit = async blob => {
      if (!size) return blob;
      const got = await sizeOf(blob);
      return got.width === size.width && got.height === size.height ? blob : fitTo(blob, size.width, size.height);
    };
    if (options.provider === 'runninghub' || options.provider === 'imageapi') {
      const custom = options.provider === 'imageapi', render = custom ? profileRender : cloudRender;
      onStatus?.(custom ? '正在请求图片接口…' : '正在上传 RunningHub 并排队…');
      const prompt = cloudPrompt('studio', String(options.prompt || '').trim(), [], false);
      return fit(await render({ model:options.cloudModel, apiProfile:options.apiProfile, mode:options.mode, resolution:options.resolution,
        prompt, image, references:[], signal, size }));
    }
    const prompt = [String(options.prompt || '').trim(), intents.studio].filter(Boolean).join(' ');
    const negative = 'lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, watermark, unwanted text, duplicate objects, clutter, deformed, oversaturated, sketch lines';
    const shared = { endpoint:options.endpoint, checkpoint:options.checkpoint, prompt, seed:options.seed, slot:options.slot, signal, onStatus };
    if (/^qwen[_ ]?image[_ ]?2\.?1/i.test(String(options.checkpoint || ''))) {
      const { blob } = await window.WuyingComfy.renderQwen({ ...shared, negative, sourceImage:image });
      signal?.throwIfAborted();
      return fit(blob);
    }
    const controlnet = String(options.controlnet || '').trim();
    if (controlnet && await looksLikeSketch(image)) {
      // 源图还是线稿：img2img 只会把线描一遍，改为 ControlNet 锁轮廓、从噪声出图，再走 final 第二段精修。
      onStatus?.('源图是线稿，按轮廓生成棚拍图…');
      const aligned = await alignedInput(image, true, signal);
      signal?.throwIfAborted();
      const { blob } = await window.WuyingComfy.renderLive({ ...shared, input:'sketch', quality:'final', sourceImage:aligned.image,
        colorGuideImage:aligned.guide, controlnet, strength:.9, latentWidth:960, latentHeight:768, tier:'quality', negative });
      signal?.throwIfAborted();
      return fit(await cropResult(blob, aligned.bounds));
    }
    const amount = Number.isFinite(options.strength) ? clamp(options.strength, .25, .95) : .4;
    const [maximum, minimum] = preservation.studio;
    const strength = maximum - (maximum - minimum) * (amount - .25) / .7;
    const aligned = await alignedInput(image, false, signal);
    signal?.throwIfAborted();
    const { blob } = await window.WuyingComfy.renderLive({ ...shared, input:'image', quality:'final', sourceImage:aligned.image,
      strength, latentWidth:960, latentHeight:768, tier:'quality', negative });
    signal?.throwIfAborted();
    return fit(await cropResult(blob, aligned.bounds));
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
    if (kind === 'scene') return generateScene(options);
    if (kind === 'studio') return generateStudio(options);
    if (options.provider === 'runninghub' || options.provider === 'imageapi') {
      const regional = kind === 'modify' && !!selection?.length;
      if (regional && !window.WuyingImageSelection.enough(selection)) throw new Error('请选择一块有效区域。');
      return generateCloud(options, regional);
    }
    // Single-image local models receive one conditioning sheet. Return only the primary camera panel.
    if(options.references?.some(ref=>ref.role.startsWith('ortho-'))){
      const main=await createImageBitmap(source);
      try{
        const w=main.width,h=main.height,side=Math.ceil(w/3),sheet=makeCanvas(w+side,h),ctx=sheet.getContext('2d');
        ctx.fillStyle='#fff';ctx.fillRect(0,0,sheet.width,h);ctx.drawImage(main,0,0);
        for(const [i,ref] of options.references.entries()){
          const bitmap=await createImageBitmap(ref.blob);
          try{const k=Math.min(side/bitmap.width,h/3/bitmap.height);
            ctx.drawImage(bitmap,w+(side-bitmap.width*k)/2,h*(i+.5)/3-bitmap.height*k/2,bitmap.width*k,bitmap.height*k);
          }finally{bitmap.close();}
        }
        onStatus?.('白模与正、左、俯三张结构参考已组成模型输入。');
        const result=await generate({...options,source:await toPng(sheet),moldSheet:true,references:[],size:{width:sheet.width,height:h},
          prompt:options.prompt+' Main left panel: finish the confirmed clay model. Right panels are front, left and top geometry references. Preserve the panel layout.'});
        const bitmap=await createImageBitmap(result);
        try{const output=makeCanvas(options.size?.width||w,options.size?.height||h);
          output.getContext('2d').drawImage(bitmap,0,0,bitmap.width*w/sheet.width,bitmap.height,0,0,output.width,output.height);
          return await toPng(output);
        }finally{bitmap.close();}
      }finally{main.close();}
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
    // 造型探索：风格底词 + 倾向词追加在用户描述之后，意图换成「找形」而非「出成品」。
    const plan = options.explore && typeof options.explore === 'object' ? explorePlan(options.explore) : null;
    const intent = plan && (kind === 'render' || kind === 'instant')
      ? 'Explore the form of the sketched product. Keep it readable as the same product category; define volume and value, not materials.'
      : intents[kind];
    // 造型探索把风格底词放在最前：CLIP 只有 77 token，开头的词权重最高，
    // 风格写在用户描述之后经常被挤掉（分了块也可能整块被稀释）。
    const prompt = (plan
      ? [plan.style, String(options.prompt || '').trim(), ...refPrompts, intent]
      : [String(options.prompt || '').trim(), ...refPrompts, intent]).filter(Boolean).join(' ');
    const shared = { endpoint, checkpoint, prompt, seed, slot, signal, onStatus };
    signal?.throwIfAborted();

    // 结构锁定视角：请求带了按造型数据投影的结构线稿时，几何一律以它为准。
    // 云端通道同样把结构线稿作为 img2img 源图，禁止脱离现有造型自由发挥。
    const structureLocked = kind === 'view' && isPng(options.structureImage);
    const finalPrompt = structureLocked ? [prompt, geometryLockPrompt].filter(Boolean).join(' ') : prompt;

    // Qwen-Image-2.1 通道：整图与实时预览共用同一条链路（分体式 diffusion 不能走 SD 实时工作流）。
    // 参考图已正确接线后，造型、部件与画面比例都跟着参考图走，不再出现「随便出一个产品」。
    const qwenModel = /^qwen[_ ]?image[_ ]?2\.?1/i.test(String(checkpoint || ''));
    if (qwenModel) {
      if (editRegion) throw new Error('选区重绘请换 SD1.5 模型；Qwen-Image-2.1 支持整图渲染与改稿。');
      signal?.throwIfAborted();
      const reference = structureLocked ? options.structureImage : source;
      // 实时预览按档位压分辨率换响应；出图按目标尺寸取 1k/1.5k，8G 显存下上限 1024。
      const resolution = options.live
        ? ({ speed: 512, balanced: 576, quality: 640 }[options.liveTier] || 576)
        : qwenResolution(options.resolution);
      const { blob } = await comfy.renderQwen({
        ...shared,
        // 造型探索时不能带产品摄影脚手架——那一套会直接把草图推成照片级成品，
        // 与「草图阶段只找形」的定位相反。风格底词已经写进 prompt。
        prompt: [finalPrompt, (plan || options.live) ? '' : qwenDirective].filter(Boolean).join(' '),
        negative: plan ? plan.negative : qwenNegative,
        sourceImage: reference,
        resolution,
        // 出图多给 4 步（Turbo 默认 8 步，12 步边缘与材质过渡明显更干净）；实时帧仍用 8 步保响应。
        steps: options.live ? 8 : 12,
        cancelPending: !!options.live
      });
      signal?.throwIfAborted();
      const size = options.size;
      if (size) {
        const got = await sizeOf(blob);
        if (got.width !== size.width || got.height !== size.height) return fitTo(blob, size.width, size.height);
      }
      return blob;
    }

    if (structureLocked && (options.provider === 'runninghub' || options.provider === 'imageapi')) {
      // 云端重新走 cloudPrompt 组装，这里只追加几何锁定的指令
      return generateCloud({ ...options, source: options.structureImage,
        prompt: [String(options.prompt || '').trim(), geometryLockPrompt].filter(Boolean).join(' ') },
        kind === 'modify' && !!selection?.length);
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

    onStatus?.(structureLocked ? '正在按造型结构锁定视角…' : '正在准备源图…');
    const sketch = !options.moldSheet&&(kind === 'render' || kind === 'instant' || structureLocked);
    let controlnet = sketch ? String(options.controlnet || '').trim() : '';
    // 结构锁定的条件图是造型投影线稿；没配 ControlNet 时自动挑一个 scribble/lineart
    if (structureLocked && !controlnet && !sharedControlnetCache) {
      try {
        const base = String(endpoint || 'http://127.0.0.1:8188').replace(/\/+$/, '');
        const data = await (await fetch(base + '/object_info/ControlNetLoader', { signal })).json();
        const names = data?.ControlNetLoader?.input?.required?.control_net_name?.[0] || [];
        sharedControlnetCache = names.find(name => /scribble|lineart|line[_-]art/i.test(name)) || names[0] || '';
      } catch { sharedControlnetCache = ''; }
    }
    if (structureLocked && !controlnet) controlnet = sharedControlnetCache;
    // 结构锁定时几何以投影线稿为准：条件图换成结构线稿（草图只作背景参考不再控形）
    const conditionSource = structureLocked ? options.structureImage : source;
    const tier=['speed','balanced','quality'].includes(options.liveTier)?options.liveTier:'balanced';
    const latentScale=tier==='speed'?.5:tier==='quality'?.75:.625;
    const latentWidth=Math.round(modelWidth*latentScale/8)*8, latentHeight=Math.round(modelHeight*latentScale/8)*8;
    const nativeSketch=!!(plan && options.live && sketch);
    const { image, guide, bounds, margins } = await alignedInput(conditionSource, !!controlnet, signal,
      nativeSketch?latentWidth:modelWidth,nativeSketch?latentHeight:modelHeight,nativeSketch && plan.id!=='loose');
    signal?.throwIfAborted();
    let strength = amount;
    let endPercent;
    let controlStrength;
    let denoiseOverride=options.moldSheet ? .28 : undefined;
    if (structureLocked) {
      // 视角生成必须贴合造型：ControlNet 全程控制（strength ≥ .8，end_percent = 1）
      strength = Math.max(amount, .82);
      endPercent = 1;
    } else if (plan && sketch) {
      // 造型探索：三档直接给 ControlNet 强度、重画力度和控制截断点，
      // 不再从滑块的单一 strength 反推，贴线档才能真的只补明暗。
      controlStrength = plan.controlStrength;
      denoiseOverride = plan.denoise;
      endPercent = plan.endPercent;
      strength = plan.controlStrength;
    } else if (sketch) {
      // 草图影响力（对标方案 §7.3 Drawing Influence）：0–1.5，联动 end_percent 提前截断控制。
      // 实时渲染不传 influence，走原 strength 行为，链路完全不变。
      if (Number.isFinite(options.influence)) {
        const mapping = influenceMapping(options.influence);
        strength = mapping.strength;
        endPercent = mapping.endPercent;
      }
    } else if(!options.moldSheet) {
      const [maximum, minimum] = preservation[kind];
      strength = maximum - (maximum - minimum) * (amount - .25) / .7;
    }
    const sharedWithPrompt = structureLocked ? { ...shared, prompt: finalPrompt } : shared;
    // 实时分辨率跟随档位：始终是 1280×1024 的等比缩放并 8 对齐，裁切坐标系不变。
    const { blob } = await comfy.renderLive({ ...sharedWithPrompt, input:sketch ? 'sketch' : 'image',
      quality:options.live?'live':options.preview?'preview':'final', sourceImage:image, colorGuideImage:guide, controlnet, strength,
      ...(controlStrength !== undefined ? { controlStrength } : {}),
      ...(denoiseOverride !== undefined ? { denoiseOverride } : {}),
      ...(endPercent !== undefined ? { endPercent } : {}),
      latentWidth,latentHeight,tier,sketchPreview:nativeSketch,
      onPreview:nativeSketch?options.onPreview:undefined,
      negative:plan ? plan.negative
        : 'lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, watermark, unwanted text, duplicate objects, clutter, bad anatomy, deformed, oversaturated'
    });
    signal?.throwIfAborted();
    const mergedSize=nativeSketch && options.size;
    const output = await cropResult(blob, bounds, mergedSize, margins);
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

  window.WuyingWorkspaceRender = { generate, cloudPrompt, detailBox, looksLikeSketch, imagePalette, createLatestPreview, liveSnapshot, themeDirective, influenceMapping,
    canonicalViewAngles, resolveViewAngle, structureSketchBlob, orthoSnapshot, orthographicDrawing, qwenResolution, qwenDirective, qwenNegative,
    renderSceneBoard, sceneBoardDefaults,
    exploreTiers, exploreTier, exploreTendencies, tendencySelection, sketchTendencyDirective, sketchStyleDirective, sketchNegative, explorePlan };
})();
