(() => {
  'use strict';

  const uid=()=>crypto.randomUUID();
  const prefsKey='wuying-workspace-model-v1';
  const names={instant:'快速渲染',render:'提示渲染',explore:'方案发散',scene:'情境渲染',studio:'高品质呈现',modify:'修改',color:'配色',form:'造型',view:'新视角',cutout:'去除背景',upscale:'放大 2×',outpaint:'扩展画布'};
  // 跟随草图线条出图的操作：都走草图影响力口径与 ControlNet 控形。
  const sketchKinds=['instant','render','explore'];
  // 方案发散（对标 Vizcom 的多方案并排）：同一张草图按不同设计方向各出一张，轮廓由 ControlNet 锁定。
  const directionPresets={
    minimal:{label:'极简几何',prompt:'Minimal geometric design language: flat planes, crisp edges, matte white and light grey, restrained detailing.'},
    organic:{label:'有机流线',prompt:'Organic streamlined design language: soft continuous surfaces, smooth transitions, satin finish in warm sand tones.'},
    rugged:{label:'硬朗工业',prompt:'Rugged industrial design language: chamfered edges, visible fasteners, dark anodized metal with rubberized accents.'},
    retro:{label:'温润复古',prompt:'Warm retro design language: rounded forms, walnut wood and brushed brass, cream enamel paint.'},
    tech:{label:'科技未来',prompt:'Futuristic tech design language: glossy black glass, thin light strips, precise seams, cool blue accent light.'},
    playful:{label:'亲和活泼',prompt:'Playful friendly design language: chunky soft forms, saturated coral and teal colors, glossy plastic.'}
  };
  const directionLimit=6;
  // 模块 4：高品质呈现。hero=棚拍主图（长边 1280，跟随源图比例），detail=材质特写（1280×1024，选区或中心裁切后重采样）。
  const shotPresets={
    hero:{label:'棚拍主图',prompt:'Studio product hero shot of the same product on a seamless light grey backdrop. Large softbox key light, subtle rim light, soft contact shadow, crisp focus, high-end commercial product photography. Preserve the exact silhouette, proportions, parts, colors and camera angle.'},
    detail:{label:'材质特写',prompt:'Macro close-up product photograph of this part of the product. Fine surface texture, precise seams, chamfers and edges, shallow depth of field, soft studio lighting. Keep the same shapes, layout and colors as the crop.'}
  };
  const materialPresets={
    auto:{label:'沿用现有材质',prompt:'the existing materials and finishes, rendered with realistic surface texture'},
    plastic:{label:'哑光塑料',prompt:'matte injection-molded plastic with a fine sandblasted texture'},
    aluminum:{label:'阳极氧化铝',prompt:'bead-blasted anodized aluminum with soft specular highlights'},
    steel:{label:'拉丝不锈钢',prompt:'brushed stainless steel with fine directional grain'},
    wood:{label:'胡桃木',prompt:'oiled walnut wood with visible natural grain'},
    ceramic:{label:'釉面陶瓷',prompt:'glazed ceramic with a smooth glossy surface'},
    fabric:{label:'针织织物',prompt:'woven knit fabric with visible threads'},
    leather:{label:'皮革',prompt:'fine-grain leather with stitched edges'}
  };
  function normalizeShots(value) {
    if(!Array.isArray(value)) return [];
    return [...new Set(value.filter(key=>typeof key==='string'&&Object.hasOwn(shotPresets,key)))];
  }
  // 主图长边 1280、跟随源图比例并 8 对齐；特写固定 1280×1024。
  function shotSize(shot,source) {
    if(shot==='detail') return {width:1280,height:1024};
    const w=Number(source?.width)||1280,h=Number(source?.height)||1024,long=1280;
    const r=w/h,align=v=>Math.max(64,Math.round(v/8)*8);
    return r>=1?{width:long,height:align(long/r)}:{width:align(long*r),height:long};
  }
  function studioPrompt(shot,material,text) {
    const surface=(materialPresets[material]||materialPresets.auto).prompt;
    return [text,shotPresets[shot].prompt,'Materials: '+surface+'.'].filter(Boolean).join(' ').slice(0,5000);
  }
  function normalizeDirections(value) {
    if(!Array.isArray(value)) return [];
    return [...new Set(value.filter(key=>typeof key==='string'&&Object.hasOwn(directionPresets,key)))].slice(0,directionLimit);
  }
  const isImageTool=kind=>kind==='cutout'||kind==='upscale';
  const fidelityStages={
    line:{label:'整理线稿',prompt:'Clean product line art with even, precise strokes on plain white paper. No color fills, shading or material texture.'},
    color:{label:'平面色块',prompt:'Apply flat color blocking to the product surfaces. Keep clean outlines. No shading, highlights, gradients or material texture.'},
    shaded:{label:'明暗体积',prompt:'Add controlled highlights and shadows to show the product volume. Keep its existing colors, geometry and viewpoint.'},
    realistic:{label:'写实渲染',prompt:'Create a photoreal product rendering with credible materials and soft studio lighting. Preserve the design and existing colors.'}
  };
  const fidelityOptions=[['auto','自动推进'],...Object.entries(fidelityStages).map(([key,item])=>[key,item.label])];
  function resolveFidelity(doc,asset,requested='auto') {
    if(Object.hasOwn(fidelityStages,requested)) return requested;
    const top=asset?.layers?.filter(layer=>layer.visible!==false&&(layer.opacity??1)>0).at(-1);
    const prior=top?.blobId&&Object.values(doc.jobs||{}).find(job=>
      job.kind==='instant'&&job.outputs?.some(output=>output.blobId===top.blobId));
    const order=Object.keys(fidelityStages), index=order.indexOf(prior?.settings?.targetFidelity);
    return index<0?'color':order[Math.min(index+1,order.length-1)];
  }

  const formPresets={
    expression:{label:'造型语言',x:['装饰','简洁','ornamented','minimal'],y:['几何','有机','geometric','organic']},
    proportion:{label:'比例',x:['窄','宽','narrower','wider'],y:['低矮','高挑','lower in height','taller']},
    massing:{label:'体量',x:['轻薄','厚重','slender','substantial'],y:['分件','整体','more visibly segmented','more unified']},
    edges:{label:'边缘',x:['锐利','圆润','sharper-edged','more rounded'],y:['细窄','宽厚','narrowly beveled','broadly beveled']},
    balance:{label:'平衡',x:['对称','非对称','more symmetrical','more asymmetrical'],y:['下沉','上提','visually weighted toward the base','visually weighted toward the top']},
    flow:{label:'曲面',x:['折线','流线','more angular in its transitions','more streamlined'],y:['断开','连续','visually separated at transitions','continuous at transitions']}
  };
  const viewBatchLimit=6;
  const viewPresets={
    'rear-left':{label:'左后',prompt:'Rear-left three-quarter view, 45° from directly behind the product.'},
    rear:{label:'后视',prompt:'Straight-on rear view at eye level, facing the back of the product.'},
    'rear-right':{label:'右后',prompt:'Rear-right three-quarter view, 45° from directly behind the product.'},
    left:{label:'左视',prompt:'Left side profile at eye level, perpendicular to the front of the product.'},
    right:{label:'右视',prompt:'Right side profile at eye level, perpendicular to the front of the product.'},
    'front-left':{label:'左前',prompt:'Front-left three-quarter view, 45° from directly in front of the product.'},
    front:{label:'正视',prompt:'Straight-on front view at eye level, facing the front of the product.'},
    'front-right':{label:'右前',prompt:'Front-right three-quarter view, 45° from directly in front of the product.'},
    top:{label:'俯视',prompt:'Direct overhead view, looking vertically down onto the top of the product.',secondary:true},
    elevated:{label:'前上方',prompt:'Elevated front view, looking down at the product from 45° above its front.',secondary:true},
    bottom:{label:'底视',prompt:'Direct underside view, looking vertically up at the bottom of the product without inverting or mirroring it.',secondary:true}
  };
  function normalizeViews(views) {
    if(!Array.isArray(views)) return [];
    return [...new Set(views.filter(view=>typeof view==='string'&&Object.hasOwn(viewPresets,view)))].slice(0,viewBatchLimit);
  }

  const quantityOptions=kind=>kind==='color'?[1,2,4,8,16]:[1,2,4];
  function quantityFor(kind,value) {
    const count=Number(value);
    return quantityOptions(kind).includes(count)?count:1;
  }
  function normalizeForm(value) {
    if(!value||!Object.hasOwn(formPresets,value.preset)) return {preset:'expression',x:0,y:0};
    const axis=offset=>Number.isFinite(offset)?Math.max(-100,Math.min(100,Math.round(offset))):0;
    return {preset:value.preset,x:axis(value.x),y:axis(value.y)};
  }
  function normalizePalette(value) {
    if(!Array.isArray(value)) return [];
    return [...new Set(value.filter(color=>typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color)).map(color=>color.toLowerCase()))].slice(0,10);
  }
  function variationPrompt(form,palette) {
    if(palette.length){
      return 'Target product colors: '+palette.join(', ')+'. Apply these hues to the product surfaces. Prefer them if any reference colors differ.';
    }
    if(!form) return '';
    const preset=formPresets[form.preset], axes=[];
    for(const key of ['x','y']){
      const value=form[key];
      if(!value) continue;
      const magnitude=Math.abs(value), amount=magnitude<34?'slightly':magnitude<68?'noticeably':'substantially';
      axes.push(amount+' '+preset[key][value<0?2:3]);
    }
    return axes.length?'Make the product form '+axes.join(' and ')+'. Preserve its function and identifiable parts.':'';
  }

  function prefs(key) {
    try {return JSON.parse(localStorage.getItem(key)||'{}')||{};} catch{return {};}
  }
  function modelPrefs() {
    const legacy=prefs('wuying.liveModels'), region=prefs('wuying-region-model-v1');
    let endpoint;
    try {endpoint=localStorage.getItem('wuying.comfyEndpoint');} catch{}
    return {endpoint:region.endpoint||endpoint||'http://127.0.0.1:8188',
      checkpoint:region.checkpoint||legacy.checkpoint||'',controlnet:legacy.controlnet||'',...prefs(prefsKey)};
  }
  const imageToolEndpoint=()=>prefs(prefsKey).endpoint||'http://127.0.0.1:8188';
  const cloudModels=['qwen-image-2.0-edit','seedream-v4.5','seedream-v5-pro','omni-v2','omni-g2'];
  function saveModel(settings) {
    const saved={...prefs(prefsKey)};
    for(const key of ['endpoint','checkpoint','controlnet','provider','cloudModel','apiProfileId','apiProfileName']) if(typeof settings[key]==='string') saved[key]=settings[key];
    try{localStorage.setItem(prefsKey,JSON.stringify(saved));}catch{}
  }
  function checkModel(endpoint,options) {return window.WuyingComfy.testConnection(endpoint,options);}
  async function checkCloud({signal}={}) {
    let response;
    try{response=await fetch('http://127.0.0.1:8882/api/runninghub/test',{method:'POST',cache:'no-store',signal,
      headers:{'Content-Type':'application/json'},body:'{}'});}
    catch(error){if(signal?.aborted)throw error;throw new Error('连不上本机出图后台。请先双击「启动出图后台.cmd」。');}
    const data=await response.json().catch(()=>null);
    if(!response.ok) throw new Error(data?.error||'RunningHub 连接失败。');
    return data;
  }
  function providerLabel(p=modelPrefs()) {
    if(p.provider==='imageapi') return '图片 API · '+(p.apiProfileName||'已选接口');
    if(p.provider==='runninghub') return 'RunningHub · '+(p.cloudModel||cloudModels[0]);
    return p.checkpoint?'ComfyUI · '+p.checkpoint:'';
  }
  function ready(p=modelPrefs()) {
    if(p.provider==='imageapi') return !!p.apiProfileId;
    return p.provider==='runninghub'?cloudModels.includes(p.cloudModel||cloudModels[0]):!!(p.endpoint&&p.checkpoint);
  }

  const validRoles=['color','material','style'];
  const aspects={'1:1':1,'4:3':4/3,'3:4':3/4,'3:2':3/2,'2:3':2/3,'16:9':16/9,'9:16':9/16,'21:9':21/9};
  const tiers={'1k':1024,'2k':2048,'4k':4096};
  const blockDefaults={prompt:'',quantity:1,strength:.65,aspect:'original',customW:4,customH:3,mode:'standard',resolution:'match',style:'none',fidelity:'auto',stageStyle:'none'};
  // 风格预设（借鉴 OpenViz 的 Style Presets）：附在提示末尾，不覆盖用户原文。
  const stylePresets={
    none:{label:'无风格',text:''},
    photo:{label:'写实产品摄影',text:'写实产品摄影，棚拍柔光箱布光，干净的无缝背景'},
    keyshot:{label:'KeyShot 渲染',text:'高端 KeyShot 风格渲染，材质准确，棚拍 HDRI 反射'},
    clay:{label:'白模',text:'哑光白色黏土渲染，柔和环境光遮蔽，无纹理'},
    marker:{label:'马克笔效果图',text:'工业设计马克笔效果图，利落线条，快速明暗'},
    cmf:{label:'CMF 展示',text:'CMF 展示图，颜色、材质、表面处理清晰可辨'}
  };
  function composePrompt(prompt,style) {
    const text=stylePresets[style]?.text, base=String(prompt||'').trim();
    return (text?(base?base+'\n风格：'+text:'风格：'+text):base).slice(0,5000);
  }
  const cloudNames={'qwen-image-2.0-edit':'千问 2.0 图像编辑','seedream-v4.5':'Seedream 4.5','seedream-v5-pro':'Seedream V5 Pro · 稳定版','omni-v2':'全能图片 V2','omni-g2':'全能图片 G-2 · 高质量'};
  // Seedream V5 Pro 是显式选用的模型，其他 Pro 请求沿用全能 G-2 高质量档。
  // 千问 2.0 最多收 3 张图；连了 4 张时 Standard 自动换成全能图片 V2。
  function resolveCloudModel(mode,chosen,imageCount) {
    if(chosen==='seedream-v5-pro') return chosen;
    let model=mode==='pro'?'omni-g2':String(chosen||cloudModels[0]);
    if(model==='qwen-image-2.0-edit'&&imageCount>3) model='omni-v2';
    return model;
  }
  // 生成前的说明（借鉴 Toonflow「花钱的生成先说清要生成什么、生成几张」）。
  function runSummary(block,primary,p=modelPrefs()) {
    const b=migrateBlock(block), count=(b.kind==='view'&&normalizeViews(b.views).length)||(b.kind==='explore'&&normalizeDirections(b.directions).length)||quantityFor(b.kind,b.quantity);
    let size=null;
    try{if(primary) size=outputSize(primary,b);}catch{}
    if(isImageTool(b.kind)){
      const model=b.kind==='cutout'?'BiRefNet':'Lanczos / UltraSharp';
      return {cloud:false,model,count:1,size,text:['本机 ComfyUI',model,size&&size.width+' × '+size.height].filter(Boolean).join(' · ')};
    }
    const cloud=p.provider==='runninghub'||p.provider==='imageapi';
    if(p.provider==='imageapi'){
      const model=p.apiProfileName||'已选接口';
      const parts=[providerLabel(p),count+' 张'];
      if(size) parts.push(size.width+' × '+size.height);
      return {cloud,model,count,size,text:parts.join(' · ')+' · 按接口计费'};
    }
    const model=cloud?resolveCloudModel(b.kind==='instant'?'standard':b.mode,p.cloudModel,(b.inputs||[]).length):p.checkpoint||'';
    const parts=[cloud?'RunningHub · '+(cloudNames[model]||model):model?'ComfyUI · '+model:'未选择模型',count+' 张'];
    if(model==='seedream-v5-pro') parts.push('模型 2K');
    if(size) parts.push(size.width+' × '+size.height);
    return {cloud,model,count,size,text:parts.join(' · ')+(cloud?' · 按次计费':' · 本机出图')};
  }

  // 旧 block 用 sourceId + references；新模型对齐 Vizcom：inputs 最多 4 张，最后一张是主图。
  function migrateBlock(block) {
    if(Array.isArray(block.inputs)) return block;
    const refs=Array.isArray(block.references)?block.references:[];
    const ids=[...refs.map(ref=>ref?.id),block.sourceId].filter(id=>typeof id==='string'&&id);
    const inputs=[...new Set(ids.reverse())].reverse().slice(-4);
    const roles={};
    for(const ref of refs) if(ref?.id&&ref.id!==block.sourceId&&validRoles.includes(ref.role)) roles[ref.id]=ref.role;
    const next={...blockDefaults,...block,inputs,roles};
    delete next.sourceId; delete next.references;
    return next;
  }

  function ratioOf({aspect,customW,customH},source) {
    if(aspect==='custom'){
      const w=Number(customW), h=Number(customH);
      if(!(w>0&&h>0)) throw new Error('自定义比例需填写正数。');
      const r=w/h;
      if(r>4||r<1/4) throw new Error('自定义比例最大 4:1。');
      return r;
    }
    if(Object.hasOwn(aspects,aspect)) return aspects[aspect];
    return source.width/source.height;
  }

  // 输出像素尺寸：Original + Match source 保持源图尺寸；其余按比例和分辨率档位的长边算。
  function outputSize(source,settings={}) {
    if(settings.kind==='instant'||settings.kind==='cutout') return {width:source.width,height:source.height};
    if(settings.kind==='upscale'){
      const scale=Math.min(2,4096/Math.max(source.width,source.height));
      return {width:Math.max(1,Math.round(source.width*scale)),height:Math.max(1,Math.round(source.height*scale))};
    }
    const ratio=ratioOf(settings,source);
    const tier=tiers[settings.resolution];
    if((!settings.aspect||settings.aspect==='original')&&!tier) return {width:source.width,height:source.height};
    const long=tier||Math.max(source.width,source.height);
    const width=ratio>=1?long:Math.round(long*ratio), height=ratio>=1?Math.round(long/ratio):long;
    return {width:Math.max(64,width),height:Math.max(64,height)};
  }
  function cloudResolution(size,resolution) {
    if(Object.hasOwn(tiers,resolution)) return resolution;
    const long=Math.max(size.width,size.height);
    return long<=1536?'1k':long<=3072?'2k':'4k';
  }

  // 从 block 生成一次出图请求（不含模型连接设置）。
  function blockRequest(block) {
    const b=migrateBlock(block);
    return {kind:b.kind,blockId:b.id,inputs:[...b.inputs],roles:{...(b.roles||{})},prompt:b.prompt||'',
      quantity:b.quantity,strength:b.strength,...(b.influence!==undefined?{influence:b.influence}:{}),aspect:b.aspect,customW:b.customW,customH:b.customH,
      mode:b.mode,resolution:b.resolution,style:b.style,fidelity:b.fidelity,stageStyle:b.stageStyle,form:b.form,palette:b.palette,views:b.views,directions:b.directions};
  }

  // 模块 5：未圈选时按草图自动定区：笔触点外扩（笔宽一半 + 草图尺寸 10%，至少 3%）后取凸包，
  // 比矩形包围盒少重绘大块背景，减少墙线、桌沿在选区边上错位。坐标按像素算，避免非方形画布变形。
  function sketchBounds(strokes,asset){
    const w=Number(asset.width)||1024,h=Number(asset.height)||768;
    const points=strokes.flatMap(stroke=>stroke.points.map(p=>({x:p.x*w,y:p.y*h,half:(Number(stroke.size)||4)/2})));
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const spanX=Math.max(...xs)-Math.min(...xs),spanY=Math.max(...ys)-Math.min(...ys);
    if(spanX<w*.015&&spanY<h*.015) throw new Error('草图范围太小，请画大一些，或用套索圈出产品区域。');
    const grow=Math.max(Math.min(w,h)*.03,Math.max(spanX,spanY)*.1);
    const cloud=[];
    for(const p of points) for(let k=0;k<12;k++){
      const angle=k*Math.PI/6,r=grow+p.half;
      cloud.push([Math.min(w,Math.max(0,p.x+Math.cos(angle)*r)),Math.min(h,Math.max(0,p.y+Math.sin(angle)*r))]);
    }
    cloud.sort((p,q)=>p[0]-q[0]||p[1]-q[1]);
    const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
    const half=list=>{const out=[];for(const p of list){while(out.length>=2&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}out.pop();return out;};
    const hull=[...half(cloud),...half(cloud.slice().reverse())];
    const round=v=>Math.round(v*1e4)/1e4;
    return hull.map(([x,y])=>({x:round(x/w),y:round(y/h)}));
  }
  function sceneParts(asset){
    const visible=(asset.layers||[]).filter(layer=>layer.visible!==false&&(layer.opacity??1)>0);
    const photos=visible.filter(layer=>layer.kind==='image'&&layer.blobId);
    const strokes=visible.filter(layer=>layer.kind==='ink').flatMap(layer=>layer.strokes||[]).filter(stroke=>!stroke.erase&&stroke.points?.length);
    return {photos,strokes};
  }

  function normalizeSelection(points) {
    if (!points?.length) return [];
    if (!Array.isArray(points)||points.length>1200||!points.every(point=>
      Number.isFinite(point?.x)&&point.x>=0&&point.x<=1&&Number.isFinite(point.y)&&point.y>=0&&point.y<=1)
      ||!window.WuyingImageSelection.enough(points)) throw new Error('请选择一块有效区域。');
    return points.map(({x,y})=>({x,y}));
  }

  function position(doc,block,index) {
    const x=block.x+320;
    let y=block.y+index*255;
    while(Object.values(doc.assets).some(asset=>Math.abs(asset.x-x)<238&&Math.abs(asset.y-y)<224)
      ||Object.values(doc.blocks).some(item=>Math.abs(item.x-x)<240&&Math.abs(item.y-y)<224)) y+=255;
    return {x,y};
  }

  function addResultAsset(doc,job,output,point) {
    if (doc.assets[output.id]) return;
    doc.assets[output.id]={
      id:output.id,name:output.name,...point,width:output.width,height:output.height,
      createdAt:Date.now(),updatedAt:Date.now(),jobId:job.id,...(output.transparent?{transparent:true}:{}),
      layers:[{id:uid(),name:output.name,kind:'image',blobId:output.blobId,visible:true,opacity:1}]
    };
  }

  // 把单图编辑里的某个候选放上工作台，成为独立图卡。
  // 图卡 id 沿用候选 id，工作台据 jobId 画出与源图的连线；重复上板返回同一张图卡。
  function promoteOutput(doc,jobId,outputId) {
    const job=doc.jobs?.[jobId], output=job?.outputs?.find(item=>item.id===outputId);
    if(!job||!output?.blobId) throw new Error('找不到这个候选。');
    if(doc.assets[output.id]) return output.id;
    const source=doc.assets[job.sourceId];
    const anchor=source||Object.values(doc.assets)[0]||{x:80,y:80};
    addResultAsset(doc,job,output,position(doc,anchor,0));
    return output.id;
  }

  function outpaintFrame(asset,{direction,percent}={}) {
    if(!['left','right','top','bottom'].includes(direction)||![25,50,75].includes(Number(percent))){
      throw new Error('请选择扩图方向和幅度。');
    }
    percent=Number(percent);
    const vertical=direction==='top'||direction==='bottom';
    const amount=Math.ceil((vertical?asset.height:asset.width)*percent/100);
    const width=asset.width+(vertical?0:amount), height=asset.height+(vertical?amount:0);
    if(width>4096||height>4096)throw new Error('扩图后的宽和高最多为 4096 像素。');
    return {direction,percent,x:direction==='left'?amount:0,y:direction==='top'?amount:0,width,height};
  }

  async function run(store,options,{signal,onStatus=()=>{}}={}) {
    signal?.throwIfAborted();
    const {blockId}=options;
    const doc=await store.read();
    // 以本次输入重跑：读取旧任务冻结的输入快照与选区，不读当前图层。
    const prior=options.rerunOf?doc.jobs[options.rerunOf]:undefined;
    if(options.rerunOf&&!prior?.inputBlobId) throw new Error('这一批没有保存输入快照，无法按原输入重跑。');
    const kind=prior?prior.kind:options.kind;
    if(!Object.hasOwn(names,kind)) throw new Error('未知的出图操作。');
    const imageTool=isImageTool(kind);
    // inputs：最多 4 张，最后一张是主图；旧调用的 sourceId + references 仍然可用。
    let inputs=null;
    if(!prior&&Array.isArray(options.inputs)){
      if(!options.inputs.length) throw new Error('请先连接一张源图。');
      if(options.inputs.length>4) throw new Error('每个节点最多连接四张图。');
      if(new Set(options.inputs).size!==options.inputs.length) throw new Error('同一张图不能重复连接。');
      inputs=options.inputs;
    }
    const sourceId=prior?prior.sourceId:inputs?inputs.at(-1):options.sourceId;
    const fixedInstructions=prior?.settings?.form||prior?.settings?.palette||prior?.settings?.views?.length||prior?.settings?.directions?.length||prior?.settings?.shots?.length;
    const prompt=String((fixedInstructions?prior.prompt:options.prompt??prior?.prompt)||'').trim().slice(0,5000);
    const asset=doc.assets[sourceId];
    if(!asset) throw new Error('请先连接一张源图。');
    let partRegion;
    if(!prior&&options.partId){
      if(kind!=='modify'||!asset.draft||asset.draft.revision!==options.draftRevision)
        throw new Error('部件草稿已更新，请重新读取后再生成。');
      partRegion=window.WuyingShapeModel.editRegion(asset.draft.parts,options.partId,asset);
    }
    if(!prior&&!partRegion&&asset.draft?.parts.some(part=>part.locked)&&(kind==='modify'||kind==='form')){
      throw new Error('该草稿有锁定部件，请进入部件编辑器选择要改的部件。');
    }
    const scene=kind==='scene', studio=kind==='studio';
    let sceneSelection=[];
    if(scene&&!prior){
      const {photos,strokes}=sceneParts(asset);
      if(!photos.length) throw new Error('情境渲染需要先上传一张场景照片。');
      if(!strokes.length) throw new Error('请先在照片上画出产品草图，再做情境渲染。');
      sceneSelection=options.selection?.length?normalizeSelection(options.selection):sketchBounds(strokes,asset);
    }
    if(scene&&prior&&!prior.scene) throw new Error('这批情境渲染缺少照片快照，无法按原输入重跑。');
    const selection=kind==='modify'?normalizeSelection(prior?prior.selection:partRegion?.points||options.selection):scene?(prior?prior.selection:sceneSelection):studio?normalizeSelection(prior?prior.selection:options.selection):[];
    const protectedAreas=prior?.protectedAreas||partRegion?.protectedAreas||[];
    const partSource=prior?.partSource||(partRegion?{
      id:options.partId,name:asset.draft.parts.find(part=>part.id===options.partId).name,revision:asset.draft.revision
    }:null);
    if(blockId&&!doc.blocks[blockId]) throw new Error('找不到出图节点。');
    if(!prior&&!asset.draft?.parts.length&&!asset.layers?.some(layer=>layer.visible!==false&&(layer.blobId||layer.strokes?.length))) throw new Error('先画几笔，或导入一张图再生成。');

    const roles=options.roles&&typeof options.roles==='object'?options.roles:{};
    const refs=prior?[]:inputs
      ? inputs.slice(0,-1).map(id=>({id,role:validRoles.includes(roles[id])?roles[id]:'style'}))
      : Array.isArray(options.references)?options.references.slice(0,3):[];
    const refsSeen=new Set();
    for(const reference of refs) {
      const ortho=['ortho-front','ortho-left','ortho-top'].includes(reference.role);
      if(ortho&&kind==='render'&&doc.jobs[reference.outputJobId]?.outputs.some(o=>o.id===reference.id&&o.view===reference.role.slice(6)&&o.blobId)&&!refsSeen.has(reference.id)){
        refsSeen.add(reference.id);continue;
      }
      if(!doc.assets[reference.id]||reference.id===sourceId||refsSeen.has(reference.id)||!validRoles.includes(reference.role)) {
        throw new Error('参考图连接无效。请为每张参考图指定用途。');
      }
      refsSeen.add(reference.id);
    }
    if(imageTool&&refs.length) throw new Error('图像工具只接入一张源图。');
    if(kind==='instant'&&refs.length>1) throw new Error('快速渲染最多添加一张参考图。');
    if(kind==='instant'&&refs.some(ref=>ref.role==='material')) throw new Error('请选择风格或配色参考。');
    const priorSettings=prior?.settings||{};
    const pick=(key,allowed,fallback)=>{const v=options[key]??priorSettings[key];return allowed.includes(v)?v:fallback;};
    const instant=kind==='instant';
    const fidelity=pick('fidelity',fidelityOptions.map(([key])=>key),'auto');
    const targetFidelity=instant?resolveFidelity(doc,asset,prior?.settings?.targetFidelity||fidelity):undefined;
    const aspect=instant||imageTool||scene||studio?'original':pick('aspect',['original','custom',...Object.keys(aspects)],'original');
    const customW=Number(options.customW??priorSettings.customW)||4, customH=Number(options.customH??priorSettings.customH)||3;
    const mode=instant?'standard':pick('mode',['standard','pro'],'standard');
    const resolution=instant||imageTool||scene||studio?'match':pick('resolution',['match','1k','2k','4k'],'match');
    let size=outputSize(asset,{kind,aspect,customW,customH,resolution});
    const expanding=kind==='outpaint';
    const outpaint=expanding?(prior?.settings?.outpaint||outpaintFrame(asset,options.outpaint)):undefined;
    if(outpaint)size={width:outpaint.width,height:outpaint.height};
    const priorRefs=prior?.references||[];
    const colorRef=refs.some(ref=>ref.role==='color')||priorRefs.some(ref=>ref.role==='color');
    const formValue=prior?priorSettings.form:options.form;
    const form=kind==='form'&&formValue?normalizeForm(formValue):undefined;
    const palette=kind==='color'?normalizePalette(prior?priorSettings.palette:options.palette):[];
    const direction=variationPrompt(form,palette);
    const views=kind==='view'?normalizeViews(prior?priorSettings.views:options.views):[];
    const directions=kind==='explore'?normalizeDirections(prior?priorSettings.directions:options.directions):[];
    if(kind==='explore'&&directions.length<2) throw new Error('方案发散至少选择两个设计方向。');
    const shots=studio?normalizeShots(prior?priorSettings.shots:options.shots??['hero','detail']):[];
    if(studio&&!shots.length) throw new Error('请至少选择一种呈现镜头：棚拍主图或材质特写。');
    const material=studio?(Object.hasOwn(materialPresets,prior?priorSettings.material:options.material)?(prior?priorSettings.material:options.material):'auto'):undefined;
    if(!imageTool&&!expanding&&!prompt&&!direction&&!views.length&&!sketchKinds.includes(kind)&&!scene&&!studio&&!(kind==='color'&&colorRef)){
      if(kind==='view') throw new Error('请选择视角，或描述想要的角度。');
      throw new Error(kind==='form'?'请选择造型方向，或补充想要的变化。':kind==='color'?'请添加目标色、配色参考或文字说明。':'请描述你想改的内容。');
    }
    const ortho=prior ? prior.ortho : options.orthographic && kind==='view' && asset.draft?.parts?.length
      ? window.WuyingWorkspaceRender.orthoSnapshot(asset) : null;
    if(ortho && (!views.length||views.some(view=>!['front','left','top'].includes(view))))
      throw new Error('标准投影仅支持正视、左视和俯视。');
    const defaults=modelPrefs();
    const chosen=options.provider||priorSettings.provider||defaults.provider;
    const provider=ortho?'projection':!partSource&&!imageTool&&!expanding&&(chosen==='runninghub'||chosen==='imageapi')?chosen:'comfy';
    const apiProfile=provider==='imageapi'
      ? await window.WuyingPlatformApi.getProfile(options.apiProfileId||priorSettings.apiProfileId||defaults.apiProfileId,{signal})
      : null;
    const imageCount=(prior?priorRefs.length:refs.length)+1;
    const cloudModel=resolveCloudModel(mode,options.cloudModel||defaults.cloudModel,imageCount);
    const style=instant?'none':pick('style',Object.keys(stylePresets),'none');
    const requestedStageStyle=prior ? priorSettings.stageStyle : options.stageStyle;
    const stageStyle=instant&&['shaded','realistic'].includes(targetFidelity)&&Object.hasOwn(stylePresets,requestedStageStyle)
      ? requestedStageStyle : 'none';
    const instructions=instant?composePrompt(fidelityStages[targetFidelity].prompt,stageStyle):composePrompt([direction,prompt].filter(Boolean).join('\n'),style);
    const renderPrompt=priorSettings.renderPrompt||instructions;
    const directionPrompts=Object.fromEntries(directions.map(key=>[
      key,priorSettings.directionPrompts?.[key]||[directionPresets[key].prompt,renderPrompt].filter(Boolean).join(' ').slice(0,5000)
    ]));
    const shotPrompts=Object.fromEntries(shots.map(shot=>[shot,priorSettings.shotPrompts?.[shot]||studioPrompt(shot,material,prompt)]));
    const shotSizes=Object.fromEntries(shots.map(shot=>[shot,priorSettings.shotSizes?.[shot]||shotSize(shot,asset)]));
    const viewPrompts=Object.fromEntries(views.map(view=>[
      view,priorSettings.viewPrompts?.[view]||('Target camera angle: '+viewPresets[view].prompt+' '+renderPrompt).trim().slice(0,5000)
    ]));
    const endpoint=imageTool?(priorSettings.endpoint||options.toolEndpoint||imageToolEndpoint()):
      provider==='comfy'?String(options.endpoint||defaults.endpoint||'').trim():'';
    const checkpoint=provider==='comfy'&&!imageTool?String(options.checkpoint||defaults.checkpoint||'').trim():'';
    if(provider==='comfy'&&!imageTool&&(!endpoint||!checkpoint)) throw new Error('请先连接 ComfyUI 并选择一个模型。');
    if(provider==='runninghub'&&!cloudModels.includes(cloudModel)) throw new Error('请选择一个 RunningHub 模型。');
    const controlnet=String(options.controlnet??defaults.controlnet??'');
    const distance=form?Math.hypot(form.x,form.y)/Math.SQRT2/100:0;
    const strengthValue=views.length&&prior?priorSettings.strength:options.strength??priorSettings.strength;
    let strength=distance
      ? priorSettings.strength??(.35+.60*distance)
      : Math.min(.95,Math.max(.25,Number(strengthValue)||(scene?.85:studio?.4:.65)));
    // 草图影响力（方案 §7.3）：render/instant 走 0–1.5 口径，旧项目回退 block.strength；其余 kind 保持调整幅度语义。
    const influenceKind=sketchKinds.includes(kind);
    const rawInfluence=influenceKind?options.influence??priorSettings.influence??options.strength??priorSettings.strength:undefined;
    const influence=influenceKind?(Number.isFinite(Number(rawInfluence))?Math.min(1.5,Math.max(0,Number(rawInfluence))):.8):undefined;
    if(influenceKind) strength=Math.min(1,influence);
    const quantity=imageTool||expanding?1:views.length||directions.length||shots.length||quantityFor(kind,options.quantity??priorSettings.quantity);
    const seed=Number.isSafeInteger(options.seed)&&options.seed>=0&&options.seed<=0xffffffff
      ? options.seed : crypto.getRandomValues(new Uint32Array(1))[0];
    const now=Date.now();
    const id=uid(), inputBlobId=uid();
    let source, references, sceneImages;
    const sceneIds=scene?(prior?.scene||{photoBlobId:uid(),sketchBlobId:uid()}):null;
    if(prior){
      // 重跑沿用旧快照的 blob，不复制图片。
      source=await store.getBlob(prior.inputBlobId);
      if(!source) throw new Error('输入快照已丢失，无法按原输入重跑。');
      if(scene){
        sceneImages={photo:await store.getBlob(sceneIds.photoBlobId),sketch:await store.getBlob(sceneIds.sketchBlobId)};
        if(!sceneImages.photo||!sceneImages.sketch) throw new Error('照片或草图快照已丢失，无法按原输入重跑。');
      }
      references=await Promise.all(priorRefs.map(async({id,role,blobId})=>{
        const blob=await store.getBlob(blobId);
        if(!blob) throw new Error('参考图快照已丢失，无法按原输入重跑。');
        return {id,role,blobId,blob,reused:true};
      }));
    }else{
      source=await window.WuyingWorkspaceComposite.toPng(asset,store);
      if(scene){
        // 照片底图（不含笔触）作为重绘底与合成底；草图单独成图作为 ControlNet 控形。
        const only=keep=>({...asset,draft:undefined,transparent:false,layers:(asset.layers||[]).filter(keep)});
        sceneImages={
          photo:await window.WuyingWorkspaceComposite.toPng(only(layer=>layer.kind!=='ink'),store),
          sketch:await window.WuyingWorkspaceComposite.toPng(only(layer=>layer.kind==='ink'),store)
        };
      }
      references=await Promise.all(refs.map(async({id,role,outputJobId})=>{
        const ref=role.startsWith('ortho-')?doc.jobs[outputJobId].outputs.find(o=>o.id===id):null;
        const blob=ref?await store.getBlob(ref.blobId):await window.WuyingWorkspaceComposite.toPng(doc.assets[id],store);
        if(!blob) throw new Error('缺少参考图像文件。');
        return {id,role,blobId:uid(),blob};
      }));
    }
    if(instant){
      const bitmap=await createImageBitmap(source);
      size={width:bitmap.width,height:bitmap.height};
      bitmap.close();
    }
    if(prior&&(partSource||imageTool||scene||form||palette.length||views.length||directions.length||shots.length)&&priorSettings.width>0&&priorSettings.height>0){
      size={width:priorSettings.width,height:priorSettings.height};
    }
    signal?.throwIfAborted();
    const connectionSettings=apiProfile?{provider,apiProfileId:apiProfile.id,apiProfileName:apiProfile.name,apiModel:apiProfile.model}:
      imageTool?{endpoint}:provider==='runninghub'?{provider,cloudModel}:{endpoint,checkpoint,controlnet};
    const job={id,kind,sourceId,sourceName:asset.name,inputBlobId:prior?prior.inputBlobId:inputBlobId,
      blockId:blockId||null,prompt:instant||imageTool?'':prompt,selection,rerunOf:prior?prior.id:undefined,
      references:references.map(({id,role,blobId})=>({id,role,blobId})),outputs:[],createdAt:now,status:'running',
      settings:{...connectionSettings,
        strength,quantity,seed,aspect,customW,customH,mode,resolution,style,width:size.width,height:size.height,
        ...(influenceKind?{influence}:{})}};
    if(ortho){job.ortho=ortho;job.settings.provider='projection';}
    if(outpaint)job.settings.outpaint=outpaint;
    if(partSource) Object.assign(job,{partSource,protectedAreas});
    if(scene) job.scene=sceneIds;
    if(asset.draft||prior?.draftRevision) job.draftRevision=prior?.draftRevision||asset.draft.revision;
    if(instant) Object.assign(job.settings,{fidelity,targetFidelity,stageStyle,renderPrompt});
    if(form) Object.assign(job.settings,{form,renderPrompt});
    if(palette.length) Object.assign(job.settings,{palette,renderPrompt});
    if(views.length) Object.assign(job.settings,{views,viewPrompts});
    // 角度球精确角度（单视角时）：存进 settings 供重跑时复用
    if(views.length&&options.viewAngles) job.settings.viewAngles=options.viewAngles;
    if(directions.length) Object.assign(job.settings,{directions,directionPrompts,renderPrompt});
    if(studio) Object.assign(job.settings,{shots,material,shotPrompts,shotSizes});
    const transparent=kind==='cutout'||(kind==='upscale'&&(prior?priorSettings.transparent:window.WuyingWorkspaceComposite.isTransparent?.(asset)));
    if(transparent) job.settings.transparent=true;
    if(!prior) delete job.rerunOf;
    const frozen=prior?[]:[{id:inputBlobId,blob:source},...references.map(({blobId,blob})=>({id:blobId,blob})),
      ...(scene?[{id:sceneIds.photoBlobId,blob:sceneImages.photo},{id:sceneIds.sketchBlobId,blob:sceneImages.sketch}]:[])];
    await store.change(current=>{
      if(!current.assets[sourceId]||(blockId&&!current.blocks[blockId])) throw new Error('生成来源已被移除。');
      current.jobs[id]=job;
    },frozen);
    try{
      for(let i=0;i<quantity;i++){
        signal?.throwIfAborted();
        const view=views[i], heading=directions[i], shot=shots[i];
        const label=view?viewPresets[view].label:heading?directionPresets[heading].label:shot?shotPresets[shot].label:'';
        const progress=(i+1)+'/'+quantity+(label?' · '+label:'');
        onStatus('生成 '+progress+'…',{jobId:id,count:i});
        const slot='workspace-'+id+'-'+i;
        const onProgress=message=>onStatus(progress+' · '+message,{jobId:id,count:i});
        // 生成视角（本机）：有部件数据时先按该视角的方位/俯仰把造型投影成结构线稿，
        // 作为 ControlNet 条件图——输出几何严格来自现有造型数据，不允许自由发挥
        let structureImage;
        if(!ortho&&kind==='view'&&view&&asset.draft?.parts?.length){
          const angle=window.WuyingWorkspaceRender.resolveViewAngle(view,(prior?priorSettings.viewAngles:options.viewAngles)?.[view]);
          structureImage=await window.WuyingWorkspaceRender.structureSketchBlob(asset.draft.parts,size.width,size.height,angle.azimuth,angle.elevation);
          if(structureImage) onProgress('已按部件结构生成 '+viewPresets[view].label+'投影线稿');
        }
        const blob=ortho?await window.WuyingWorkspaceRender.orthographicDrawing(ortho,view,size):imageTool
          ? (await window.WuyingComfy.runImageTool({kind,endpoint,sourceImage:source,size,slot,signal,onStatus:onProgress})).blob
          : await window.WuyingWorkspaceRender.generate({
          kind:kind==='explore'?'render':kind,source,selection,protectedAreas,outpaint,prompt:view?viewPrompts[view]:heading?directionPrompts[heading]:shot?shotPrompts[shot]:renderPrompt,references,provider,cloudModel,apiProfile,endpoint,checkpoint,controlnet,strength,
          ...(influenceKind?{influence}:{}),...(scene?{scene:sceneImages}:{}),...(shot?{shot}:{}),
          ...(structureImage?{structureImage}:{}),
          size:shot?shotSizes[shot]:size,mode,resolution:cloudResolution(size,resolution),
          seed:(seed+i)>>>0,slot,signal,onStatus:onProgress
        });
        signal?.throwIfAborted();
        const bitmap=await createImageBitmap(blob);
        const output={id:uid(),blobId:uid(),name:partSource?'部件精修 · '+partSource.name:(instant?fidelityStages[targetFidelity].label:names[kind])+(label?' · '+label:' '+(i+1)),
          width:bitmap.width,height:bitmap.height,...(view?{view}:{}),...(heading?{direction:heading}:{}),...(shot?{shot}:{}),...(transparent?{transparent:true}:{})};
        bitmap.close();
        await store.change(current=>{
          current.jobs[id].outputs.push(output);
          const block=current.blocks[blockId];
          if(block) addResultAsset(current,current.jobs[id],output,position(current,block,i));
        },[{id:output.blobId,blob}]);
        onStatus('已收到 '+(i+1)+'/'+quantity+' 个结果',{jobId:id,count:i+1,output:true});
      }
      const final=await store.change(current=>{current.jobs[id].status='done';});
      return final.jobs[id];
    }catch(error){
      await store.change(current=>{
        const job=current.jobs[id];
        if(job){job.status=signal?.aborted?'canceled':'failed';job.error=String(error.message||error).slice(0,300);}
      }).catch(()=>{});
      throw error;
    }
  }
  window.WuyingWorkflow={run,promoteOutput,modelPrefs,saveModel,checkModel,checkCloud,providerLabel,ready,cloudModels,names,
    migrateBlock,blockRequest,outputSize,aspects,blockDefaults,stylePresets,composePrompt,resolveCloudModel,runSummary,cloudNames,
    fidelityStages,fidelityOptions,resolveFidelity,formPresets,directionPresets,normalizeDirections,directionLimit,shotPresets,materialPresets,normalizeShots,shotSize,sketchKinds,sketchBounds,normalizeForm,normalizePalette,quantityOptions,viewPresets,viewBatchLimit,normalizeViews,isImageTool,imageToolEndpoint};
})();
