(() => {
  'use strict';

  const workbench=window.WuyingWorkbench, board=workbench?.board;
  const graphCore=window.WuyingNodeGraphCore, renderCore=window.WuyingStudioCore, rules=window.WuyingSketchRules;
  if(!board||!graphCore||!renderCore||!rules)return;
  const $=id=>document.getElementById(id);
  const shell=document.querySelector('.app-shell'), viewport=$('graphViewport'), world=$('graphWorld'), list=$('graphItems'), wires=$('graphLinks');
  const sharedSketch=$('sharedSketch'), sharedPreview=$('sharedPreview'), legacy=$('legacyLayout');
  const storageKey='wuying-node-graph-v1'+(workbench.demo?'-demo':'');
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
  const camera={x:0,y:0,zoom:1};
  let docs=new Map(), graph, activeSketch=null, pendingFrom=null, gesture=null, frame=0, autoFit=true;
  let previewKey='', cachedForms={key:null,options:[]}, appearance={tone:'silver',light:38};
  const instructions='从草图输出口拖到预览输入口';
  const limit=(value,min,max)=>Math.min(max,Math.max(min,value));
  const selectedPreview=()=>graphCore.previewNode(graph,graph.activePreview);
  const linkedDocumentId=()=>graphCore.sourceDocument(graph,graph.activePreview);
  const sceneForPreview=node=>{
    const id=graphCore.sourceDocument(graph,node?.id);
    return id?board.sceneFor(id):null;
  };
  const inBoard=()=>shell.dataset.view==='board';
  const hint=text=>{$('graphHint').textContent=text;};

  function save(){
    try{localStorage.setItem(storageKey,JSON.stringify(graph));}catch{}
  }

  function initialState(){
    const state=board.sketchState();
    docs=new Map(state.sketches.map(doc=>[doc.id,doc]));
    try{
      graph=graphCore.restoreGraph(JSON.parse(localStorage.getItem(storageKey)||'null'),new Set(docs.keys()));
    }catch{}
    const initial=docs.has(state.curve?.id)?state.curve.id:docs.keys().next().value;
    graph=graph||graphCore.createGraph(initial);
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
    const sketch=node.type==='sketch';
    const root=element('article','graph-node');
    root.dataset.graphId=node.id;root.dataset.nodeKind=node.type;
    const header=element('header','graph-node-head');
    header.tabIndex=0;header.dataset.nodeHandle='';
    const symbol=element('span','graph-node-symbol',sketch?'S':'R');
    symbol.setAttribute('aria-hidden','true');
    const info=element('span','graph-node-title');
    const title=element('strong','',sketch?'草图绘制':'实时预览');
    const sub=element('small');
    info.append(title,sub);
    const state=element('span','graph-node-state');
    header.append(symbol,info,state);
    if(sketch){
      const upload=button('graph-import','导入底稿','导入线稿底图');
      upload.dataset.importUnderlay='';
      header.append(upload);
    }
    const body=element('div','graph-node-body');
    const mini=element(sketch?'button':'div','graph-mini');
    if(sketch){mini.type='button';mini.dataset.activateSketch='';}
    body.append(mini);
    const footer=element('footer','graph-node-foot');
    const port=button('graph-port','',sketch?'草图输出口':'预览输入口');
    port.dataset.port=sketch?'out':'in';
    const portText=element('span','graph-port-text',sketch?'输出':'输入');
    portText.setAttribute('aria-hidden','true');
    const record={root,body,header,sub,state,mini,port,markup:'',formKey:''};
    if(sketch){
      footer.append(element('span','','画笔 B · 橡皮 E'),element('span','graph-foot-secondary','草图数据'));
    }else{
      const modes=element('div','graph-modes');
      modes.setAttribute('role','group');modes.setAttribute('aria-label','预览显示方式');
      for(const [mode,label] of Object.entries(graphCore.MODES)){
        const choice=button('graph-mode',label);
        choice.dataset.previewMode=mode;
        choice.setAttribute('aria-pressed','false');
        modes.append(choice);
      }
      const variants=element('select','graph-forms');
      variants.dataset.previewVariant='';
      variants.setAttribute('aria-label','选择造型样式');
      const unlink=button('graph-unlink','断开','断开预览输入');
      unlink.dataset.unlink='';
      footer.append(modes,variants,unlink);
      Object.assign(record,{modes,variants,unlink});
    }
    root.append(header,body,footer,port,portText);
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
    if(!w||!h||!graph.nodes.length)return;
    const left=Math.min(...graph.nodes.map(node=>node.x)),top=Math.min(...graph.nodes.map(node=>node.y));
    const width=Math.max(...graph.nodes.map(node=>node.x+graphCore.WIDTH))-left;
    const height=Math.max(...graph.nodes.map(node=>node.y+graphCore.HEIGHT))-top;
    const padding=w<490?28:50;
    camera.zoom=limit(Math.min((w-padding)/width,(h-98)/height,1),.20,1);
    camera.x=(w-width*camera.zoom)/2-left*camera.zoom;
    camera.y=(h-height*camera.zoom)/2-top*camera.zoom+8;
    applyCamera();
  }

  function focusNode(node){
    if(!node)return;
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

  function portPosition(node,outgoing){
    return {x:node.x+(outgoing?graphCore.WIDTH:0),y:node.y+graphCore.PORT_Y};
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
      return a&&b?[svgPath(portPosition(a,true),portPosition(b,false),{
        class:'graph-wire'+(b.id===graph.activePreview?' is-current':''),'data-from':a.id,'data-to':b.id
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
      const bound=graph.links.some(link=>node.type==='sketch'?link.from===node.id:link.to===node.id);
      record.port.dataset.linked=String(bound);
      record.port.dataset.pending=String(node.id===pendingFrom||!!pendingFrom&&node.type==='preview');
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
    for(const btn of record.modes.querySelectorAll('button'))btn.setAttribute('aria-pressed',String(btn.dataset.previewMode===mode));
    record.unlink.hidden=!scene;
    if(node.id===graph.activePreview)return;
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
    if(!inBoard())return;
    for(const node of graph.nodes){
      const record=records.get(node.id);
      if(!record)continue;
      const sketch=node.type==='sketch';
      const active=node.id===(sketch?activeSketch:graph.activePreview);
      record.root.classList.toggle('is-active',active);
      if(sketch){
        const scene=board.sceneFor(node.documentId,{drafts:false});
        record.sub.textContent=scene.title;
        record.state.textContent=active?'编辑中':'可编辑';
        record.mini.setAttribute('aria-label','打开草图 '+scene.title);
        record.port.setAttribute('aria-label','草图输出口 '+scene.title);
      }else{
        const scene=sceneForPreview(node);
        record.sub.textContent=scene?'来源 · '+scene.title:'等待草图输入';
        record.state.textContent=scene?'已连接':'未连接';
        record.root.dataset.connected=String(!!scene);
        renderPreview(record,node,scene);
        continue;
      }
      if(!active){
        const scene=board.sceneFor(node.documentId,{drafts:false});
        const markup=scene.curve||scene.ink.length||scene.underlay?graphCore.lineSvg(scene,rules,renderCore,'graph-'+node.id.toLowerCase()):'';
        paintMini(record,markup,'点击进入草图');
      }
    }
    const linked=sceneForPreview(selectedPreview());
    $('controlSource').textContent=linked?.title||'请连入草图节点';
  }

  function scheduleArt(){
    if(!frame)frame=requestAnimationFrame(refreshArt);
  }

  function updatePreviewContext(){
    const key=graph.activePreview+'|'+linkedDocumentId()+'|'+selectedPreview()?.mode+'|'+selectedPreview()?.variant;
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
      return;
    }
    const state=board.sketchState();
    docs=new Map(state.sketches.map(doc=>[doc.id,doc]));
    if(graph.nodes.some(node=>node.type==='sketch'&&!docs.has(node.documentId))){
      graph=graphCore.restoreGraph(graph,new Set(docs.keys()));save();
    }
    const doc=state.curve?.id;
    const current=docs.has(doc)?addSketchFor(doc):graph.nodes.find(node=>node.id===activeSketch)||graph.nodes.find(node=>node.type==='sketch');
    activeSketch=current?.id??null;
    if(current&&!doc&&!board.sceneState().id){board.openCurve(current.documentId);return;}
    const ids=new Set(graph.nodes.map(node=>node.id));
    for(const [id,record] of records){
      if(ids.has(id))continue;
      if(record.body.contains(sharedSketch))legacy.append(sharedSketch);
      if(record.body.contains(sharedPreview))legacy.append(sharedPreview);
      record.root.remove();records.delete(id);
    }
    for(const node of graph.nodes){
      const record=records.get(node.id)||createNode(node);
      const active=node.id===(node.type==='sketch'?activeSketch:graph.activePreview);
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

  function activatePreview(node){
    if(!node||node.type!=='preview'||graph.activePreview===node.id)return;
    graph.activePreview=node.id;save();reconcile();
  }

  function connect(from,to){
    const next=graphCore.connect(graph,from,to);
    if(!next.links.some(link=>link.from===from&&link.to===to))return;
    graph=next;
    graph.activePreview=to;
    pendingFrom=null;hint('已连接 · 预览会随来源草图更新');
    save();reconcile();
  }

  function disconnect(node){
    graph=graphCore.disconnect(graph,node.id);
    hint('已断开 · 请选择一个草图输出口');
    save();reconcile();
  }

  const findNode=target=>graph.nodes.find(node=>node.id===target.closest('.graph-node')?.dataset.graphId);
  const worldPoint=event=>{
    const box=viewport.getBoundingClientRect();
    return {x:(event.clientX-box.left-camera.x)/camera.zoom,y:(event.clientY-box.top-camera.y)/camera.zoom};
  };

  viewport.addEventListener('pointerdown',event=>{
    if(gesture||event.button!==0||event.isPrimary===false)return;
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
    if(done.kind==='wire'){
      const target=event.type==='pointerup'?document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-port="in"]'):null;
      if(target)connect(done.from,findNode(target)?.id);
      else if(done.moved||event.type!=='pointerup'){
        pendingFrom=null;hint(instructions);
      }else hint('已选草图输出口，点击一个预览输入口');
    }else if(done.kind==='node'){
      if(done.moved)save();
      else if(event.type==='pointerup'){
        if(done.node.type==='sketch')activateSketch(done.node);
        else activatePreview(done.node);
      }
    }else if(!done.moved){
      pendingFrom=null;hint(instructions);
    }
    drawWires();
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(type,finishPointer);
  viewport.addEventListener('wheel',event=>{
    if(event.target.closest('.wb-viewport'))return;
    event.preventDefault();zoomAt(event.deltaY<0?1.10:1/1.10,event.clientX,event.clientY);
  },{passive:false});

  list.addEventListener('click',event=>{
    const node=findNode(event.target),btn=event.target.closest('button');
    if(!node)return;
    if(btn?.dataset.port==='in'){
      if(pendingFrom)connect(pendingFrom,node.id);
      else activatePreview(node);
    }else if(btn?.dataset.port==='out'&&event.detail===0){
      pendingFrom=node.id;hint('已选草图输出口，点击一个预览输入口');drawWires();
    }else if(btn?.hasAttribute('data-import-underlay')){
      activateSketch(node);
      underlayTarget=node.documentId;underlayInput.click();
    }else if(btn?.hasAttribute('data-activate-sketch'))activateSketch(node,true);
    else if(btn?.hasAttribute('data-unlink'))disconnect(node);
    else if(btn?.dataset.previewMode){
      node.mode=btn.dataset.previewMode;
      activatePreview(node);save();scheduleArt();updatePreviewContext();
    }else if(node.type==='preview'&&event.target.closest('.graph-mini'))activatePreview(node);
  });

  list.addEventListener('change',event=>{
    const node=findNode(event.target);
    if(!node||!event.target.hasAttribute('data-preview-variant'))return;
    node.variant=Number(event.target.value);
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
    const move={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,-12],ArrowDown:[0,12]}[event.key];
    if(!move)return;
    node.x=graphCore.clampPosition(node.x+move[0]);node.y=graphCore.clampPosition(node.y+move[1]);
    autoFit=false;nodePosition(records.get(node.id),node);drawWires();save();event.preventDefault();
  });

  $('addSketchNode').onclick=()=>{
    const doc=board.addBlank();
    if(!doc)return;
    reconcile();
    const node=graphCore.findSketch(graph,doc.id);
    focusNode(node);$('freeBoard').focus({preventScroll:true});
    hint('新草图已创建 · 可把输出口连到预览');
  };
  $('addPreviewNode').onclick=()=>{
    const peers=graph.nodes.filter(node=>node.type==='preview');
    if(peers.length>=8){hint('当前项目最多可添加八个预览节点');return;}
    const node={id:'r-'+crypto.randomUUID(),type:'preview',x:graphCore.WIDTH+graphCore.GAP,
      y:peers.length?Math.max(...peers.map(peer=>peer.y))+graphCore.HEIGHT+65:0,mode:'ps',variant:0};
    graph.nodes.push(node);activatePreview(node);focusNode(node);
    hint('预览节点已添加 · 请连入一份草图');
  };
  $('graphZoomIn').onclick=()=>zoomAt(1.16);
  $('graphZoomOut').onclick=()=>zoomAt(1/1.16);
  $('graphFit').onclick=()=>{autoFit=true;fitGraph();};
  $('graphFocusSketch').onclick=()=>focusNode(graph.nodes.find(node=>node.id===activeSketch));
  $('graphFocusPreview').onclick=()=>focusNode(selectedPreview());

  initialState();
  workbench.graph={
    activePreview:selectedPreview,linkedDocumentId,previewScene:()=>sceneForPreview(selectedPreview()),
    previewForms,inBoard,
    setAppearance(next){
      if(appearance.tone!==next.tone||appearance.light!==next.light){appearance=next;scheduleArt();}
    }
  };
  new ResizeObserver(()=>{if(autoFit&&inBoard())fitGraph();}).observe(viewport);
  window.addEventListener('sketchstatechange',reconcile);
  window.addEventListener('boardscenechange',scheduleArt);
  reconcile();
})();
