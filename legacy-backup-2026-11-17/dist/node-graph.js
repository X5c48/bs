(() => {
  'use strict';

  const workbench=window.WuyingWorkbench, board=workbench?.board;
  const graphCore=window.WuyingNodeGraphCore, renderCore=window.WuyingStudioCore, rules=window.WuyingSketchRules;
  if(!board||!graphCore||!renderCore||!rules)return;
  const $=id=>document.getElementById(id);
  const shell=document.querySelector('.app-shell'), viewport=$('graphViewport'), world=$('graphWorld'), list=$('graphItems'), wires=$('graphLinks');
  const sharedSketch=$('sharedSketch'), sharedPreview=$('sharedPreview'), legacy=$('legacyLayout');
  const sketchViews=$('sketchViews'), viewButtons=[...sketchViews.querySelectorAll('button')];
  const inkPalette=$('studioInks'), inkAnchor=inkPalette.nextElementSibling;
  const workspace=$('nodeGraph'), toolSlot=$('boardToolSlot'), toolbarHome=$('boardToolbarHome'), addNodes=$('addNodes');
  const storageKey='wuying-node-graph-v1'+(workbench.demo?'-demo':workbench.projectSuffix||'');
  const records=new Map(), ns='http://www.w3.org/2000/svg';
  const underlayInput=document.createElement('input');
  underlayInput.id='graphUnderlayInput';underlayInput.type='file';
  underlayInput.accept='image/png,image/jpeg,image/webp';underlayInput.hidden=true;
  $('nodeGraph').append(underlayInput);
  let underlayTarget=null;
  underlayInput.addEventListener('change',()=>{
    const file=underlayInput.files?.[0];
    if(file)board.importUnderlay(file,underlayTarget);
    underlayInput.value='';
  });
  const referenceInput=document.createElement('input');
  referenceInput.id='graphReferenceInput';referenceInput.type='file';
  referenceInput.accept='image/png,image/jpeg,image/webp';referenceInput.hidden=true;
  $('nodeGraph').append(referenceInput);
  const imageLoads=new WeakMap();
  let imageTarget=null;
  referenceInput.addEventListener('change',()=>{
    const file=referenceInput.files?.[0];
    if(file&&imageTarget)importReference(imageTarget,file);
    referenceInput.value='';
  });

  async function importReference(node,file){
    if(!/^image\/(?:png|jpeg|webp)$/.test(file.type)||file.size>15*1024*1024){
      hint('请选择 15 MB 以内的 PNG、JPEG 或 WebP');return;
    }
    const key={};imageLoads.set(node,key);
    const url=URL.createObjectURL(file);
    try{
      const photo=new Image();photo.src=url;await photo.decode();
      const ratio=Math.min(1,1024/Math.max(photo.naturalWidth,photo.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(photo.naturalWidth*ratio));
      canvas.height=Math.max(1,Math.round(photo.naturalHeight*ratio));
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(photo,0,0,canvas.width,canvas.height);
      if(imageLoads.get(node)!==key||!graph.nodes.includes(node))return;
      node.image={src:canvas.toDataURL('image/jpeg',.83),name:file.name.slice(0,80)};
      save();scheduleArt();notifyInput();hint('已载入参考图');
    }catch{
      if(imageLoads.get(node)===key)hint('无法读取这张图片');
    }finally{
      if(imageLoads.get(node)===key)imageLoads.delete(node);
      URL.revokeObjectURL(url);
    }
  }

  const camera={x:0,y:0,zoom:1};
  let docs=new Map(), graph, activeSketch=null, pendingFrom=null, gesture=null, frame=0, autoFit=true;
  let lastSketchTap=null;
  let previewKey='', cachedForms={key:null,options:[]}, appearance={tone:'silver',light:38,useInkColors:true}, layout='pair';
  try{if(localStorage.getItem(storageKey+'-layout')==='graph')layout='graph';}catch{}
  const instructions='把草图、文字或参考图的输出接到预览';
  const isGraph=()=>layout==='graph';
  const modelNode=()=>graph.nodes.find(node=>node.type==='model');
  const notifyInput=()=>window.dispatchEvent(new Event('graphinputchange'));
  const limit=(value,min,max)=>Math.min(max,Math.max(min,value));
  const selectedPreview=()=>graphCore.previewNode(graph,graph.activePreview);
  const linkedDocumentId=()=>graphCore.sourceDocument(graph,graph.activePreview);
  const inputsFor=id=>graphCore.inputs(graph,id??graph.activePreview);
  const sceneForPreview=node=>{
    const {visual}=inputsFor(node?.id);
    if(visual?.type==='sketch')return board.sceneFor(visual.documentId);
    if(visual?.image)return {id:visual.id,title:visual.image.name,reference:visual.image.src,ink:[]};
    return null;
  };
  const inBoard=()=>shell.dataset.view==='board';
  const hint=text=>{$('graphHint').textContent=text;};

  function save(){
    try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}
  }

  function updateLayout(){
    workspace.dataset.layout=layout;
    shell.classList.toggle('drawing-desk',!isGraph());
    $('showPairView').setAttribute('aria-pressed',String(!isGraph()));
    $('showGraphView').setAttribute('aria-pressed',String(isGraph()));
    $('workbenchDescription').textContent=isGraph()?'把草图、文字或参考图接到渲染节点。':'左侧画草图，右侧同步上色。';
    viewport.setAttribute('aria-label',isGraph()?'拖动空白移动画布，滚轮缩放':'草图和效果对照');
    viewport.tabIndex=isGraph()?0:-1;
  }

  function setLayout(next){
    const changed=layout!==next;
    layout=next;updateLayout();
    if(changed){
      lastSketchTap=null;
      try{localStorage.setItem(storageKey+'-layout',next);}catch{}
      pendingFrom=null;
      autoFit=true;
      hint(isGraph()?instructions:'在草图上画一笔，观察右侧的变化。');
    }
    reconcile();
  }

  function initialState(){
    const state=board.sketchState();
    docs=new Map(state.sketches.map(doc=>[doc.id,doc]));
    try{
      graph=graphCore.restoreGraph(JSON.parse(localStorage.getItem(storageKey)||'null'),new Set(docs.keys()),board.starterId);
    }catch{}
    const initial=docs.has(state.curve?.id)?state.curve.id:docs.keys().next().value;
    if(!graph){
      graph=graphCore.createGraph(initial);
      if(workbench.projectId)selectedPreview().auto=false;
    }
    if(!selectedPreview()){
      const fallback=graphCore.createGraph().nodes[0];
      graph.nodes.push(fallback);graph.activePreview=fallback.id;
    }
    if(initial&&!graphCore.findSketch(graph,initial))addSketchFor(initial);
  }

  function element(tag,className,value){
    const item=document.createElement(tag);
    if(className)item.className=className;
    if(value)item.textContent=value;
    return item;
  }

  function button(className,text,title){
    const item=element('button',className,text);
    item.type='button';
    if(title){item.title=title;item.setAttribute('aria-label',title);}
    return item;
  }

  function nodePosition(record,node){
    record.root.style.left=node.x+'px';
    record.root.style.top=node.y+'px';
  }

  function createNode(node){
    const sketch=node.type==='sketch', preview=node.type==='preview', model=node.type==='model';
    const kinds={sketch:['01','草图'],text:['T','文字'],image:['I','参考图'],preview:['02','同步上色'],model:['03','3D 体块']};
    const root=element('article','graph-node');
    root.dataset.graphId=node.id;root.dataset.nodeKind=node.type;
    const header=element('header','graph-node-head');
    header.tabIndex=0;header.dataset.nodeHandle='';
    const symbol=element('span','graph-node-symbol',kinds[node.type][0]);
    symbol.setAttribute('aria-hidden','true');
    const info=element('span','graph-node-title');
    const title=element('strong','',kinds[node.type][1]);
    const sub=element('small');
    info.append(title,sub);
    const state=element('span','graph-node-state');
    header.append(symbol,info,state);
    if(sketch){
      const upload=button('graph-import','导入','导入线稿底图');
      upload.dataset.importUnderlay='';header.append(upload);
    }else if(!preview){
      const remove=button('graph-remove','×',model?'移除 3D 模型节点':'移除此输入节点');
      remove.dataset.removeSource='';header.append(remove);
    }
    const body=element('div','graph-node-body');
    const mini=element(sketch?'button':'div','graph-mini');
    if(sketch){mini.type='button';mini.dataset.activateSketch='';}
    body.append(mini);
    const footer=element('footer','graph-node-foot');
    const ports=[];
    for(const [slot,label] of model?[]:preview?[['visual','画面'],['text','文字']]:[['out','输出']]){
      const port=button('graph-port','',preview?'预览'+label+'输入口':kinds[node.type][1]+'输出口');
      port.dataset.port=preview?'in':'out';
      port.dataset.slot=preview?slot:graphCore.slotOf(node.type);
      const portText=element('span','graph-port-text',label);
      portText.dataset.slot=port.dataset.slot;
      portText.setAttribute('aria-hidden','true');
      ports.push({port,portText});
    }
    const record={root,body,header,sub,state,mini,ports,markup:'',formKey:''};
    if(sketch){
      const tools=element('div','graph-sketch-tools');
      const brush=button('graph-control graph-brush-settings','画笔设置');
      const link=button('graph-control graph-link-sketch','预览此稿');
      brush.onclick=()=>workbench.openBrushSettings();
      link.onclick=()=>connect(node.id,graph.activePreview,'visual');
      record.sketchTools=tools;record.linkSketch=link;record.brushSettings=brush;
      footer.append(tools,brush,link);
    }else if(model){
      record.model=window.WuyingModelPreview.mount({stage:mini,footer,sub,state,
        storageId:storageKey+'-'+node.id,onReference:image=>addSource('image',image),onRender:image=>renderModelView(node,image),
        getSketch:()=>{
          const editing=board.sceneState({drafts:false});
          const scene=editing.frontId?board.sceneFor(editing.frontId,{drafts:false}):editing;
          return {scene,viewName:editing.view,color:renderCore.tones[appearance.tone].mid};
        },
        getOutline:scene=>renderCore.closedOutline(scene,rules),getDepthParts:scene=>renderCore.depthParts(scene,rules),
        outlineKey:rules.sketchKey,bounds:rules.controlBounds});
    }else if(preview){
      const mode=element('select','graph-control graph-mode-select');
      mode.dataset.previewMode='';mode.setAttribute('aria-label','预览显示方式');
      mode.append(...Object.entries(graphCore.MODES).map(([value,label])=>new Option(label,value)));
      const variants=element('select','graph-forms');
      variants.dataset.previewVariant='';variants.setAttribute('aria-label','选择造型样式');
      const auto=button('graph-control graph-auto','实时','自动 AI 预览');
      auto.dataset.liveAuto='';
      const hd=button('graph-control graph-hd','增强','生成 1280 × 1024 高清图');
      hd.dataset.liveHd='';
      const stop=button('graph-control graph-stop','停止','停止当前 AI 渲染');
      stop.dataset.liveStop='';stop.hidden=true;
      const download=button('graph-control graph-download','下载','下载当前 AI 渲染');
      download.dataset.liveDownload='';
      const unlink=button('graph-unlink','断开','断开预览输入');
      unlink.dataset.unlink='';
      const palette=element('div','graph-tone-strip');
      const paletteLabel=element('span','graph-tone-label','配色');
      const colors=element('div','graph-tone-swatches');
      colors.setAttribute('role','group');colors.setAttribute('aria-label','同步上色配色');
      const colorButtons=Object.entries(renderCore.tones).map(([key,tone])=>{
        const choice=button('graph-tone','',tone.label);
        choice.style.setProperty('--tone-chip',tone.chip);
        choice.dataset.liveTone=key;
        choice.onclick=()=>{
          const target=graphCore.previewNode(graph,node.id);
          activatePreview(target);
          window.dispatchEvent(new CustomEvent('wuyingtoneselect',{detail:key}));
        };
        colors.append(choice);
        return choice;
      });
      palette.append(paletteLabel,colors);
      footer.append(mode,variants,auto,stop,hd,download,unlink,palette);
      Object.assign(record,{title,mode,variants,auto,stop,hd,download,unlink,palette,paletteLabel,colorButtons});
    }else if(node.type==='text'){
      const textarea=element('textarea','graph-prompt');
      textarea.dataset.nodePrompt='';textarea.maxLength=1200;
      textarea.value=node.prompt;textarea.rows=5;
      textarea.placeholder='描述造型、材质和光线';
      textarea.setAttribute('aria-label','文字节点提示词');
      mini.append(textarea);record.textarea=textarea;
      footer.append(element('span','','连到预览的文字口'));
    }else{
      const pick=button('graph-image-pick','导入参考图','选择参考图片');
      pick.dataset.pickImage='';mini.append(pick);record.pick=pick;
      footer.append(element('span','','连到预览的画面口'));
    }
    root.append(header,body,footer,...ports.flatMap(({port,portText})=>[port,portText]));
    nodePosition(record,node);
    list.append(root);records.set(node.id,record);
    return record;
  }


  function addSketchFor(documentId){
    const current=graphCore.findSketch(graph,documentId);
    if(current)return current;
    const peers=graph.nodes.filter(node=>node.type==='sketch');
    const node={id:'s-'+crypto.randomUUID(),type:'sketch',documentId,x:0,
      y:peers.length?Math.max(...peers.map(peer=>peer.y))+graphCore.HEIGHT+65:0};
    graph.nodes.push(node);save();
    return node;
  }

  function previewForms(scene){
    if(!scene)return [];
    if(!scene.curve?.closed)return graphCore.formOptions(scene,rules,renderCore);
    const key=rules.sketchKey(scene.curve);
    if(cachedForms.key!==key)cachedForms={key,options:graphCore.formOptions({...scene,ink:[]},rules,renderCore)};
    return cachedForms.options.map(option=>({...option,scene:{...scene,curve:option.scene.curve}}));
  }

  function applyCamera(){
    world.style.transform='translate('+camera.x+'px,'+camera.y+'px) scale('+camera.zoom+')';
    $('graphFit').textContent=Math.round(camera.zoom*100)+'%';
  }

  function fitGraph(){
    const w=viewport.clientWidth,h=viewport.clientHeight;
    if(!isGraph()||!w||!h||!graph.nodes.length)return;
    const left=Math.min(...graph.nodes.map(node=>node.x)),top=Math.min(...graph.nodes.map(node=>node.y));
    const width=Math.max(...graph.nodes.map(node=>node.x+graphCore.WIDTH))-left;
    const height=Math.max(...graph.nodes.map(node=>node.y+graphCore.HEIGHT))-top;
    const padding=w<490?28:50;
    camera.zoom=limit(Math.min((w-padding)/width,(h-98)/height,1.2),.20,1.2);
    camera.x=(w-width*camera.zoom)/2-left*camera.zoom;
    camera.y=(h-height*camera.zoom)/2-top*camera.zoom+8;
    applyCamera();
  }

  function focusNode(node){
    if(!node)return;
    if(!isGraph()){
      records.get(node.id)?.root.scrollIntoView({block:'nearest',inline:'nearest'});
      return;
    }
    const w=viewport.clientWidth,h=viewport.clientHeight;
    if(!w||!h)return;
    const margin=24;
    const scale=limit(Math.min(1,(w-2*margin)/graphCore.WIDTH,(h-88)/graphCore.HEIGHT),.27,1);
    autoFit=false;
    camera.zoom=scale;
    camera.x=w/2-(node.x+graphCore.WIDTH/2)*scale;
    camera.y=h/2-(node.y+graphCore.HEIGHT/2)*scale+8;
    applyCamera();
  }

  function zoomAt(factor,clientX,clientY){
    const box=viewport.getBoundingClientRect();
    const x=(clientX??box.left+box.width/2)-box.left,y=(clientY??box.top+box.height/2)-box.top;
    const next=limit(camera.zoom*factor,.20,1.7);
    camera.x=x-(x-camera.x)*(next/camera.zoom);
    camera.y=y-(y-camera.y)*(next/camera.zoom);
    camera.zoom=next;autoFit=false;applyCamera();
  }

  function portPosition(node,outgoing,slot){
    return {x:node.x+(outgoing?graphCore.WIDTH:0),y:node.y+graphCore.PORT_Y+(!outgoing&&slot==='text'?34:0)};
  }
  function svgPath(from,to,attributes){
    const path=document.createElementNS(ns,'path');
    path.setAttribute('d',graphCore.wireCurve(from,to));
    for(const [key,value] of Object.entries(attributes))path.setAttribute(key,value);
    return path;
  }

  function drawWires(){
    const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
    const paths=graph.links.flatMap(edge=>{
      const a=nodes.get(edge.from),b=nodes.get(edge.to);
      return a&&b?[svgPath(portPosition(a,true),portPosition(b,false,edge.slot),{
        class:'graph-wire'+(b.id===graph.activePreview?' is-current':'')+(edge.slot==='text'?' is-text':''),
        'data-from':a.id,'data-to':b.id,'data-slot':edge.slot
      })]:[];
    });
    if(gesture?.kind==='wire'&&gesture.point){
      const node=nodes.get(gesture.from);
      if(node)paths.push(svgPath(portPosition(node,true),gesture.point,{class:'graph-wire is-pending'}));
    }
    wires.replaceChildren(...paths);
    for(const node of graph.nodes){
      const record=records.get(node.id);
      if(!record)continue;
      const source=nodes.get(pendingFrom);
      for(const {port} of record.ports){
        const bound=graph.links.some(link=>port.dataset.port==='out'?link.from===node.id:link.to===node.id&&link.slot===port.dataset.slot);
        port.dataset.linked=String(bound);
        port.dataset.pending=String(node.id===pendingFrom||node.type==='preview'&&graphCore.slotOf(source?.type)===port.dataset.slot);
      }
    }
    $('graphCount').textContent=graph.nodes.length+' 个节点 · '+graph.links.length+' 条连线';
  }

  function renderPreview(record,node,scene){
    const mode=node.mode;
    const form=mode==='shape'?previewForms(scene):[];
    const key=form.map(item=>item.label).join('|');
    if(key!==record.formKey||!record.variants.options.length){
      record.variants.replaceChildren(...(form.length?form.map((option,i)=>new Option(option.label,String(i))):[new Option('先画出闭合轮廓','0')]));
      record.formKey=key;
    }
    record.variants.hidden=mode!=='shape';
    record.variants.disabled=form.length<2;
    record.variants.value=String(form[node.variant]?node.variant:0);
    record.mode.value=mode;
    record.palette.hidden=mode==='line';
    record.paletteLabel.textContent=renderCore.tones[appearance.tone].label;
    for(const choice of record.colorButtons)choice.setAttribute('aria-pressed',String(choice.dataset.liveTone===appearance.tone));
    const inputs=inputsFor(node.id), live=mode==='ai'?workbench.live?.view(node.id):null;
    const activePair=!isGraph()&&node.id===graph.activePreview;
    const paletteGallery=activePair&&shell.dataset.panel==='iterate'&&shell.dataset.iteration!=='form';
    const presentation=activePair&&shell.dataset.panel==='present';
    record.title.textContent=paletteGallery?'配色候选':presentation?'展示画面':
      mode==='ai'&&live?.connected&&live.label!=='本地同步'?'实时渲染':mode==='ai'?'同步上色':graphCore.MODES[mode];
    if(paletteGallery)record.state.textContent='本地配色';
    record.unlink.hidden=!inputs.visual&&!inputs.text;
    const api=workbench.live?.apiMode();
    record.hd.hidden=mode!=='ai';
    record.auto.hidden=record.hd.hidden||api;
    record.hd.title=api?'通过出图后台生成':'生成 1280 × 1024 高清图';
    record.auto.setAttribute('aria-pressed',String(node.auto!==false));
    record.hd.disabled=!!live?.finalBusy;
    record.stop.hidden=mode!=='ai'||!live?.busy;
    record.stop.title=api?'停止等待当前 API 结果':'停止当前 AI 渲染';
    record.download.hidden=mode!=='ai'||!live?.result;
    if(node.id===graph.activePreview)return;
    if(mode==='ai'&&live?.result){
      const src=live.result.src;
      if(record.markup!==src){
        const image=new Image();image.src=src;image.alt='AI 渲染图';record.mini.replaceChildren(image);record.markup=src;
      }
      return;
    }
    const content=scene&&(scene.curve||scene.ink.length||scene.underlay||scene.reference);
    let markup='';
    if(content){
      const id='graph-'+node.id.toLowerCase();
      const visible=form[node.variant]?.scene||form[0]?.scene||scene;
      markup=mode==='line'?graphCore.lineSvg(scene,rules,renderCore,id):
        renderCore.renderSvg(visible,rules,{...appearance,id,ratio:1.38,style:mode==='material'?'material':'ps'});
    }
    paintMini(record,markup,scene?'等待笔迹':'等待草图输入');
  }

  function paintMini(record,markup,empty){
    const key=markup||'empty:'+empty;
    if(record.markup===key)return;
    record.markup=key;
    if(markup)record.mini.innerHTML=markup;
    else record.mini.replaceChildren(element('span','graph-mini-empty',empty));
  }

  function refreshArt(){
    frame=0;
    if(!inBoard()){sketchViews.hidden=true;return;}
    const editing=board.sceneState();
    sketchViews.hidden=!editing.id||!!editing.reference;
    for(const button of viewButtons){
      button.setAttribute('aria-pressed',String(button.dataset.sketchView===editing.view));
    }
    for(const node of graph.nodes){
      const record=records.get(node.id);
      if(!record)continue;
      if(node.type==='model'){if(!editing.drawing)record.model?.updateSketch();continue;}
      const sketch=node.type==='sketch', preview=node.type==='preview';
      const active=sketch?node.id===activeSketch:preview&&node.id===graph.activePreview;
      record.root.classList.toggle('is-active',active);
      if(sketch){
        const scene=board.sceneFor(node.documentId,{drafts:false});
        record.sub.textContent=scene.title;
        record.state.textContent=active?'编辑中':'可编辑';
        record.mini.setAttribute('aria-label','打开草图 '+scene.title);
        record.ports[0].port.setAttribute('aria-label','草图输出口 '+scene.title);
      }else if(preview){
        const scene=sceneForPreview(node),inputs=inputsFor(node.id);
        const bound=!!(inputs.visual||inputs.text);
        const live=node.mode==='ai'?workbench.live?.view(node.id):null;
        record.sub.textContent=scene?(inputs.text?'画面 + 文字':'来源 · '+scene.title):inputs.text?'文字输入':'等待输入';
        record.state.textContent=live?.connected?live.label:bound?(scene?.drawing?'同步中':'本地同步'):'等待输入';
        record.root.dataset.connected=String(bound);
        renderPreview(record,node,scene);
        continue;
      }else if(node.type==='text'){
        record.sub.textContent=node.prompt.trim()?'文生图 / 指导画面':'输入画面描述';
        continue;
      }else if(node.type==='image'){
        record.sub.textContent=node.image?.name||'未导入图片';
        if(node.image&&record.markup!==node.image.src){
          const img=new Image();img.src=node.image.src;img.alt=node.image.name;
          record.pick.replaceChildren(img,element('span','','替换图片'));record.markup=node.image.src;
        }
        continue;
      }
      if(sketch&&!active){
        const scene=board.sceneFor(node.documentId,{drafts:false});
        const markup=scene.curve||scene.ink.length||scene.underlay?graphCore.lineSvg(scene,rules,renderCore,'graph-'+node.id.toLowerCase()):'';
        paintMini(record,markup,'点击进入草图');
      }
    }
    const linked=sceneForPreview(selectedPreview());
    $('controlSource').textContent=linked?.title||(inputsFor().text?'文字输入':'请连入画面或文字');
    const current=records.get(activeSketch);
    if(current?.linkSketch)current.linkSketch.hidden=isGraph()||linkedDocumentId()===board.sceneState().id;
  }

  function scheduleArt(){
    if(!frame)frame=requestAnimationFrame(refreshArt);
  }

  function updatePreviewContext(){
    const inputs=inputsFor();
    const view=inputs.visual?.type==='sketch'?board.viewFor(inputs.visual.documentId):'';
    const key=[graph.activePreview,inputs.visual?.id,inputs.text?.id,view,selectedPreview()?.mode,selectedPreview()?.variant,selectedPreview()?.auto].join('|');
    if(key!==previewKey){
      previewKey=key;
      window.dispatchEvent(new Event('graphchange'));
      window.dispatchEvent(new Event('controlsourcechange'));
    }
  }

  function reconcile(){
    if(!inBoard()){
      if(sharedSketch.parentElement!==legacy)legacy.append(sharedSketch);
      if(sharedPreview.parentElement!==legacy)legacy.append(sharedPreview);
      if(toolSlot.parentElement!==toolbarHome)toolbarHome.append(toolSlot);
      if(inkPalette.nextElementSibling!==inkAnchor)inkAnchor.before(inkPalette);
      return;
    }
    const state=board.sketchState();
    docs=new Map(state.sketches.map(doc=>[doc.id,doc]));
    if(graph.nodes.some(node=>node.type==='sketch'&&!docs.has(node.documentId))){
      graph=graphCore.restoreGraph(graph,new Set(docs.keys()));save();
    }
    const doc=state.curve?.id;
    const current=docs.has(doc)?addSketchFor(doc):graph.nodes.find(node=>node.id===activeSketch)||graph.nodes.find(node=>node.type==='sketch');
    if(!isGraph()&&current&&current.id!==activeSketch&&inputsFor().visual?.id===activeSketch){
      graph=graphCore.connect(graph,current.id,graph.activePreview,'visual');
      save();
    }
    activeSketch=current?.id??null;
    if(current&&!doc&&!board.sceneState().id){board.openCurve(current.documentId);return;}
    const ids=new Set(graph.nodes.map(node=>node.id));
    for(const [id,record] of records){
      if(ids.has(id))continue;
      if(record.body.contains(sharedSketch))legacy.append(sharedSketch);
      if(record.body.contains(sharedPreview))legacy.append(sharedPreview);
      record.model?.dispose();
      record.root.remove();records.delete(id);
    }
    for(const node of graph.nodes){
      const record=records.get(node.id)||createNode(node);
      const active=node.type==='sketch'?node.id===activeSketch:node.type==='preview'&&node.id===graph.activePreview;
      record.root.classList.toggle('is-active',active);
      record.header.tabIndex=isGraph()?0:-1;
      record.mini.hidden=active;
      if(active){
        const shared=node.type==='sketch'?sharedSketch:sharedPreview;
        if(shared.parentElement!==record.body){
          record.body.append(shared);
          if(node.type==='sketch')board.resetView();
        }
      }
    }
    if(!current&&sharedSketch.parentElement!==legacy)legacy.append(sharedSketch);
    const toolTarget=records.get(activeSketch)?.sketchTools||toolbarHome;
    if(toolSlot.parentElement!==toolTarget)toolTarget.append(toolSlot);
    const paletteAnchor=(!isGraph()&&records.get(activeSketch)?.brushSettings)||inkAnchor;
    if(inkPalette.nextElementSibling!==paletteAnchor)paletteAnchor.before(inkPalette);
    workspace.dataset.hasModel=String(!!modelNode());
    $('addModelNode').dataset.added=workspace.dataset.hasModel;
    $('graphFocusSketch').disabled=!current;
    $('graphFocusPreview').disabled=!selectedPreview();
    if(autoFit)fitGraph();
    drawWires();scheduleArt();updatePreviewContext();
  }

  function activateSketch(node,focus=false){
    if(!node||node.type!=='sketch')return;
    if(board.sceneState().id!==node.documentId){
      board.openCurve(node.documentId);
      board.setTool('brush');
    }
    if(focus)$('freeBoard').focus({preventScroll:true});
  }

  function connectSketch(documentId){
    const sketch=graphCore.findSketch(graph,documentId);
    if(sketch&&inputsFor().visual?.id!==sketch.id)connect(sketch.id,graph.activePreview,'visual');
  }

  function openInStudio(node){
    activateSketch(node);
    setLayout('pair');
    connectSketch(node.documentId);
    $('freeBoard').focus({preventScroll:true});
  }

  function activatePreview(node){
    if(!node||node.type!=='preview'||graph.activePreview===node.id)return;
    graph.activePreview=node.id;save();reconcile();
  }

  function connect(from,to,slot){
    const next=graphCore.connect(graph,from,to,slot);
    if(!next.links.some(link=>link.from===from&&link.to===to&&link.slot===slot)){
      pendingFrom=null;hint('将文字接到文字口，草图和图片接到画面口');drawWires();return;
    }
    graph=next;
    graph.activePreview=to;
    pendingFrom=null;hint('已连接 · 相连的输入会更新预览');
    save();reconcile();
  }

  function disconnect(node){
    graph=graphCore.disconnect(graph,node.id);
    hint('已断开 · 可接入新的输入');
    save();reconcile();
  }

  const findNode=target=>graph.nodes.find(node=>node.id===target.closest('.graph-node')?.dataset.graphId);
  const worldPoint=event=>{
    const box=viewport.getBoundingClientRect();
    return {x:(event.clientX-box.left-camera.x)/camera.zoom,y:(event.clientY-box.top-camera.y)/camera.zoom};
  };

  viewport.addEventListener('pointerdown',event=>{
    if(!isGraph()||gesture||event.button!==0||event.isPrimary===false)return;
    const node=findNode(event.target),port=event.target.closest('[data-port]');
    const start={x:event.clientX,y:event.clientY};
    if(port?.dataset.port==='out'&&node){
      pendingFrom=node.id;
      gesture={kind:'wire',id:event.pointerId,start,from:node.id,point:null};
      hint('松手时将连线接到预览输入口');
    }else if(node&&event.target.closest('[data-node-handle]')&&!event.target.closest('button')){
      gesture={kind:'node',id:event.pointerId,start,node,x:node.x,y:node.y};
    }else if(!node&&!event.target.closest('button')){
      gesture={kind:'pan',id:event.pointerId,start,x:camera.x,y:camera.y};
    }else return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    drawWires();
  });

  viewport.addEventListener('pointermove',event=>{
    if(gesture?.id!==event.pointerId)return;
    const dx=event.clientX-gesture.start.x,dy=event.clientY-gesture.start.y;
    if(!gesture.moved&&Math.hypot(dx,dy)<4)return;
    gesture.moved=true;
    if(gesture.kind==='wire'){
      gesture.point=worldPoint(event);drawWires();
    }else if(gesture.kind==='node'){
      autoFit=false;
      gesture.node.x=graphCore.clampPosition(gesture.x+dx/camera.zoom);
      gesture.node.y=graphCore.clampPosition(gesture.y+dy/camera.zoom);
      nodePosition(records.get(gesture.node.id),gesture.node);
      drawWires();
    }else{
      autoFit=false;camera.x=gesture.x+dx;camera.y=gesture.y+dy;applyCamera();
    }
  });

  function finishPointer(event){
    if(gesture?.id!==event.pointerId)return;
    const done=gesture;gesture=null;
    const previousTap=lastSketchTap;
    lastSketchTap=null;
    if(done.kind==='wire'){
      const target=event.type==='pointerup'?document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-port="in"]'):null;
      if(target)connect(done.from,findNode(target)?.id,target.dataset.slot);
      else if(done.moved||event.type!=='pointerup'){
        pendingFrom=null;hint(instructions);
      }else hint('已选输出口，请点击匹配的输入口');
    }else if(done.kind==='node'){
      if(done.moved)save();
      else if(event.type==='pointerup'){
        if(done.node.type==='sketch'){
          const time=performance.now();
          if(previousTap?.id===done.node.id&&time-previousTap.time<430&&
             Math.hypot(done.start.x-previousTap.x,done.start.y-previousTap.y)<10){
            openInStudio(done.node);
            return;
          }
          lastSketchTap={id:done.node.id,time,...done.start};
          activateSketch(done.node);
        }else activatePreview(done.node);
      }
    }else if(!done.moved){
      pendingFrom=null;hint(instructions);
    }
    drawWires();
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(type,finishPointer);
  viewport.addEventListener('wheel',event=>{
    if(!isGraph()||event.target.closest('.wb-viewport,[data-model-viewport],select,input[type=range]'))return;
    event.preventDefault();zoomAt(event.deltaY<0?1.10:1/1.10,event.clientX,event.clientY);
  },{passive:false});

  list.addEventListener('click',event=>{
    const node=findNode(event.target),btn=event.target.closest('button');
    if(!node)return;
    if(btn?.dataset.port==='in'){
      if(pendingFrom)connect(pendingFrom,node.id,btn.dataset.slot);
      else activatePreview(node);
    }else if(btn?.dataset.port==='out'&&event.detail===0){
      pendingFrom=node.id;hint('已选输出口，请点击匹配的输入口');drawWires();
    }else if(btn?.hasAttribute('data-import-underlay')){
      activateSketch(node);
      underlayTarget=node.documentId;underlayInput.click();
    }else if(btn?.hasAttribute('data-activate-sketch'))activateSketch(node,true);
    else if(btn?.hasAttribute('data-unlink'))disconnect(node);
    else if(btn?.hasAttribute('data-pick-image')){imageTarget=node;referenceInput.click();}
    else if(btn?.hasAttribute('data-remove-source')){
      graph.nodes=graph.nodes.filter(item=>item!==node);graph.links=graph.links.filter(link=>link.from!==node.id);
      if(pendingFrom===node.id)pendingFrom=null;
      save();reconcile();
    }else if(btn?.hasAttribute('data-live-auto')){
      activatePreview(node);
      if(workbench.live?.connected()){
        node.auto=node.auto===false;
        btn.setAttribute('aria-pressed',String(node.auto));
        if(node.auto)workbench.live.retry(node.id);
        save();scheduleArt();updatePreviewContext();
      }else workbench.openAISettings();
    }else if(btn?.hasAttribute('data-live-stop'))workbench.live?.cancel(node.id);
    else if(btn?.hasAttribute('data-live-hd')){
      activatePreview(node);workbench.live?.renderFinal();
    }else if(btn?.hasAttribute('data-live-download')){
      const picked=node.id===graph.activePreview&&['generate','present'].includes(shell.dataset.panel)
        ?workbench.studio?.selectedResult():null;
      const visible=workbench.live?.results(node.id).some(entry=>entry.id===picked);
      workbench.live?.download(node.id,visible?picked:null);
    }else if(node.type==='preview'&&event.target.closest('.graph-mini'))activatePreview(node);
  });

  list.addEventListener('dblclick',event=>{
    if(!isGraph()||!event.target.closest('[data-activate-sketch]'))return;
    const node=findNode(event.target);
    if(node?.type==='sketch')openInStudio(node);
  });

  list.addEventListener('input',event=>{
    const node=findNode(event.target);
    if(node?.type!=='text'||!event.target.hasAttribute('data-node-prompt'))return;
    node.prompt=event.target.value.slice(0,1200);
    save();scheduleArt();notifyInput();
  });

  list.addEventListener('change',event=>{
    const node=findNode(event.target);
    if(!node||node.type!=='preview')return;
    if(event.target.hasAttribute('data-preview-variant'))node.variant=Number(event.target.value);
    else if(event.target.hasAttribute('data-preview-mode')&&Object.hasOwn(graphCore.MODES,event.target.value))node.mode=event.target.value;
    else return;
    activatePreview(node);save();scheduleArt();updatePreviewContext();
  });

  viewport.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&pendingFrom){
      pendingFrom=null;hint(instructions);drawWires();event.preventDefault();
    }
    if(!event.target.hasAttribute('data-node-handle'))return;
    const node=findNode(event.target);
    if(!node)return;
    if(event.key==='Enter'){
      if(node.type==='sketch')activateSketch(node);
      else activatePreview(node);
      event.preventDefault();return;
    }
    if(!isGraph())return;
    const move={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,-12],ArrowDown:[0,12]}[event.key];
    if(!move)return;
    node.x=graphCore.clampPosition(node.x+move[0]);node.y=graphCore.clampPosition(node.y+move[1]);
    autoFit=false;nodePosition(records.get(node.id),node);drawWires();save();event.preventDefault();
  });

  sketchViews.addEventListener('click',event=>{
    const button=event.target.closest('[data-sketch-view]');
    if(!button)return;
    const view=button.dataset.sketchView;
    const id=board.setSketchView(view);
    if(!id)return;
    const sketch=graphCore.findSketch(graph,id),preview=selectedPreview();
    if(sketch&&preview&&inputsFor(preview.id).visual?.id!==sketch.id)connect(sketch.id,preview.id,'visual');
    if(sketch&&isGraph())focusNode(sketch);
    const scene=board.sceneFor(id,{drafts:false}),label=renderCore.sketchViews[view].label;
    hint(scene.curve||scene.ink.length||scene.underlay?'草图和渲染已切到'+label:
      '已切到'+label+' · 可以直接画线或导入该视图');
    button.focus({preventScroll:true});
  });
  $('showPairView').onclick=()=>{if(!inBoard())workbench.showBoard();setLayout('pair');};
  $('showGraphView').onclick=()=>{if(!inBoard())workbench.showBoard();setLayout('graph');};
  document.addEventListener('click',event=>{
    if(addNodes.open&&!addNodes.contains(event.target))addNodes.open=false;
  });
  addNodes.addEventListener('keydown',event=>{
    if(event.key==='Escape'){addNodes.open=false;addNodes.querySelector('summary').focus();}
  });
  addNodes.addEventListener('click',event=>{if(event.target.closest('button'))addNodes.open=false;});

  $('addSketchNode').onclick=()=>{
    const doc=board.addBlank();
    if(!doc)return;
    reconcile();
    const node=graphCore.findSketch(graph,doc.id);
    focusNode(node);$('freeBoard').focus({preventScroll:true});
    hint(isGraph()?'新草图已创建 · 把输出口连到预览':
      linkedDocumentId()===doc.id?'新草图已连接 · 落笔即可看同步上色':'新草图已创建 · 点「预览此稿」切换渲染来源');
  };
  function renderModelView(model,image){
    const imageId=model.id+'-view', previewId=model.id+'-render';
    let reference=graph.nodes.find(node=>node.id===imageId);
    let preview=graphCore.previewNode(graph,previewId);
    const missing=Number(!reference)+Number(!preview);
    if(graph.nodes.length+missing>34||(!preview&&graph.nodes.filter(node=>node.type==='preview').length>=8)){
      hint('画布节点已满，请移除一个参考图或预览后重试');return;
    }
    if(!reference){
      reference={id:imageId,type:'image',x:model.x,y:graphCore.clampPosition(model.y+graphCore.HEIGHT+65)};
      graph.nodes.push(reference);
    }
    if(workbench.live?.view(previewId)?.busy)workbench.live.cancel(previewId);
    reference.image=image;
    if(!preview){
      preview={id:previewId,type:'preview',x:graphCore.clampPosition(reference.x+graphCore.WIDTH+graphCore.GAP),
        y:reference.y,mode:'ai',variant:0,auto:false};
      graph.nodes.push(preview);
    }
    preview.mode='ai';
    connect(imageId,previewId,'visual');
    notifyInput();
    focusNode(preview);
    if(workbench.live?.connected()){
      workbench.live.renderFinal();
      hint('已用 '+image.name+' 提交渲染');
    }else{
      workbench.openAISettings();
      hint('视角已连接 · 连接 AI 后点「高清」');
    }
  }

  function addSource(type,image=null){
    if(graph.nodes.length>=34){hint('画布已达到节点上限');return;}
    const peers=graph.nodes.filter(node=>node.type!=='preview');
    const node={id:type+'-'+crypto.randomUUID(),type,x:0,
      y:peers.length?Math.max(...peers.map(peer=>peer.y))+graphCore.HEIGHT+65:0};
    if(type==='text')node.prompt='';
    else node.image=image;
    graph.nodes.push(node);save();setLayout('graph');focusNode(node);
    if(type==='text')records.get(node.id).textarea.focus({preventScroll:true});
    hint(image?'已存为参考图 · 可把输出连到画面口':type==='text'?'输入描述，再连到文字口':'导入图片，再连到画面口');
  }
  $('addTextNode').onclick=()=>addSource('text');
  $('addImageNode').onclick=()=>addSource('image');
  $('addModelNode').onclick=()=>{
    if(!inBoard())workbench.showBoard();
    let node=modelNode();
    if(!node){
      if(graph.nodes.length>=34){hint('画布已达到节点上限');return;}
      const y=selectedPreview()?.y??0;
      const neighbors=graph.nodes.filter(item=>Math.abs(item.y-y)<graphCore.HEIGHT);
      const x=graphCore.clampPosition(Math.max(0,...neighbors.map(item=>item.x))+graphCore.WIDTH+graphCore.GAP);
      node={id:'m-'+crypto.randomUUID(),type:'model',x,y};
      graph.nodes.push(node);save();reconcile();
    }
    focusNode(node);
    hint('闭合草图可预览 3D 体块，也可导入已有模型。');
  };
  $('addPreviewNode').onclick=()=>{
    const peers=graph.nodes.filter(node=>node.type==='preview');
    if(peers.length>=8){hint('当前项目最多可添加八个预览节点');return;}
    const node={id:'r-'+crypto.randomUUID(),type:'preview',x:graphCore.WIDTH+graphCore.GAP,
      y:peers.length?Math.max(...peers.map(peer=>peer.y))+graphCore.HEIGHT+65:0,mode:'ai',variant:0,auto:true};
    graph.nodes.push(node);setLayout('graph');activatePreview(node);focusNode(node);
    hint('预览节点已添加 · 请连入一份草图');
  };
  $('graphZoomIn').onclick=()=>zoomAt(1.16);
  $('graphZoomOut').onclick=()=>zoomAt(1/1.16);
  $('graphFit').onclick=()=>{autoFit=true;fitGraph();};
  $('graphFocusSketch').onclick=()=>focusNode(graph.nodes.find(node=>node.id===activeSketch));
  $('graphFocusPreview').onclick=()=>focusNode(selectedPreview());

  initialState();updateLayout();
  workbench.graph={
    activePreview:selectedPreview,linkedDocumentId,previewScene:()=>sceneForPreview(selectedPreview()),
    previewForms,inBoard,paired:()=>!isGraph(),inputsFor,connectSketch,
    previewNode:id=>graphCore.previewNode(graph,id),
    setPreviewMode(mode){
      const node=selectedPreview();
      if(node&&Object.hasOwn(graphCore.MODES,mode)){node.mode=mode;save();scheduleArt();updatePreviewContext();}
    },
    setAuto(enabled){const node=selectedPreview();if(node){node.auto=enabled;save();scheduleArt();updatePreviewContext();}},
    setAppearance(next){
      if(appearance.tone!==next.tone||appearance.light!==next.light||appearance.useInkColors!==next.useInkColors){
        appearance=next;scheduleArt();
      }
    }
  };
  const modelRecord=()=>{const node=modelNode();return node?records.get(node.id):null;};
  workbench.model={
    hasModel:()=>!!modelNode(),
    ensure(){ if(!inBoard())workbench.showBoard(); $('addModelNode').click(); },
    rotate(degrees){ modelRecord()?.model?.rotateYaw?.(degrees); },
    rotateTo(degrees){ modelRecord()?.model?.rotateTo?.(degrees); }
  };
  new ResizeObserver(()=>{if(autoFit&&inBoard())fitGraph();}).observe(viewport);
  window.addEventListener('sketchstatechange',reconcile);
  window.addEventListener('boardscenechange',scheduleArt);
  window.addEventListener('wuyinglivechange',scheduleArt);
  reconcile();
})();
