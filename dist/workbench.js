(async () => {
  'use strict';
  if (!await window.WuyingLocalWorkspace.requireProject()) return;
  const $=id=>document.getElementById(id), uid=()=>crypto.randomUUID();
  const projects=window.WuyingProjects, project=projects.get(projects.idFromLocation());
  const workspaceAssets=window.WuyingWorkspaceAssets, videoFlow=window.WuyingVideo;
  if(!project){location.replace('files.html');return;}
  const store=window.WuyingWorkspace.open(project.id);
  const flow=window.WuyingWorkflow, composite=window.WuyingWorkspaceComposite, variations=window.WuyingVariationControls;
  const query='?project='+encodeURIComponent(project.id), svg='http://www.w3.org/2000/svg';
  const names={instant:'快速渲染',render:'提示渲染',modify:'修改',color:'配色推演',form:'造型推演',view:'新视角',cutout:flow.names.cutout,upscale:flow.names.upscale};
  const hints={instant:'选择完成阶段，直接渲染草图',render:'描述材质与光照，渲染草图',modify:'描述要修改的内容和要保留的部分',color:'选目标色或连接配色参考',form:'选择要调整的造型方向',view:'为产品选择目标视角',cutout:'分离主体并保留透明背景',upscale:'等比放大，长边最多 4096 像素'};
  const roleNames={color:'配色参考',material:'材质色调',style:'风格色调'};
  const viewport=$('workspaceViewport'), world=$('workspaceWorld'), items=$('workspaceItems'), wires=$('workspaceWires');
  const insert=$('insertMenu'), connectMenu=$('connectMenu'), inspector=$('workspaceInspector'), body=$('inspectorBody');
  const modelDialog=$('modelDialog'), status=$('workbenchStatus');
  const cards=new Map(), thumbs=new Map();
  const viewKey='wuying-workbench-view-v1';
  let view={details:true,blocks:true,wires:true};
  try{view={...view,...JSON.parse(localStorage.getItem(viewKey)||'{}')};}catch{}
  const aspectNames=[['original','原始比例'],...Object.keys(flow.aspects).map(key=>[key,key]),['custom','自定义']];
  const modeNames=[['standard','标准'],['pro','专业']];
  const resolutionNames=[['match','匹配源图'],['1k','1K'],['2k','2K'],['4k','4K']];
  const inputsOf=block=>(block.inputs||[]).filter(id=>doc.assets[id]&&doc.assets[id].mediaType!=='video');
  const primaryOf=block=>inputsOf(block).at(-1);
  const inputLimitOf=kind=>flow.isImageTool(kind)?1:kind==='instant'?2:4;
  let doc={assets:{},blocks:{},jobs:{}}, selection=new Set(), activeBlock=null;
  let camera={x:48,y:100,zoom:1}, tool='select', space=false, pointer=null, busy=null, refreshSeq=0;
  let modelRequest, modelReadAddress='', compareUrls=[];
  $('fileName').textContent=project.name;
  $('studioMode').onclick=event=>{
    event.preventDefault();
    if(!doc)return;
    const chosen=activeAsset();
    const id=(chosen?.mediaType!=='video'&&chosen?.id)||Object.values(doc.assets).find(item=>item.mediaType!=='video')?.id;
    if(id)location.assign(studioLink(id));else say('先添加一张图，再进入图像编辑。',true);
  };
  document.title=project.name+' · 工作台 · 物映';

  function say(text,error=false){status.textContent=text;status.dataset.error=String(error);}
  function el(tag,text,cls){
    const node=document.createElement(tag);
    if(text!==undefined)node.textContent=text;
    if(cls)node.className=cls;
    return node;
  }
  function button(text,click,cls){const node=el('button',text,cls);node.type='button';node.onclick=click;return node;}
  function link(text,href,cls='wb-button'){const node=el('a',text,cls);node.href=href;return node;}
  function studioLink(id){return 'image-studio.html'+query+'&asset='+encodeURIComponent(id);}
  function shapeLink(id){return 'shape-studio.html'+query+'&asset='+encodeURIComponent(id);}
  function field(label,control){const wrap=el('label',undefined,'wb-field');wrap.append(el('span',label),control);return wrap;}
  function options(entries,value){
    const select=el('select');for(const [key,label] of entries)select.add(new Option(label,key));select.value=value;return select;
  }
  function point(event){
    const r=viewport.getBoundingClientRect();
    return {x:(event.clientX-r.left-camera.x)/camera.zoom,y:(event.clientY-r.top-camera.y)/camera.zoom};
  }
  function nodes(){return [...Object.values(doc.assets),...Object.values(doc.blocks)];}
  function place(node){return pointer?.type==='node'&&pointer.id===node.id&&pointer.pos?pointer.pos:node;}
  function applyCamera(){
    world.style.transform='translate('+camera.x+'px,'+camera.y+'px) scale('+camera.zoom+')';
    $('zoomFit').textContent=Math.round(camera.zoom*100)+'%';
  }
  function zoomAt(next,x=viewport.clientWidth/2,y=viewport.clientHeight/2){
    const zoom=Math.max(.19,Math.min(2.4,next)), ratio=zoom/camera.zoom;
    camera={x:x-(x-camera.x)*ratio,y:y-(y-camera.y)*ratio,zoom};applyCamera();
  }
  function fit(){
    const all=nodes();
    if(!all.length){camera={x:48,y:100,zoom:1};applyCamera();return;}
    const x=Math.min(...all.map(n=>n.x)), y=Math.min(...all.map(n=>n.y));
    const w=Math.max(...all.map(n=>n.x+246))-x, h=Math.max(...all.map(n=>n.y+218))-y;
    const z=Math.max(.19,Math.min(1,(viewport.clientWidth-70)/w,(viewport.clientHeight-130)/h));
    camera={x:(viewport.clientWidth-w*z)/2-x*z,y:Math.max(70,(viewport.clientHeight-h*z)/2)-y*z,zoom:z};
    applyCamera();
  }
  function reveal(node){
    const x=node.x*camera.zoom+camera.x, y=node.y*camera.zoom+camera.y;
    const right=viewport.clientWidth-24-248*camera.zoom;
    const bottom=viewport.clientHeight-30-216*camera.zoom;
    camera.x+=Math.max(24,Math.min(x,right))-x;
    camera.y+=Math.max(66,Math.min(y,bottom))-y;
    applyCamera();
  }
  function vacant(at,added=[]){
    const all=[...nodes(),...added];
    let {x,y}=at;
    while(all.some(n=>Math.abs(n.x-x)<264&&Math.abs(n.y-y)<232))y+=248;
    return {x,y};
  }
  function startAt(){
    if(!nodes().length)return {x:36,y:28};
    return {x:Math.round((viewport.clientWidth*.28-camera.x)/camera.zoom),y:Math.round((viewport.clientHeight*.24-camera.y)/camera.zoom)};
  }
  async function save(mutator,blobs){
    try{doc=await store.change(mutator,blobs);return doc;}
    catch(error){say(error.message,true);throw error;}
  }
  async function refresh(withInspector=true){
    const sequence=++refreshSeq, data=await store.read();
    if(sequence!==refreshSeq)return;
    doc=data;
    // 旧项目的 sourceId + references 一次性迁移成 inputs（最后一张是主图）。
    if(Object.values(doc.blocks).some(block=>!Array.isArray(block.inputs))){
      doc=await store.change(current=>{for(const id of Object.keys(current.blocks))current.blocks[id]=flow.migrateBlock(current.blocks[id]);});
    }
    selection=new Set([...selection].filter(id=>doc.assets[id]));
    if(!doc.blocks[activeBlock])activeBlock=null;
    drawGraph();if(withInspector)drawInspector();
  }
  function activeAsset(){return doc.assets[[...selection].at(-1)];}
  function pickAsset(id,extend=false,scroll=false){
    const asset=doc.assets[id];if(!asset)return;
    activeBlock=null;
    if(!extend)selection=new Set([id]);
    else if(selection.has(id))selection.delete(id);
    else if(selection.size<4)selection.add(id);
    else{say('最多选择四张图。',true);return;}
    syncSelection();drawInspector();if(scroll)reveal(asset);
  }
  function pickBlock(id,scroll=false){
    const block=doc.blocks[id];if(!block)return;
    activeBlock=id;selection.clear();syncSelection();drawInspector();if(scroll)reveal(block);
  }
  function clearSelection(){activeBlock=null;selection.clear();syncSelection();drawInspector();}
  function syncSelection(){
    for(const [id,card] of cards){
      const active=activeBlock===id||selection.has(id);
      card.dataset.selected=String(active);
      card.querySelector('[data-face]').setAttribute('aria-pressed',String(active));
    }
    $('exportSelected').disabled=!selection.size;
    drawWires();
  }
  function wire(paths,from,to,current=false,ghost=false){
    const path=document.createElementNS(svg,'path'), bend=Math.max(40,Math.abs(from.x-to.x)*.46);
    path.setAttribute('d','M '+from.x+' '+from.y+' C '+(from.x+bend)+' '+from.y+' '+(to.x-bend)+' '+to.y+' '+to.x+' '+to.y);
    if(current)path.dataset.current='true';if(ghost)path.dataset.ghost='true';
    paths.push(path);
  }
  function drawWires(){
    const paths=[];
    if(!view.wires){wires.replaceChildren();return;}
    for(const block of view.blocks?Object.values(doc.blocks):[]){
      const b=place(block);
      inputsOf(block).forEach((id,index)=>{
        const a=place(doc.assets[id]);
        wire(paths,{x:a.x+228,y:a.y+108},{x:b.x,y:b.y+70+index*16},activeBlock===block.id);
      });
    }
    for(const asset of Object.values(doc.assets)){
      const job=doc.jobs[asset.jobId], block=view.blocks?doc.blocks[job?.blockId]:null, source=block||doc.assets[job?.sourceId||asset.draft?.lineage?.parentId||asset.draft?.reference?.assetId||asset.external?.sourceId];
      if(!source||source.id===asset.id)continue;
      const a=place(source),b=place(asset);
      wire(paths,{x:a.x+(block?260:228),y:a.y+(block?70:108)},{x:b.x,y:b.y+108},selection.has(asset.id));
    }
    if(pointer?.type==='wire'&&pointer.current&&doc.assets[pointer.id]){
      const a=place(doc.assets[pointer.id]);wire(paths,{x:a.x+228,y:a.y+108},pointer.current,true,true);
    }
    wires.replaceChildren(...paths);
  }
  function thumbnail(asset,img){
    const stamp=asset.updatedAt||0, cached=thumbs.get(asset.id);
    let pending=cached?.promise;
    if(cached?.stamp!==stamp||!pending){
      cached?.promise.then(url=>{if(url)URL.revokeObjectURL(url);});
      pending=composite.toPng(asset,store).then(blob=>URL.createObjectURL(blob)).catch(()=>null);
      thumbs.set(asset.id,{stamp,promise:pending});
    }
    pending.then(url=>{if(url&&img.isConnected)img.src=url;});
  }
  function addGrip(node,head){
    head.onpointerdown=event=>{
      if(event.button!==0||pointer||tool==='hand'||space)return;
      event.stopPropagation();
      if(doc.assets[node.id])pickAsset(node.id,event.shiftKey);else pickBlock(node.id);
      pointer={type:'node',id:node.id,pointerId:event.pointerId,start:point(event),origin:{x:node.x,y:node.y},changed:false};
      viewport.setPointerCapture(event.pointerId);
    };
  }
  function blockBody(node,card){
    const slots=el('div',undefined,'wb-slots'), list=inputsOf(node);
    list.forEach((id,index)=>{
      const slot=el('div',undefined,'wb-slot'), asset=doc.assets[id], img=new Image();
      slot.dataset.primary=String(index===list.length-1);
      img.alt='';img.draggable=false;thumbnail(asset,img);
      slot.append(img,el('span','@'+(index+1)));
      slot.title='@'+(index+1)+' · '+asset.name+(index===list.length-1?'（主图）':'');
      slots.append(slot);
    });
    for(let i=list.length;i<inputLimitOf(node.kind);i++){
      const slot=button('',event=>{event.stopPropagation();pickBlock(node.id);},'wb-slot wb-slot-empty');
      slot.textContent='@'+(i+1);slot.setAttribute('aria-label','空输入槽 @'+(i+1)+'，从图卡拖线连接');slots.append(slot);
    }
    const face=button('',()=>pickBlock(node.id),'wb-block-main');
    face.dataset.face='true';face.setAttribute('aria-label',names[node.kind]+'设置');
    const instant=node.kind==='instant';
    const target=instant?flow.resolveFidelity(doc,doc.assets[list.at(-1)],node.fidelity):null;
    let caption=node.prompt||hints[node.kind];
    if(instant) caption=flow.fidelityStages[target].label;
    if(node.kind==='form'&&(node.form?.x||node.form?.y)) caption=flow.formPresets[flow.normalizeForm(node.form).preset].label;
    if(node.kind==='color'&&node.palette?.length) caption='目标色板 · '+node.palette.length+' 色';
    const viewpoints=node.kind==='view'?flow.normalizeViews(node.views):[];
    if(viewpoints.length) caption=viewpoints.map(view=>flow.viewPresets[view].label).join('、');
    face.append(slots,el('span',caption,'wb-block-prompt'));
    const chips=el('div',undefined,'wb-chips');
    const label=(entries,key)=>entries.find(([k])=>k===key)?.[1]||'';
    if(flow.isImageTool(node.kind)) chips.append(el('span','本机 ComfyUI'));
    else if(instant) chips.append(el('span','源图尺寸'));
    else chips.append(el('span',node.aspect==='custom'?node.customW+':'+node.customH:label(aspectNames,node.aspect||'original')),
      el('span',label(modeNames,node.mode||'standard')),el('span',label(resolutionNames,node.resolution||'match')));
    chips.append(el('span',(flow.isImageTool(node.kind)?1:viewpoints.length||node.quantity||1)+' 张'));
    const go=button(busy?.id===node.id?'生成中…':'生成',event=>{event.stopPropagation();runBlock(node.id);},'wb-primary wb-block-go');
    go.disabled=!list.length||!!busy;
    const foot=el('div',undefined,'wb-block-foot');foot.append(chips,go);
    card.append(face,foot);
  }
  function drawGraph(){
    cards.clear();const list=[];
    document.body.dataset.details=String(view.details);
    for(const node of nodes()){
      if(!view.blocks&&doc.blocks[node.id])continue;
      const asset=doc.assets[node.id], card=el('article',undefined,'wb-node '+(asset?'wb-asset':'wb-block'));
      card.dataset[asset?'asset':'block']=node.id;
      const head=el('div',undefined,'wb-node-head');
      const job=asset?doc.jobs[node.jobId]:Object.values(doc.jobs).filter(job=>job.blockId===node.id).at(-1);
      head.append(el('strong',(asset&&node.adopted?'★ ':'')+(asset?node.name:names[node.kind])),el('span',asset?(node.mediaType==='video'?'视频':node.draft?'部件草稿':job?'结果':node.layers.some(l=>l.blobId)?'图像':'草图'):job?.status==='running'?'生成中':job?.outputs.length?job.outputs.length+' 个结果':'操作'));
      addGrip(node,head);card.append(head);
      if(asset){
        const face=button('',event=>pickAsset(node.id,event.shiftKey),'wb-asset-face');
        face.dataset.face='true';face.setAttribute('aria-label',node.name);
        const editor=node.draft?shapeLink(node.id):studioLink(node.id);
        if(node.mediaType!=='video')face.ondblclick=()=>location.assign(editor);
        if(node.draft?.parts.length||node.layers.some(l=>l.visible!==false&&(l.blobId||l.strokes?.length))){
          const img=new Image();img.alt='';img.draggable=false;face.append(img);thumbnail(node,img);
        }else face.textContent=node.mediaType==='video'?'展示视频':'空白草稿';
        const foot=el('div',undefined,'wb-node-foot');foot.append(el('span',node.draft?node.draft.parts.length+' 个部件':node.width+' × '+node.height),node.mediaType==='video'?button('播放',()=>pickAsset(node.id)):link('编辑',editor,''));
        const port=button('＋',event=>{if(event.detail===0){pickAsset(node.id);openConnection(node.id);}},'wb-port');
        port.setAttribute('aria-label','从 '+node.name+' 连接操作');
        port.onpointerdown=event=>{
          if(event.button!==0||pointer)return;
          event.stopPropagation();
          if(!selection.has(node.id))pickAsset(node.id);
          pointer={type:'wire',id:node.id,pointerId:event.pointerId,start:point(event),changed:false};
          viewport.setPointerCapture(event.pointerId);
        };
        card.append(face,foot);
        if(node.mediaType!=='video')card.append(port);
      }else blockBody(node,card);
      if(asset&&node.adopted)card.dataset.adopted='true';
      card.oncontextmenu=event=>{event.preventDefault();openContext(node.id,event);};
      const pos=place(node);card.style.left=pos.x+'px';card.style.top=pos.y+'px';
      cards.set(node.id,card);list.push(card);
    }
    items.replaceChildren(...list);$('workspaceEmpty').hidden=!!list.length;syncSelection();
  }

  async function addDraft(source){
    closeMenus();
    const id=uid(),time=Date.now(),position=vacant(source?{x:source.x+320,y:source.y}:startAt());
    try{
      let reference;
      const blobs=[];
      if(source){
        const blobId=uid();
        blobs.push({id:blobId,blob:await composite.toPng(source,store)});
        reference={blobId,assetId:source.id,label:source.name};
      }
      await save(current=>{
        if(source&&!current.assets[source.id]) throw new Error('原草图已被移除。');
        current.assets[id]={id,name:source?source.name+' · 部件草稿':'部件草稿',...position,
          width:source?.width||1024,height:source?.height||768,createdAt:time,updatedAt:time,layers:[],
          draft:{revision:uid(),parts:[],...(reference?{reference}:{})}};
      },blobs);
      location.assign(shapeLink(id));
    }catch(error){say(error.message,true);}
  }
  async function addSketch(){
    closeMenus();const id=uid(),time=Date.now(),at=vacant(startAt());
    try{
      await save(current=>{current.assets[id]={id,name:'草图 '+(Object.keys(current.assets).length+1),...at,width:1024,height:768,createdAt:time,updatedAt:time,
        layers:[{id:uid(),name:'草图',kind:'ink',strokes:[],visible:true,opacity:1}]};});
      location.assign(studioLink(id));
    }catch{}
  }
  async function importFiles(files,at=startAt()){
    const allowed=[...files].filter(workspaceAssets.accepts);
    if(!allowed.length){say('请选择 20 MB 以内的 PNG、JPG 或 WebP。',true);return;}
    const added=[],blobs=[];
    for(const file of allowed){
      try{
        const {asset,image}=await workspaceAssets.prepareImage(file);
        added.push({...asset,...vacant(at,added)});
        blobs.push(image);
      }catch(error){say(error.message,true);}
    }
    if(!added.length)return;
    try{
      await save(current=>{for(const asset of added)current.assets[asset.id]=asset;},blobs);
      drawGraph();pickAsset(added.at(-1).id,false,true);say('已导入 '+added.length+' 张图。');
    }catch{}
  }
  function closeMenus(){
    insert.hidden=connectMenu.hidden=$('viewMenu').hidden=$('contextMenu').hidden=true;
    $('toggleInsert').setAttribute('aria-expanded','false');$('toggleView').setAttribute('aria-expanded','false');
  }
  function upload(){closeMenus();$('workbenchUpload').click();}
  // 右键菜单（借鉴 OpenViz Workbench 的节点右键：复制、删除）。
  function openContext(id,event){
    closeMenus();
    const asset=doc.assets[id], block=doc.blocks[id], menu=$('contextMenu'), r=viewport.getBoundingClientRect();
    if(!asset&&!block)return;
    if(asset){if(!selection.has(id))pickAsset(id);}else pickBlock(id);
    const entries=asset?.mediaType==='video'
      ?[['导出视频',()=>download(asset)],['删除',removeSelected]]
      :asset
      ?[[asset.adopted?'取消采用':'标记为采用',()=>toggleAdopt(id)],['导出 PNG',()=>download(asset)],[asset.draft?'编辑部件':'拆成部件',()=>asset.draft?location.assign(shapeLink(id)):addDraft(asset)],['进入图像编辑',()=>location.assign(studioLink(id))],['删除',removeSelected]]
      :[['复制节点',()=>duplicateBlock(id)],['生成',()=>runBlock(id)],['删除',removeSelected]];
    menu.replaceChildren(...entries.map(([text,run])=>{const b=button(text,()=>{closeMenus();run();});if(text==='删除')b.dataset.danger='true';return b;}));
    menu.style.left=Math.max(6,Math.min(viewport.clientWidth-190,event.clientX-r.left))+'px';
    menu.style.top=Math.max(6,Math.min(viewport.clientHeight-entries.length*36-16,event.clientY-r.top))+'px';
    menu.hidden=false;
  }
  async function duplicateBlock(id){
    const block=doc.blocks[id];if(!block)return;
    const next=uid(), pos=vacant({x:block.x,y:block.y+248});
    try{
      await save(current=>{const b=current.blocks[id];if(b)current.blocks[next]={...JSON.parse(JSON.stringify(b)),id:next,...pos,createdAt:Date.now()};});
      drawGraph();pickBlock(next,true);say('已复制'+names[block.kind]+'节点，输入与参数相同。');
    }catch{}
  }
  // 采用标记（借鉴 Toonflow 的「片段采用」台账）：推敲时把定下的方案和候选区分开。
  async function toggleAdopt(id){
    try{
      await save(current=>{const a=current.assets[id];if(a)a.adopted=!a.adopted;});
      drawGraph();drawInspector();say(doc.assets[id]?.adopted?'已标记为采用方案。':'已取消采用。');
    }catch{}
  }
  async function addBlock(kind,sourceId=activeAsset()?.id,at){
    closeMenus();
    const source=doc.assets[sourceId]?.mediaType==='video'?null:doc.assets[sourceId], id=uid(), pos=vacant(at||(source?{x:source.x+320,y:source.y+44}:startAt()));
    // 多选时其余图先进槽位，源图放最后一格当主图。
    const inputs=source?[...[...selection].filter(id=>id!==sourceId&&doc.assets[id]&&doc.assets[id].mediaType!=='video').slice(0,inputLimitOf(kind)-1),source.id]:[];
    try{
      await save(current=>{current.blocks[id]={...flow.blockDefaults,id,kind,...pos,inputs,roles:{},createdAt:Date.now()};});
      drawGraph();pickBlock(id,true);($('blockFidelity')||$('blockPrompt')||$('generateBlock'))?.focus({preventScroll:true});
      say(source?'已连接 '+source.name+'。':'请选择源图。');
    }catch{}
  }
  function operations(root,sourceId,at){
    for(const [kind,label] of Object.entries(names)){
      const b=button(label,()=>addBlock(kind,sourceId,at));b.dataset.operation=kind;root.append(b);
    }
  }
  function openConnection(id,event){
    closeMenus();
    const source=doc.assets[id],r=viewport.getBoundingClientRect();
    if(!source)return;
    const x=event?event.clientX-r.left:source.x*camera.zoom+camera.x+248*camera.zoom;
    const y=event?event.clientY-r.top:source.y*camera.zoom+camera.y+100*camera.zoom;
    connectMenu.replaceChildren();operations(connectMenu,id,event?point(event):undefined);
    connectMenu.style.left=Math.max(6,Math.min(viewport.clientWidth-203,x))+'px';
    connectMenu.hidden=false;
    connectMenu.style.top=Math.max(6,Math.min(viewport.clientHeight-connectMenu.offsetHeight-6,y))+'px';
  }
  $('toggleInsert').onclick=()=>{
    const open=insert.hidden;closeMenus();if(!open)return;
    insert.replaceChildren(button('新建部件草稿',()=>addDraft()),button('新建手绘',addSketch),button('导入图片',upload),el('hr'));
    operations(insert,activeAsset()?.id);
    insert.hidden=false;$('toggleInsert').setAttribute('aria-expanded','true');
  };
  $('emptyDraft').onclick=()=>addDraft();
  $('emptySketch').onclick=addSketch;$('emptyImport').onclick=upload;
  $('workbenchUpload').onchange=event=>{importFiles(event.target.files);event.target.value='';};

  function blockAt(p){
    return Object.values(doc.blocks).reverse().find(block=>{
      const b=place(block);return view.blocks&&p.x>=b.x&&p.x<=b.x+260&&p.y>=b.y&&p.y<=b.y+200;
    });
  }
  async function connect(id,blockId){
    try{
      await save(current=>{
        const block=current.blocks[blockId],asset=current.assets[id];
        if(!block||!asset)return;
        if(current.jobs[asset.jobId]?.blockId===block.id)throw new Error('请从这张结果图接出一个新的操作节点。');
        const inputs=(block.inputs||[]).filter(item=>current.assets[item]);
        if(inputs.includes(id))return;
        if(flow.isImageTool(block.kind)&&inputs.length)throw new Error('图像工具只接入一张源图。');
        if(block.kind==='instant'&&inputs.length>=2)throw new Error('快速渲染最多连接一张参考图。');
        if(inputs.length>=4)throw new Error('每个节点最多连接四张图。');
        // 新连入的图插在主图前面，主图（最后一格）保持不变；空节点则直接成为主图。
        block.inputs=inputs.length?[...inputs.slice(0,-1),id,inputs.at(-1)]:[id];
      });
      drawGraph();pickBlock(blockId);say('已连接 '+doc.assets[id].name+'。');
    }catch{}
  }
  function moveInput(blockId,from,to){
    const block=doc.blocks[blockId], inputs=inputsOf(block);
    if(to<0||to>=inputs.length)return;
    const next=[...inputs];next.splice(to,0,...next.splice(from,1));
    editBlock(blockId,{inputs:next});
  }
  function setView(patch){
    view={...view,...patch};
    try{localStorage.setItem(viewKey,JSON.stringify(view));}catch{}
    if(!view.blocks&&activeBlock){activeBlock=null;drawInspector();}
    drawGraph();syncViewMenu();
  }
  viewport.onpointerdown=event=>{
    if(pointer||![0,1].includes(event.button))return;
    if(event.target.closest('.wb-node,button,a')&&tool==='select'&&!space&&event.button===0)return;
    closeMenus();
    pointer={type:'pan',pointerId:event.pointerId,x:event.clientX,y:event.clientY,origin:{...camera},changed:false};
    viewport.dataset.panning='true';viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove=event=>{
    if(pointer?.pointerId!==event.pointerId)return;
    if(pointer.type==='pan'){
      const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
      pointer.changed ||= Math.abs(dx)+Math.abs(dy)>4;
      camera={...pointer.origin,x:pointer.origin.x+dx,y:pointer.origin.y+dy};applyCamera();return;
    }
    const p=point(event),dx=p.x-pointer.start.x,dy=p.y-pointer.start.y;
    pointer.changed ||= Math.hypot(dx,dy)*camera.zoom>6;
    if(pointer.type==='wire'){pointer.current=p;drawWires();return;}
    if(pointer.changed){
      pointer.pos={x:Math.round(pointer.origin.x+dx),y:Math.round(pointer.origin.y+dy)};
      const card=cards.get(pointer.id);
      if(card){card.style.left=pointer.pos.x+'px';card.style.top=pointer.pos.y+'px';}
      const target=doc.assets[pointer.id]?blockAt(p):null;
      for(const [id,node] of cards)if(doc.blocks[id])node.dataset.dragTarget=String(target?.id===id);
      drawWires();
    }
  };
  viewport.onpointerup=event=>{
    if(pointer?.pointerId!==event.pointerId)return;
    const old=pointer;pointer=null;delete viewport.dataset.panning;
    if(old.type==='pan'){
      if(!old.changed&&tool==='select'&&!space)clearSelection();
      return;
    }
    if(old.type==='wire'){
      const target=old.changed&&blockAt(point(event));
      if(target)connect(old.id,target.id);else openConnection(old.id,old.changed?event:undefined);
      drawWires();return;
    }
    if(!old.changed||!old.pos)return;
    const target=doc.assets[old.id]?blockAt(point(event)):null;
    if(target){drawGraph();connect(old.id,target.id);return;}
    save(current=>{
      const node=current.assets[old.id]||current.blocks[old.id];
      if(node)Object.assign(node,old.pos);
    }).then(drawGraph).catch(drawGraph);
  };
  viewport.onpointercancel=()=>{pointer=null;delete viewport.dataset.panning;drawGraph();};
  viewport.addEventListener('wheel',event=>{
    event.preventDefault();closeMenus();
    if(event.shiftKey){camera.x-=event.deltaY;camera.y-=event.deltaX;applyCamera();return;}
    const r=viewport.getBoundingClientRect();
    zoomAt(camera.zoom*Math.exp(-event.deltaY*.00135),event.clientX-r.left,event.clientY-r.top);
  },{passive:false});
  viewport.ondragover=event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();};
  viewport.ondrop=event=>{event.preventDefault();if(event.dataTransfer.files.length)importFiles(event.dataTransfer.files,point(event));};
  $('zoomOut').onclick=()=>zoomAt(camera.zoom/1.2);$('zoomIn').onclick=()=>zoomAt(camera.zoom*1.2);$('zoomFit').onclick=fit;
  function setTool(next){
    tool=next;viewport.dataset.tool=next;
    for(const node of document.querySelectorAll('[data-wb-tool]'))node.setAttribute('aria-pressed',String(node.dataset.wbTool===next));
  }
  for(const node of document.querySelectorAll('[data-wb-tool]'))node.onclick=()=>setTool(node.dataset.wbTool);
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest('#insertMenu,#connectMenu,#toggleInsert,.wb-port,#viewMenu,#toggleView,#contextMenu'))closeMenus();
  });
  const viewMenu=$('viewMenu'), viewInputs={details:$('viewDetails'),blocks:$('viewBlocks'),wires:$('viewWires')};
  function syncViewMenu(){for(const [key,input] of Object.entries(viewInputs))input.checked=!!view[key];}
  for(const [key,input] of Object.entries(viewInputs))input.onchange=()=>setView({[key]:input.checked});
  $('toggleView').onclick=()=>{
    const open=viewMenu.hidden;closeMenus();if(!open)return;
    syncViewMenu();viewMenu.hidden=false;$('toggleView').setAttribute('aria-expanded','true');
  };
  $('viewFit').onclick=()=>{closeMenus();fit();};
  $('railUpload').onclick=upload;
  $('openShortcuts').onclick=()=>$('shortcutDialog').showModal();
  $('closeShortcuts').onclick=()=>$('shortcutDialog').close();
  $('exportSelected').onclick=async()=>{for(const id of selection)if(doc.assets[id])await download(doc.assets[id]);};
  async function removeSelected(){
    const block=activeBlock, ids=[...selection];
    if(!block&&!ids.length)return;
    if(busy&&(busy.id===block))return say('节点正在生成，先停止再删除。',true);
    const label=block?names[doc.blocks[block].kind]+'节点':ids.length+' 张图';
    if(!confirm('删除'+label+'？'))return;
    try{
      await save(current=>{
        if(block)delete current.blocks[block];
        for(const id of ids){
          delete current.assets[id];
          for(const b of Object.values(current.blocks))b.inputs=(b.inputs||[]).filter(item=>item!==id);
        }
      });
      activeBlock=null;selection.clear();drawGraph();drawInspector();say('已删除'+label+'。');
    }catch{}
  }
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){if(!insert.hidden||!connectMenu.hidden||!viewMenu.hidden||!$('contextMenu').hidden)closeMenus();else if(!event.target.closest('input,textarea,select'))clearSelection();return;}
    if(event.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]')||event.ctrlKey||event.metaKey||event.altKey)return;
    const key=event.key.toLowerCase();
    if(key===' '&&!event.target.closest('button,a')){space=true;event.preventDefault();}
    if(key==='h')setTool('hand');
    if(key==='v')setTool('select');
    if(key==='i')upload();
    if(key==='a'){event.preventDefault();$('toggleInsert').click();}
    if(event.key==='?'){event.preventDefault();$('shortcutDialog').showModal();}
    if(event.code==='Digit1'&&event.shiftKey){event.preventDefault();fit();}
    if(key==='delete'||key==='backspace'){event.preventDefault();removeSelected();}
    if(key==='q'&&activeAsset()){event.preventDefault();addBlock('modify');}
  });
  document.addEventListener('keyup',event=>{if(event.key===' ')space=false;});
  window.addEventListener('blur',()=>{space=false;});
  $('closeInspector').onclick=clearSelection;

  async function compare(asset){
    const job=doc.jobs[asset.jobId], output=job?.outputs.find(item=>item.id===asset.id);
    if(!output)return;
    try{
      const pair=await Promise.all([store.getBlob(job.inputBlobId),store.getBlob(output.blobId)]);
      if(pair.some(blob=>!blob))throw new Error('此结果的对照图无法读取。');
      compareUrls=pair.map(blob=>URL.createObjectURL(blob));
      $('sourceCompare').src=compareUrls[0];$('resultCompare').src=compareUrls[1];$('compareDialog').showModal();
    }catch(error){say(error.message,true);}
  }
  $('closeCompare').onclick=()=>$('compareDialog').close();
  $('compareDialog').addEventListener('close',()=>{
    for(const id of ['sourceCompare','resultCompare'])$(id).removeAttribute('src');
    for(const url of compareUrls)URL.revokeObjectURL(url);
    compareUrls=[];
  });
  async function download(asset){
    try{
      const video=asset.mediaType==='video';
      const blob=video?await store.getBlob(asset.videoBlobId):await composite.toPng(asset,store);
      if(!blob)throw new Error('找不到此素材的媒体文件。');
      const url=URL.createObjectURL(blob);
      const anchor=link('',url,'');anchor.download=asset.name+(video?(blob.type==='video/webm'?'.webm':'.mp4'):'.png');anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){say(error.message,true);}
  }

  let videoPreviewUrl;
  function drawVideoInspector(asset) {
    $('inspectorTitle').textContent=asset.name;
    const player=el('video',undefined,'wb-inspector-thumb');
    player.controls=true;
    player.playsInline=true;
    player.preload='metadata';
    const job=doc.jobs[asset.jobId];
    const source=doc.assets[job?.sourceId], tail=doc.assets[job?.lastId];
    const duration=asset.duration??job?.actualDuration;
    body.append(player,el('p',[videoFlow.providers[job?.provider],
      duration&&new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(duration)+' 秒',
      job?.sourceName&&'源方案 · '+job.sourceName,job?.lastName&&'尾帧 · '+job.lastName].filter(Boolean).join(' · '),'wb-panel-copy'),
      button('导出视频',()=>download(asset),'wb-primary'));
    if(job?.prompt)body.append(el('p',job.prompt,'wb-panel-copy'));
    if(source)body.append(button('查看源方案',()=>pickAsset(source.id,false,true)));
    if(tail)body.append(button('查看尾帧素材',()=>pickAsset(tail.id,false,true)));
    void store.getBlob(asset.videoBlobId).then(blob=>{
      if(!blob||!player.isConnected)return;
      videoPreviewUrl=URL.createObjectURL(blob);
      player.src=videoPreviewUrl;
    }).catch(error=>say(error.message,true));
  }

  function drawAssetInspector(asset){
    if(asset.mediaType==='video'){drawVideoInspector(asset);return;}
    $('inspectorTitle').textContent=selection.size>1?selection.size+' 张图像':asset.name;
    if(selection.size>1){
      body.append(el('p',[...selection].map(id=>doc.assets[id].name).join('、'),'wb-panel-copy'),
        el('p','最后选中的图是源图，其余为参考图。','wb-panel-copy'),
        button('连接修改节点',()=>addBlock('modify'),'wb-primary'));
      return;
    }
    const title=el('input');title.value=asset.name;title.maxLength=80;title.id='assetName';
    title.onchange=()=>{
      const value=title.value.trim();if(!value){title.value=asset.name;return;}
      save(current=>{if(current.assets[asset.id])current.assets[asset.id].name=value;})
        .then(()=>{drawGraph();drawInspector();}).catch(()=>{});
    };
    const img=new Image();img.className='wb-inspector-thumb';img.alt='';thumbnail(asset,img);
    const job=doc.jobs[asset.jobId];
    const adopt=button(asset.adopted?'★ 已采用 · 点击取消':'☆ 标记为采用',()=>toggleAdopt(asset.id),asset.adopted?'wb-adopt':'');adopt.id='toggleAdopt';
    body.append(img,field('图像名称',title),adopt,
      el('p',job?names[job.kind]+' · 来自 '+job.sourceName:asset.width+' × '+asset.height+' · '+asset.layers.length+' 个图层','wb-panel-copy'),
      asset.draft?link('编辑部件与对照版本',shapeLink(asset.id),'wb-button wb-primary'):button('拆成部件',()=>addDraft(asset),'wb-primary'),
      link('进入图像编辑器',studioLink(asset.id),'wb-button'));
    if(asset.draft)body.append(el('p',asset.draft.parts.length+' 个部件 · '+asset.draft.parts.filter(part=>part.locked).length+' 个已锁定','wb-panel-copy'));
    if(asset.adopted)body.append(button('用此方案生成视频',()=>openVideo(asset),'wb-primary'));
    if(job?.inputBlobId)body.append(button('与生成时的源图对照',()=>compare(asset)));
    if(asset.external){
      const name=workspaceAssets.toolNames[asset.external.tool]||'扩展工具';
      const origin=asset.external.sourceName?' · 源图 '+asset.external.sourceName:'';
      body.append(el('p','来自 '+name+origin,'wb-panel-copy'));
    }
    const group=el('div',undefined,'wb-action-grid');
    operations(group,asset.id);group.append(button('导出 PNG',()=>download(asset)));body.append(group);
  }
  async function editBlock(id,patch,redraw=true){
    try{
      await save(current=>{if(current.blocks[id])Object.assign(current.blocks[id],patch);});
      drawGraph();if(redraw&&activeBlock===id)drawInspector();return true;
    }catch{return false;}
  }
  function renderJobs(id,target){
    const jobs=Object.values(doc.jobs).filter(job=>job.blockId===id).sort((a,b)=>b.createdAt-a.createdAt);
    const entries=jobs.map(job=>{
      const state={running:'生成中',done:'完成',failed:'失败',canceled:'已停止'}[job.status]||'';
      const run=el('div',undefined,'wb-options'),row=el('div',undefined,'wb-job-row');
      const detail=job.kind==='instant'?flow.fidelityStages[job.settings?.targetFidelity]?.label:job.prompt;
      run.append(el('p',state+' · '+job.outputs.length+' 张'+(detail?' · '+detail:''),'wb-panel-copy'));
      if(job.error)run.append(el('p',job.error,'wb-panel-copy'));
      for(const item of job.outputs)if(doc.assets[item.id])row.append(button(item.name,()=>pickAsset(item.id,false,true)));
      run.append(row);return run;
    });
    target.replaceChildren(el('strong','生成记录'),...entries);
  }
  function drawBlockInspector(block){
    $('inspectorTitle').textContent=names[block.kind];
    const form=el('form',undefined,'wb-block-form');
    const assets=Object.values(doc.assets).filter(asset=>doc.jobs[asset.jobId]?.blockId!==block.id), inputs=inputsOf(block), roles=block.roles||{};
    const inputLimit=inputLimitOf(block.kind);
    form.append(el('p',hints[block.kind],'wb-panel-copy'),el('strong','输入图 · '+inputs.length+'/'+inputLimit,'wb-section'));
    if(!inputs.length)form.append(el('p','从图卡右侧的 ＋ 拖线到这个节点，或在下面添加。','wb-panel-copy'));
    for(const [index,id] of inputs.entries()){
      const primary=index===inputs.length-1, row=el('div',undefined,'wb-ref-row');row.dataset.input=id;
      row.append(el('span','@'+(index+1)+' '+doc.assets[id].name+(primary?' · 主图':'')));
      if(primary)row.append(el('span',block.kind==='instant'?'渲染源图':'被修改的图','wb-quiet'));
      else{
        const select=options(Object.entries(roleNames).filter(([key])=>block.kind!=='instant'||key!=='material'),roles[id]||'style');
        select.setAttribute('aria-label','@'+(index+1)+' 的用途');
        select.onchange=()=>editBlock(block.id,{roles:{...roles,[id]:select.value}});row.append(select);
      }
      const up=button('↑',()=>moveInput(block.id,index,index-1)),down=button('↓',()=>moveInput(block.id,index,index+1));
      up.disabled=!index;down.disabled=primary;up.setAttribute('aria-label','@'+(index+1)+' 前移');down.setAttribute('aria-label','@'+(index+1)+' 后移');
      const remove=button('×',()=>editBlock(block.id,{inputs:inputs.filter(item=>item!==id)}));
      remove.setAttribute('aria-label','移除 @'+(index+1));
      row.append(up,down,remove);form.append(row);
    }
    const unused=assets.filter(asset=>!inputs.includes(asset.id));
    if(inputs.length<inputLimit&&unused.length){
      const add=options([['','添加输入图…'],...unused.map(asset=>[asset.id,asset.name])],'');add.id='blockAddInput';
      add.onchange=()=>{if(add.value)connect(add.value,block.id);};
      form.append(add);
    }
    if(flow.isImageTool(block.kind)){
      drawImageToolInspector(form,block,inputs);
      return;
    }
    if(block.kind==='instant'){
      drawInstantInspector(form,block,inputs);
      return;
    }
    const prompt=el('textarea');prompt.rows=5;prompt.maxLength=5000;prompt.id='blockPrompt';
    prompt.value=block.prompt||'';prompt.placeholder=hints[block.kind]+'。可用 @1–@4 指代输入图。';
    const count=el('span','','wb-count'),countShow=()=>{count.textContent=prompt.value.length+' / 5000';};countShow();
    prompt.addEventListener('input',countShow);
    prompt.onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();form.requestSubmit();}};
    const aspect=options(aspectNames,block.aspect||'original');aspect.id='blockAspect';
    const customW=el('input'),customH=el('input');
    for(const [node,value,name] of [[customW,block.customW||4,'宽'],[customH,block.customH||3,'高']]){
      node.type='number';node.min='1';node.max='99';node.step='1';node.value=value;node.setAttribute('aria-label','自定义比例'+name);
    }
    const custom=el('div',undefined,'wb-custom');custom.append(customW,el('span',':'),customH,el('span','最大 4:1','wb-quiet'));
    custom.hidden=aspect.value!=='custom';
    const mode=options(modeNames,block.mode||'standard');mode.id='blockMode';
    const resolution=options(resolutionNames,block.resolution||'match');resolution.id='blockResolution';
    const qty=options(flow.quantityOptions(block.kind).map(count=>[String(count),count+' 张']),String(block.quantity||1));qty.id='blockQuantity';
    // render（提示渲染）用草图影响力 0–1.5（方案 §7.3）；其余 kind 保持调整幅度 25–95%。
    const isRender=block.kind==='render';
    const strength=el('input');strength.type='range';
    if(isRender){strength.min='0';strength.max='150';strength.step='5';
      strength.value=Math.round((block.influence??block.strength??.8)*100);}
    else{strength.min='25';strength.max='95';strength.value=Math.round((block.strength||.65)*100);}
    const strengthField=field('',strength), label=isRender?'草图影响力':'调整幅度';
    const variationsChanged=()=>{showStrength();showSummary();void editBlock(block.id,snapshot(),false);};
    const formControl=block.kind==='form'?variations.form(block.form,variationsChanged):null;
    const palette=block.kind==='color'?variations.palette(block.palette,async()=>{
      const current=doc.blocks[block.id], ids=current?inputsOf(current):[];
      const reference=ids.slice(0,-1).find(id=>current?.roles?.[id]==='color');
      const source=doc.assets[reference||ids.at(-1)];
      if(!source) throw new Error('请先连接源图或配色参考。');
      return window.WuyingWorkspaceRender.imagePalette(await composite.toPng(source,store));
    },variationsChanged):null;
    const angles=block.kind==='view'?variations.viewpoint(block.views,variationsChanged):null;
    const variation=formControl||palette||angles;
    function showStrength(){
      const direction=formControl?.read();
      strengthField.hidden=!!(direction&&(direction.x||direction.y));
      strengthField.firstElementChild.textContent=label+' · '+strength.value+'%';
    }
    showStrength();strength.oninput=showStrength;
    const snapshot=()=>({prompt:prompt.value,quantity:Number(qty.value),
      ...(isRender?{influence:Number(strength.value)/100,strength:Math.min(1,Number(strength.value)/100)}:{strength:Number(strength.value)/100}),
      aspect:aspect.value,customW:Number(customW.value)||4,customH:Number(customH.value)||3,mode:mode.value,resolution:resolution.value,
      style:$('blockStyle')?.value||block.style||'none',
      ...(formControl?{form:formControl.read()}:{}),...(palette?{palette:palette.read()}:{}),...(angles?{views:angles.read()}:{})});
    const sizeNote=el('p','','wb-model-state'), primary=doc.assets[inputs.at(-1)];
    const showSize=()=>{
      custom.hidden=aspect.value!=='custom';
      if(!primary){sizeNote.textContent='';return;}
      try{const s=flow.outputSize(primary,snapshot());sizeNote.textContent='输出 '+s.width+' × '+s.height;sizeNote.dataset.error='false';}
      catch(error){sizeNote.textContent=error.message;sizeNote.dataset.error='true';}
    };
    showSize();
    for(const control of [prompt,qty,strength,aspect,customW,customH,mode,resolution])
      control.onchange=()=>{showSize();editBlock(block.id,snapshot(),false);};
    const promptField=field(variation?'补充说明（可选）':'提示',prompt);promptField.append(count);
    // @ 指代快捷插入（借鉴 ComfyArt 在对话里 @ 资产）。
    if(inputs.length){
      const mentions=el('div',undefined,'wb-mentions');mentions.id='blockMentions';
      inputs.forEach((id,index)=>{
        const chip=button('@'+(index+1)+' '+doc.assets[id].name,()=>{
          const at=prompt.selectionStart??prompt.value.length, token='@'+(index+1)+' ';
          prompt.setRangeText(token,at,prompt.selectionEnd??at,'end');prompt.focus();countShow();prompt.onchange();
        },'wb-mention');
        chip.title='在光标处插入 @'+(index+1);mentions.append(chip);
      });
      promptField.append(mentions);
    }
    const style=options(Object.entries(flow.stylePresets).map(([key,item])=>[key,item.label]),block.style||'none');style.id='blockStyle';
    style.onchange=()=>{showSize();editBlock(block.id,snapshot(),false);};
    const grid=el('div',undefined,'wb-param-grid');
    const quantityField=field('数量',qty);
    grid.append(field('宽高比',aspect),field('模式',mode),field('分辨率',resolution),quantityField);
    if(variation) form.append(variation.root);
    form.append(promptField,field('风格预设',style),grid,custom,sizeNote,strengthField);
    const provider=flow.modelPrefs(), start=button('生成',null,'wb-primary');
    start.type='submit';start.id='generateBlock';start.disabled=!inputs.length||!!busy;start.title='Ctrl + Enter';
    const stop=button('停止生成',()=>busy?.controller.abort());stop.id='cancelBlock';stop.hidden=busy?.id!==block.id;
    const results=el('div',undefined,'wb-job-list');results.id='blockJobs';
    const modelLine=el('p','','wb-model-state');modelLine.id='blockSummary';
    const showSummary=()=>{
      const viewCount=angles?.read().length||0;
      quantityField.hidden=!!viewCount;
      if(angles){
        promptField.firstElementChild.textContent=viewCount?'补充说明（可选）':'描述目标角度';
        prompt.placeholder=viewCount?'例如：保留原有材质和标识':'例如：从产品右前方 30° 观察';
      }
      modelLine.textContent=flow.ready(provider)?flow.runSummary({...block,...snapshot(),inputs},primary,provider).text:'请先选择出图模型。';
    };
    showSummary();
    for(const control of [qty,aspect,customW,customH,mode,resolution])control.addEventListener('change',showSummary);
    form.append(modelLine,start,stop);
    form.onsubmit=async event=>{
      event.preventDefault();
      if(!await editBlock(block.id,snapshot(),false))return;
      runBlock(block.id);
    };
    body.append(form,results);renderJobs(block.id,results);
  }
  function drawInstantInspector(form,block,inputs){
    const fidelity=options(flow.fidelityOptions,block.fidelity||'auto');fidelity.id='blockFidelity';
    const qty=options([['1','1 张'],['2','2 张'],['4','4 张']],String(block.quantity||1));qty.id='blockQuantity';
    // 草图影响力（方案 §7.3）：快速渲染同样暴露 0–1.5 滑块。
    const influence=el('input');influence.type='range';influence.min='0';influence.max='150';influence.step='5';
    influence.value=Math.round((block.influence??block.strength??.8)*100);influence.id='blockInfluence';
    const influenceField=field('',influence);
    const showInfluence=()=>{influenceField.firstElementChild.textContent='草图影响力 · '+influence.value+'%';};
    showInfluence();influence.oninput=showInfluence;
    const primary=doc.assets[inputs.at(-1)];
    const targetNote=el('p',undefined,'wb-panel-copy');
    const style=options(Object.entries(flow.stylePresets).map(([key,preset])=>[key,preset.label]),block.stageStyle||'none');
    const styleField=field('风格预设',style);
    form.append(field('目标阶段',fidelity),styleField,influenceField,field('数量',qty),targetNote,
      el('p','可添加一张风格或配色参考。输出保持源图尺寸。','wb-panel-copy'));
    const summary=el('p',undefined,'wb-model-state');summary.id='blockSummary';
    const settings=()=>({fidelity:fidelity.value,stageStyle:style.value,quantity:Number(qty.value),
      influence:Number(influence.value)/100,strength:Math.min(1,Number(influence.value)/100)});
    const update=()=>{
      const target=flow.resolveFidelity(doc,primary,fidelity.value);
      styleField.hidden=!['shaded','realistic'].includes(target);
      targetNote.textContent='本次目标：'+flow.fidelityStages[target].label+'。自动推进依据已有阶段记录，首次从色块开始。';
      const provider=flow.modelPrefs();
      summary.textContent=flow.ready(provider)?flow.runSummary({...block,...settings()},primary,provider).text:'请先选择出图模型。';
    };
    fidelity.onchange=qty.onchange=style.onchange=()=>{update();void editBlock(block.id,settings(),false);};
    update();
    const start=button('渲染',async()=>{if(await editBlock(block.id,settings(),false))void runBlock(block.id);},'wb-primary');
    start.id='generateBlock';
    start.disabled=!inputs.length||!!busy;
    const stop=button('停止生成',()=>busy?.controller.abort());stop.hidden=busy?.id!==block.id;
    const results=el('div',undefined,'wb-job-list');results.id='blockJobs';
    form.append(summary,start,stop);
    body.append(form,results);renderJobs(block.id,results);
  }
  function drawImageToolInspector(form,block,inputs){
    const summary=flow.runSummary(block,doc.assets[inputs.at(-1)]);
    const start=button('运行',()=>runBlock(block.id),'wb-primary');start.id='generateBlock';
    start.disabled=!inputs.length||!!busy;
    const stop=button('停止',()=>busy?.controller.abort());stop.hidden=busy?.id!==block.id;
    const results=el('div',undefined,'wb-job-list');results.id='blockJobs';
    form.append(el('p',summary.text,'wb-model-state'),el('p',flow.imageToolEndpoint(),'wb-panel-copy'),start,stop);
    body.append(form,results);renderJobs(block.id,results);
  }
  async function runBlock(id){
    const block=doc.blocks[id];
    if(busy||!block||!inputsOf(block).length)return;
    if(!flow.isImageTool(block.kind)&&!flow.ready()){openModel();return;}
    // 云端按次计费：先说清生成什么、几张，确认后再提交（借鉴 Toonflow）。
    const summary=flow.runSummary({...block,inputs:inputsOf(block)},doc.assets[primaryOf(block)]);
    if(summary.cloud&&!confirm('将提交：'+summary.text+'\n确认生成？'))return;
    const controller=new AbortController();busy={id,controller};
    drawGraph();if(activeBlock===id)drawInspector();
    try{
      const request=flow.blockRequest({...block,inputs:inputsOf(block)});
      await flow.run(store,{...flow.modelPrefs(),...request},{signal:controller.signal,onStatus:(message,event)=>{
        say(message);
        if(event?.output)refresh(false).then(()=>{if(activeBlock===id&&$('blockJobs'))renderJobs(id,$('blockJobs'));}).catch(()=>{});
      }});
      say('生成完成。结果已放在节点右侧。');
    }catch(error){say(controller.signal.aborted?'已停止生成。':error.message,!controller.signal.aborted);}
    finally{
      busy=null;
      await refresh().catch(error=>say(error.message,true));
      if(activeBlock===id&&Object.keys(doc.assets).length<=5)fit();
    }
  }
  function drawInspector(){
    const block=doc.blocks[activeBlock],asset=activeAsset();
    if(videoPreviewUrl){URL.revokeObjectURL(videoPreviewUrl);videoPreviewUrl=undefined;}
    inspector.hidden=!block&&!asset;body.replaceChildren();
    if(block)drawBlockInspector(block);else if(asset)drawAssetInspector(asset);
  }

  const videoDialog=$('videoDialog'), videoProvider=$('videoProvider'), videoMode=$('videoMode');
  const videoFirst=$('videoFirst'), videoLast=$('videoLast');
  let videoRun;

  function syncVideo() {
    const caps=videoFlow.capabilities(videoProvider.value), oldMode=videoMode.value;
    videoMode.replaceChildren(...caps.modes.map(mode=>new Option(videoFlow.modeLabels[mode],mode)));
    if(caps.modes.includes(oldMode))videoMode.value=oldMode;
    const image=videoFlow.needsFirstFrame(videoMode.value), last=videoFlow.needsLastFrame(videoMode.value,caps);
    $('videoFrames').hidden=!image;
    $('videoLastLabel').hidden=videoLast.hidden=!last;
    $('videoAspectGroup').hidden=image||videoProvider.value!=='runninghub';
    $('videoDurationGroup').hidden=!caps.duration;
    $('videoRun').disabled=!!videoRun||!caps.modes.length||image&&!videoFirst.value||last&&!videoLast.value;
    $('videoStop').hidden=!videoRun;
    $('videoModelNote').textContent=videoProvider.value==='runninghub'
      ?'使用后台管理中的 RunningHub 密钥，提交前请确认账户额度。'
      :caps.modes.length?'使用已配置的本机 ComfyUI 视频工作流。':'请先在后台管理的「本机 ComfyUI」配置视频工作流。';
  }

  function videoHistory() {
    const history=$('videoHistory');
    const labels={submitting:'正在提交',running:'生成中',waiting:'待继续查询','submit-failed':'提交结果需核对',done:'已完成'};
    const jobs=Object.values(doc.jobs).filter(job=>job.kind==='video').sort((a,b)=>b.createdAt-a.createdAt);
    history.replaceChildren(...jobs.map(job=>{
      const row=el('div',undefined,'wb-modal-group');
      row.append(el('p',(job.sourceName||'文生视频')+' · '+(labels[job.status]||job.status),'wb-panel-copy'));
      if(job.error)row.append(el('p',job.error,'wb-panel-copy'));
      if(job.outputId&&doc.assets[job.outputId])row.append(button('查看项目视频',()=>{
        videoDialog.close();pickAsset(job.outputId,false,true);
      }));
      else if(job.providerTaskId){
        const resume=button('继续查询同一任务',()=>void generateVideo({resumeId:job.id}));
        resume.disabled=!!videoRun;row.append(resume);
      }else if(job.status==='submitting'||job.status==='submit-failed'){
        row.append(el('p','请先到服务商确认是否已收到提交。','wb-panel-copy'));
        if(job.status==='submitting'&&!videoRun)row.append(button('已核对，解除本机占用',async()=>{
          try{
            await save(current=>{if(current.jobs[job.id]?.status==='submitting')current.jobs[job.id].status='submit-failed';});
            videoHistory();
          }catch{}
        }));
      }
      return row;
    }));
  }

  function openVideo(asset) {
    if(!doc)return;
    const current=videoProvider.value;
    videoProvider.replaceChildren(...Object.entries(videoFlow.providers).map(([key,label])=>new Option(label,key)));
    videoProvider.value=current||(videoFlow.comfyConfig()?'comfy':'runninghub');
    const pictures=Object.values(doc.assets).filter(item=>item.mediaType!=='video'&&
      (item.draft?.parts?.length||item.layers?.some(layer=>layer.visible!==false&&(layer.blobId||layer.strokes?.length))));
    videoFirst.replaceChildren(new Option('选择已采用方案',''),...pictures.filter(item=>item.adopted).map(item=>new Option(item.name,item.id)));
    videoLast.replaceChildren(new Option('选择尾帧',''),...pictures.map(item=>new Option(item.name,item.id)));
    if(asset?.adopted)videoFirst.value=asset.id;
    const modes=videoFlow.capabilities(videoProvider.value).modes;
    if(asset?.adopted&&modes.includes('image')){
      syncVideo();
      videoMode.value='image';
    }else if(!asset&&modes.includes('text')){
      syncVideo();
      videoMode.value='text';
    }
    syncVideo();
    videoHistory();
    if(!videoDialog.open)videoDialog.showModal();
  }

  async function generateVideo(options){
    if(videoRun)return;
    const controller=new AbortController();
    videoRun=controller;
    syncVideo();videoHistory();
    try{
      const job=await videoFlow.run(store,options,{
        signal:controller.signal,onStatus:message=>{$('videoStatus').textContent=message;},
        place:source=>vacant(source?{x:source.x+320,y:source.y+50}:startAt())
      });
      await refresh();
      $('videoStatus').textContent='视频已保存到当前项目。';
      if(job.outputId&&doc.assets[job.outputId]){videoDialog.close();pickAsset(job.outputId,false,true);}
    }catch(error){
      await refresh().catch(()=>{});
      $('videoStatus').textContent=controller.signal.aborted?'已停止查询，可以稍后继续。':error.message;
    }finally{videoRun=null;syncVideo();videoHistory();}
  }
  $('openVideo').onclick=()=>openVideo(activeAsset());
  $('closeVideo').onclick=()=>videoDialog.close();
  $('videoStop').onclick=()=>videoRun?.abort();
  for(const select of [videoProvider,videoMode,videoFirst,videoLast])select.onchange=syncVideo;
  $('videoForm').onsubmit=event=>{
    event.preventDefault();
    void generateVideo({provider:videoProvider.value,mode:videoMode.value,sourceId:videoFlow.needsFirstFrame(videoMode.value)?videoFirst.value:null,
      lastId:videoLast.value,prompt:$('videoPrompt').value.trim(),duration:Number($('videoDuration').value),aspect:$('videoAspect').value});
  };

  const endpoint=$('modelEndpoint'),checkpoint=$('modelCheckpoint'),controlnet=$('modelControlnet');
  const test=$('testModel'),modelStatus=$('modelStatus'),saveModel=$('saveModel');
  const providerSelect=$('modelProvider'),cloudModel=$('cloudModel'),imageApi=$('modelImageApi');
  const platformApi=window.WuyingPlatformApi;
  let cloudChecked=false, profiles=[];
  const isCloud=()=>providerSelect.value==='runninghub';
  const isImageApi=()=>providerSelect.value==='imageapi';
  function syncProvider(){
    $('cloudFields').hidden=!isCloud();
    $('imageApiFields').hidden=!isImageApi();
    $('comfyFields').hidden=isCloud()||isImageApi();
    test.textContent=isCloud()?'检查 RunningHub 连接':isImageApi()?'读取已添加的接口':'连接并读取模型';
    endpoint.required=!isCloud()&&!isImageApi();
    saveModel.disabled=!!modelRequest||(isImageApi()?!imageApi.value:isCloud()?!cloudChecked:!modelReadAddress||!checkpoint.value);
  }
  function openModel(){
    const p=flow.modelPrefs();
    providerSelect.value=p.provider||'comfy';
    imageApi.replaceChildren(new Option('正在读取接口',''));
    if(flow.cloudModels.includes(p.cloudModel))cloudModel.value=p.cloudModel;
    endpoint.value=p.endpoint;modelReadAddress='';cloudChecked=false;modelStatus.textContent='';
    checkpoint.replaceChildren(new Option(p.checkpoint||'请选择基础模型',p.checkpoint||''));
    controlnet.replaceChildren(new Option(p.controlnet||'无',p.controlnet||''));
    syncProvider();modelDialog.showModal();test.click();
  }
  providerSelect.onchange=()=>{modelRequest?.abort();modelRequest=null;test.disabled=false;modelStatus.textContent='';syncProvider();test.click();};
  imageApi.onchange=checkpoint.onchange=syncProvider;
  $('openModel').onclick=openModel;$('closeModel').onclick=()=>modelDialog.close();
  modelDialog.addEventListener('close',()=>modelRequest?.abort());
  endpoint.oninput=()=>{modelRequest?.abort();modelReadAddress='';saveModel.disabled=true;};
  test.onclick=async()=>{
    if(modelRequest)return;
    if(isImageApi()){
      const controller=new AbortController();modelRequest=controller;
      modelStatus.textContent='正在读取接口…';modelStatus.dataset.error='false';test.disabled=true;syncProvider();
      try{
        profiles=await platformApi.fillSelect(imageApi,imageApi.value||flow.modelPrefs().apiProfileId,{signal:controller.signal});
        modelStatus.textContent=imageApi.value?'请选择要用的图片接口。':'在后台管理添加并保存支持图片编辑的接口。';
      }catch(error){
        if(!controller.signal.aborted){imageApi.replaceChildren();modelStatus.textContent=error.message;modelStatus.dataset.error='true';}
      }finally{
        if(modelRequest===controller){modelRequest=null;test.disabled=false;syncProvider();}
      }
      return;
    }
    if(isCloud()){
      const controller=new AbortController();modelRequest=controller;
      modelStatus.textContent='正在检查 RunningHub…';modelStatus.dataset.error='false';test.disabled=saveModel.disabled=true;
      try{
        const info=await flow.checkCloud({signal:controller.signal});
        cloudChecked=true;
        modelStatus.textContent='RunningHub 已连接'+(info.remainCoins!=null?' · 剩余 RH 币 '+info.remainCoins:'')+(info.remainMoney!=null?' · 余额 ¥'+info.remainMoney:'')+'。';
      }catch(error){if(!controller.signal.aborted){modelStatus.textContent=error.message;modelStatus.dataset.error='true';}}
      finally{if(modelRequest===controller){modelRequest=null;test.disabled=false;syncProvider();}}
      return;
    }
    const controller=new AbortController(), address=endpoint.value.trim(),p=flow.modelPrefs();modelRequest=controller;
    modelStatus.textContent='正在读取模型…';modelStatus.dataset.error='false';test.disabled=saveModel.disabled=true;
    try{
      const {checkpoints,controlnets}=await flow.checkModel(address,{signal:controller.signal});
      if(endpoint.value.trim()!==address)return;
      checkpoint.replaceChildren(...checkpoints.map(value=>new Option(value,value)));
      controlnet.replaceChildren(new Option('无',''),...controlnets.map(value=>new Option(value,value)));
      checkpoint.value=checkpoints.includes(p.checkpoint)?p.checkpoint:checkpoints.find(value=>/cyberrealistic/i.test(value))||checkpoints[0]||'';
      controlnet.value=p.controlnet&&controlnets.includes(p.controlnet)?p.controlnet:controlnets.find(value=>/scribble|lineart|canny/i.test(value))||'';
      modelReadAddress=address;modelStatus.textContent=checkpoints.length?'已连接。请选择并保存。':'服务已连接，未找到基础模型。';
    }catch(error){if(!controller.signal.aborted){modelStatus.textContent=error.message;modelStatus.dataset.error='true';}}
    finally{if(modelRequest===controller){modelRequest=null;test.disabled=false;syncProvider();}}
  };
  $('modelForm').onsubmit=event=>{
    event.preventDefault();
    if(isImageApi()){
      const selected=profiles.find(profile=>profile.id===imageApi.value&&profile.ready&&profile.edit);
      if(!selected)return;
      flow.saveModel({provider:'imageapi',apiProfileId:selected.id,apiProfileName:selected.name});
      modelDialog.close();drawInspector();say('已切换到 '+selected.name+'。');
      return;
    }
    if(isCloud()){
      if(!cloudChecked)return;
      flow.saveModel({provider:'runninghub',cloudModel:cloudModel.value});
      modelDialog.close();drawInspector();say('已切换到 RunningHub · '+cloudModel.selectedOptions[0].textContent+'。');
      return;
    }
    if(endpoint.value.trim()!==modelReadAddress||!checkpoint.value)return;
    flow.saveModel({provider:'comfy',endpoint:modelReadAddress,checkpoint:checkpoint.value,controlnet:controlnet.value});
    modelDialog.close();drawInspector();say('已保存 ComfyUI 设置。');
  };

  async function initialize(){
    applyCamera();await refresh();fit();
    const id=new URLSearchParams(location.search).get('asset');
    if(doc.assets[id])pickAsset(id,false,true);
  }
  initialize().catch(error=>say(error.message,true));
  window.addEventListener('pageshow',event=>{if(event.persisted)refresh().catch(error=>say(error.message,true));});
  window.addEventListener('storage',event=>{if(event.key==='wuying-workspace-model-v1')drawInspector();});
  window.addEventListener('pagehide',event=>{
    busy?.controller.abort();modelRequest?.abort();videoRun?.abort();
    if(!event.persisted)for(const {promise} of thumbs.values())promise.then(url=>{if(url)URL.revokeObjectURL(url);});
  });
})();

