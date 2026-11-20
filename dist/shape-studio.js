(async () => {
  'use strict';
  if (!await window.WuyingLocalWorkspace.requireProject()) return;
  const $=id=>document.getElementById(id);
  const model=window.WuyingShapeModel, flow=window.WuyingWorkflow;
  const stageBook=window.WuyingFlowStages, designModel=window.WuyingDesignModel;
  const vectorize=window.WuyingVectorize;
  const projects=window.WuyingProjects, project=projects.get(projects.idFromLocation());
  const id=new URLSearchParams(location.search).get('asset');
  const canvas=$('shapeCanvas'), svgNS='http://www.w3.org/2000/svg';
  const fields={name:$('partName'),x:$('partX'),y:$('partY'),width:$('partWidth'),height:$('partHeight'),depth:$('partDepth'),angle:$('partAngle')};
  const query='?project='+encodeURIComponent(project?.id||'');
  const toBoard=assetId=>'workbench.html'+query+'&asset='+encodeURIComponent(assetId);
  const toDraft=assetId=>'shape-studio.html'+query+'&asset='+encodeURIComponent(assetId);
  const toImage=assetId=>'image-studio.html'+query+'&asset='+encodeURIComponent(assetId);
  const store=project?window.WuyingWorkspace.open(project.id):null;
  const urls=new Map();
  const uid=()=>crypto.randomUUID();
  let doc, selected=null, trace=false, gesture, busy=false, controller, comparison;
  let triView=false, orbit={az:0.5,el:0.42}, peekDrag=null;

  const asset=()=>doc?.assets?.[id];
  const parts=()=>asset()?.draft?.parts||[];
  const active=()=>parts().find(part=>part.id===selected);
  const show=(message,error=false)=>{
    $('shapeStatus').textContent=message;
    $('shapeStatus').dataset.error=String(error);
  };
  function element(tag,text,cls){
    const node=document.createElement(tag);
    if(text) node.textContent=text;
    if(cls) node.className=cls;
    return node;
  }
  function action(text,click){
    const button=element('button',text);button.type='button';button.onclick=click;return button;
  }
  function link(text,href){
    const anchor=element('a',text,'shape-button');anchor.href=href;return anchor;
  }
  function svg(tag){return document.createElementNS(svgNS,tag);}
  function measure(target,source){target.setAttribute('viewBox','0 0 '+source.width+' '+source.height);}
  const pointString=points=>points.map(({x,y})=>x+','+y).join(' ');
  function drawPolygon(part,{selected=false,changed=false,removed=false,invalid=false}={}){
    const node=svg('polygon');
    node.setAttribute('points',pointString(model.polygon(part)));
    node.setAttribute('class','shape-stroke'+(invalid?' is-invalid':''));
    node.dataset.part=part.id;
    node.dataset.selected=String(selected);
    node.dataset.locked=String(part.locked);
    node.dataset.changed=String(changed);
    node.dataset.removed=String(removed);
    const title=svg('title');title.textContent=part.name;node.append(title);
    return node;
  }

  // 描线部件的节点手柄（P2）：选中、未锁定、非三视图时显示，拖锚点改轮廓
  function nodeHandlesOf(part,invalid){
    if(!part||part.locked||part.shape!=='polygon'||!Array.isArray(part.points)) return [];
    const angle=part.angle*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    return part.points.map((point,index)=>{
      const x=part.x+point.x*part.width*c-point.y*part.height*s;
      const y=part.y+point.x*part.width*s+point.y*part.height*c;
      const node=svg('circle');
      node.setAttribute('cx',x);node.setAttribute('cy',y);node.setAttribute('r',4.2);
      node.setAttribute('class','shape-node'+(invalid?' is-invalid':''));
      node.style.cursor='crosshair';
      node.dataset.node=String(index);node.dataset.part=part.id;
      return node;
    });
  }
  function cachedUrl(blobId){
    if(!urls.has(blobId)) urls.set(blobId,store.getBlob(blobId).then(blob=>blob?URL.createObjectURL(blob):null).catch(()=>null));
    return urls.get(blobId);
  }

  // ── 三视图布局（融合自结构空间原型）：正视=现有轮廓，侧视/俯视由部件深度推导 ──
  function triLayout(){
    const current=asset(), span=model.depthSpan(parts());
    const depth=Math.max(span.max-span.min,Math.round(current.height*0.3),60);
    const gap=Math.round(current.width*0.12);
    return {gap,span,side:{x:current.width+gap,w:depth},top:{y:current.height+gap,h:depth},
      width:current.width+gap+depth,height:current.height+gap+depth};
  }
  function guideLine(x1,y1,x2,y2,cls='view-sep'){
    const node=svg('line');
    node.setAttribute('x1',x1);node.setAttribute('y1',y1);
    node.setAttribute('x2',x2);node.setAttribute('y2',y2);
    node.setAttribute('class',cls);
    return node;
  }
  function viewLabel(text,x,y){
    const node=svg('text');
    node.setAttribute('x',x);node.setAttribute('y',y);
    node.setAttribute('text-anchor','middle');node.setAttribute('class','view-label');
    node.textContent=text;
    return node;
  }
  function viewRect(part,mode,layout){
    const rect=mode==='side'?model.sideRect(part):model.topRect(part);
    const node=svg('rect');
    if(mode==='side'){
      node.setAttribute('x',layout.side.x+rect.x-layout.span.min);
      node.setAttribute('y',rect.y);
      node.setAttribute('width',rect.width);node.setAttribute('height',rect.height);
    }else{
      node.setAttribute('x',rect.x);
      node.setAttribute('y',layout.top.y+rect.y-layout.span.min);
      node.setAttribute('width',rect.width);node.setAttribute('height',rect.height);
    }
    node.setAttribute('class','shape-stroke');
    node.dataset.part=part.id;
    node.dataset.selected=String(part.id===selected);
    node.dataset.locked=String(part.locked);
    const title=svg('title');title.textContent=part.name;node.append(title);
    return node;
  }
  function depthHandle(part,mode,layout){
    if(part.locked||part.id!==selected) return null;
    const size=7,node=svg('rect');
    let hx,hy;
    if(mode==='side'){
      hx=layout.side.x+part.z+part.depth/2-layout.span.min;hy=part.y;
    }else{
      hx=part.x;hy=layout.top.y+part.z+part.depth/2-layout.span.min;
    }
    node.setAttribute('x',hx-size/2);node.setAttribute('y',hy-size/2);
    node.setAttribute('width',size);node.setAttribute('height',size);node.setAttribute('rx',1.5);
    node.setAttribute('class','shape-handle');
    node.style.cursor=mode==='side'?'ew-resize':'ns-resize';
    node.dataset.handle='depth-'+mode;node.dataset.part=part.id;
    const title=svg('title');title.textContent='拖动调整厚度';node.append(title);
    return node;
  }

  function renderCanvas(){
    const current=asset();
    const layout=gesture?.layout||(triView?triLayout():null);
    if(layout) canvas.setAttribute('viewBox','-10 -10 '+(layout.width+20)+' '+(layout.height+20));
    else measure(canvas,current);
    $('shapeSheet').style.setProperty('--sheet-ratio',(layout?layout.width+'/'+layout.height:current.width+'/'+current.height));
    const shownOf=part=>gesture?.part?.id===part.id?gesture.part:part;
    const nodes=[];
    if(layout){
      const {gap,span,side,top}=layout,current0=current;
      nodes.push(guideLine(current0.width+gap/2,0,current0.width+gap/2,current0.height));
      nodes.push(guideLine(0,current0.height+gap/2,current0.width,current0.height+gap/2));
      // 视图对齐参考线：正视高度 ↔ 侧视高度、正视宽度 ↔ 俯视宽度（同源几何的直观证明）
      const boxes=parts().map(part=>model.outlineBounds(shownOf(part)));
      if(boxes.length){
        const left=Math.min(...boxes.map(box=>box.x)),right=Math.max(...boxes.map(box=>box.x+box.width));
        const topY=Math.min(...boxes.map(box=>box.y)),bottomY=Math.max(...boxes.map(box=>box.y+box.height));
        nodes.push(guideLine(0,topY,side.x,topY,'view-align'));
        nodes.push(guideLine(0,bottomY,side.x,bottomY,'view-align'));
        nodes.push(guideLine(left,0,left,top.y,'view-align'));
        nodes.push(guideLine(right,0,right,top.y,'view-align'));
      }
      for(const part of parts()){
        const shown=shownOf(part);
        nodes.push(drawPolygon(shown,{selected:part.id===selected}));
        nodes.push(viewRect(shown,'side',layout),viewRect(shown,'top',layout));
      }
      const active=shownOf(parts().find(part=>part.id===selected)||{});
      for(const part of [active]){
        if(part?.id) nodes.push(depthHandle(part,'side',layout),depthHandle(part,'top',layout));
      }
      const spanRounded=Math.round(span.max-span.min);
      nodes.push(viewLabel('正视 '+current0.width+'×'+current0.height,current0.width/2,current0.height+gap*0.55));
      nodes.push(viewLabel('侧视 厚 '+spanRounded,side.x+side.w/2,current0.height+gap*0.55));
      // 俯视标签放在俯视格上方（放在下方会超出 viewBox 被裁掉）
      nodes.push(viewLabel('俯视 '+current0.width+'×'+spanRounded,current0.width/2,top.y-10));
    }else{
      const invalid=gesture?.mode==='node'&&gesture.invalid===true;
      for(const part of parts()){
        const shown=shownOf(part);
        nodes.push(drawPolygon(shown,{selected:part.id===selected,invalid:invalid&&part.id===selected}));
      }
      const active=parts().find(part=>part.id===selected);
      nodes.push(...nodeHandlesOf(active,invalid));
    }
    if(gesture?.points){
      const line=svg('polyline');line.setAttribute('class','trace-line');line.setAttribute('points',pointString(gesture.points));
      canvas.append(line);
    }
    canvas.replaceChildren(...nodes.filter(Boolean));
    const ref=current.draft.reference, image=$('shapeReference'), useRef=!layout&&!!ref&&$('showReference').checked;
    $('referenceToggle').hidden=!ref||triView;
    $('shapeSheet').dataset.reference=String(useRef);
    image.hidden=!useRef;
    if(useRef) void cachedUrl(ref.blobId).then(url=>{if(url&&asset()?.draft.reference?.blobId===ref.blobId)image.src=url;});
    $('shapeSheet').dataset.trace=String(trace&&!layout);
    $('tracePart').setAttribute('aria-pressed',String(trace));
    renderPeek();
  }

  // ── 体块预览小窗：部件包围盒挤出，与画布同步，可拖拽旋转 ──
  const peekSvg=$('peekSvg');
  // 预览窗跟随画布右缘固定在视口内，避免页面滚动后跑到折叠线以下被裁切
  function placePeek(){
    const peek=$('shapePeek');
    if(peek.hidden) return;
    const rect=canvas.getBoundingClientRect();
    peek.style.right=Math.max(12,Math.round(window.innerWidth-rect.right+12))+'px';
    peek.style.bottom='12px';
  }
  window.addEventListener('resize',placePeek);
  function tint(hex,k){
    const n=parseInt(hex.slice(1),16),c=v=>Math.round(v*k);
    return 'rgb('+c(n>>16&255)+','+c(n>>8&255)+','+c(n&255)+')';
  }
  function renderPeek(){
    const list=parts();
    $('shapePeek').hidden=!list.length;
    if(!list.length) return;
    placePeek();
    const drawn=[...list]
      .sort((a,b)=>model.blockDepth(b,orbit.az)-model.blockDepth(a,orbit.az))
      .map(part=>({part,faces:model.blockFaces(part,orbit.az,orbit.el)}));
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const {faces} of drawn) for(const face of faces) for(const p of face.points){
      minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);
      maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);
    }
    if(!Number.isFinite(minX)) return;
    const pad=Math.max(8,(maxX-minX)*0.06);
    peekSvg.setAttribute('viewBox',(minX-pad).toFixed(1)+' '+(minY-pad).toFixed(1)+' '
      +(maxX-minX+pad*2).toFixed(1)+' '+(maxY-minY+pad*2).toFixed(1));
    const nodes=[];
    for(const {part,faces} of drawn){
      for(const face of faces){
        const node=svg('polygon');
        node.setAttribute('points',face.points.map(p=>p.x.toFixed(1)+','+p.y.toFixed(1)).join(' '));
        node.setAttribute('fill',tint(part.locked?'#d9d5cb':'#ece8dc',face.shade));
        node.setAttribute('stroke',part.id===selected?'#2f4fd8':part.locked?'#b3afa4':'#8a867b');
        node.setAttribute('stroke-width',part.id===selected?'2':'0.75');
        node.setAttribute('stroke-linejoin','round');
        const title=svg('title');title.textContent=part.name;node.append(title);
        nodes.push(node);
      }
    }
    peekSvg.replaceChildren(...nodes);
  }
  peekSvg.onpointerdown=event=>{
    if(event.button!==0) return;
    peekDrag={x:event.clientX,y:event.clientY,az:orbit.az,el:orbit.el};
    peekSvg.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  peekSvg.onpointermove=event=>{
    if(!peekDrag) return;
    orbit.az=peekDrag.az+(event.clientX-peekDrag.x)*0.008;
    orbit.el=Math.min(1.2,Math.max(-1.2,peekDrag.el+(event.clientY-peekDrag.y)*0.006));
    renderPeek();
  };
  peekSvg.onpointerup=()=>{peekDrag=null;};
  peekSvg.onpointercancel=()=>{peekDrag=null;};

  function updateButtons(){
    const part=active(), restricted=busy||!part||part.locked;
    $('partFields').disabled=restricted;
    for(const key of ['generateVariants','variantField','variantAmount','partAiRun','partPrompt','removePart']) $(key).disabled=restricted;
    for(const key of ['tracePart','addRectangle','addEllipse','loadExample','toggleLock','vectorize','lockOthers']) $(key).disabled=busy;
    $('tracePart').disabled=busy||triView;
    $('partAiCancel').hidden=!controller;
  }

  function renderControls(){
    const items=parts();
    $('partCount').textContent=items.length+' 个 · '+items.filter(part=>part.locked).length+' 锁定';
    $('triToggleWrap').hidden=!items.length;
    if(!active()) selected=items.at(-1)?.id||null;
    $('shapeParts').replaceChildren(...items.map(part=>{
      const row=element('li');
      const button=action('',()=>{
        if(busy) return;
        selected=part.id;trace=false;
        renderControls();renderCanvas();
        $('shapeParts').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
      });
      button.setAttribute('aria-pressed',String(part.id===selected));
      button.append(element('span',part.name),element('small',part.locked?'已锁定':model.shapeNames[part.shape]));
      row.append(button);return row;
    }));
    const part=active();
    $('choosePart').hidden=!!part;
    $('shapePartDetails').hidden=!part;
    $('toggleLock').hidden=!part;
    $('lockOthers').hidden=!part||items.length<2;
    $('vectorize').hidden=!asset().draft.reference||triView;
    $('loadExample').hidden=!!parts().length||!!asset().draft.reference;
    if(part){
      $('toggleLock').textContent=part.locked?'解除锁定':'锁定部件';
      $('toggleLock').setAttribute('aria-pressed',String(part.locked));
      for(const [key,control] of Object.entries(fields)) control.value=part[key];
    }
    $('shapeHint').textContent=trace?'在画布沿部件边缘拖动，松开后闭合轮廓。':
      triView?'正视格拖动部件；侧视格左右拖、俯视格前后拖调整深度位置；方块手柄调整厚度。':
      items.length?'选中部件可拖动位置；描线部件可直接拖圆点改节点，自交会自动退回。勾选「三视图」查看侧视与俯视。':'添加基本形状，用「描轮廓」沿底图勾画，或用「矢量化底图」自动拆分线稿。';
    updateButtons();
  }

  function family(){
    const current=asset();
    const candidates=Object.values(doc.assets).filter(item=>item.draft?.lineage);
    const own=candidates.filter(item=>item.draft.lineage.parentId===current.id).sort((a,b)=>b.createdAt-a.createdAt);
    const root=comparison||own[0]?.draft.lineage||current.draft.lineage;
    if(!root) return null;
    return {root,items:candidates.filter(item=>{
      const parent=item.draft.lineage;
      return parent.parentId===root.parentId&&parent.revision===root.revision;
    }).sort((a,b)=>a.createdAt-b.createdAt)};
  }
  function differenceText(change){
    if(change.type==='added') return '新增 '+change.name;
    if(change.type==='removed') return '移除 '+change.name;
    return change.name+' · '+change.fields.map(field=>
      field.label+' '+model.caption(field.before,field.key)+' → '+model.caption(field.after,field.key)).join('，');
  }

  function versionCard(title,currentParts,changes,{entry,baseline}={}){
    const card=element('article',null,'shape-version');
    card.dataset.current=String(entry?.id===id);
    const view=svg('svg');measure(view,asset());view.setAttribute('aria-hidden','true');
    const dirty=new Set(changes.map(change=>change.id));
    for(const part of currentParts) view.append(drawPolygon(part,{changed:dirty.has(part.id)}));
    for(const change of changes.filter(item=>item.type==='removed')){
      const removed=baseline.find(part=>part.id===change.id);
      if(removed) view.append(drawPolygon(removed,{removed:true}));
    }
    card.append(element('strong',title),view);
    for(const change of changes) card.append(element('p',differenceText(change)));
    if(!entry){card.append(element('p','生成时保存的原稿'));return card;}
    if(!changes.length)card.append(element('p','部件参数一致'));
    const controls=element('div',null,'shape-tools');
    if(entry.id!==id) controls.append(link('打开编辑',toDraft(entry.id)));
    const adopt=action(entry.adopted?'已采用':'采用',()=>void adoptVersion(entry.id));
    adopt.disabled=!!entry.adopted||busy;controls.append(adopt);
    card.append(controls);return card;
  }

  function renderVersions(){
    const root=family(), holder=$('shapeVersions');
    holder.replaceChildren();
    $('exportComparison').hidden=!root;
    if(!root){
      holder.append(element('p','选一个未锁定部件，用规则推敲生成候选后，可查看被改动的轮廓和参数。','shape-muted'));
      return;
    }
    holder.append(versionCard(root.root.parentName+' · 原稿',root.root.parts,[]));
    for(const entry of root.items){
      holder.append(versionCard(entry.name,entry.draft.parts,model.diff(root.root.parts,entry.draft.parts),{entry,baseline:root.root.parts}));
    }
  }

  function renderAi(){
    const jobs=Object.values(doc.jobs).filter(job=>job.sourceId===id&&job.partSource&&job.outputs?.length).sort((a,b)=>b.createdAt-a.createdAt);
    $('shapeAiResults').hidden=!jobs.length;
    const holder=$('aiResultList');
    holder.replaceChildren();
    for(const job of jobs){
      for(const output of job.outputs){
        const card=element('article',null,'shape-version');
        const img=element('img');img.alt=output.name;
        void cachedUrl(output.blobId).then(url=>{if(url&&img.isConnected)img.src=url;});
        card.append(element('strong',output.name),img,
          element('p','目标部件：'+job.partSource.name+' · '+job.protectedAreas.length+' 个部件保留'));
        const onBoard=doc.assets[output.id];
        const actions=element('div',null,'shape-tools');
        if(onBoard) actions.append(link('查看图卡',toBoard(output.id)));
        else actions.append(action('放到工作台',()=>void task(async()=>{
          doc=await store.change(current=>flow.promoteOutput(current,job.id,output.id));
          show('精修图已放到工作台。');
        })));
        card.append(actions);
        holder.append(card);
      }
    }
  }

  function render(){
    if(!asset()?.draft) return;
    $('shapeTitle').textContent=asset().name;
    document.title=asset().name+' · 部件推敲 · 物映';
    $('shapeDimensions').textContent=asset().width+' × '+asset().height+' px';
    // 过期标记：结构改过之后，下游阶段的旧结果可能过期（橙点提示）
    for(const [stage,anchor] of [['ortho',$('railOrtho')],['render',$('railRender')]]){
      anchor.classList.toggle('is-stale',stageBook.staleOf(asset()?.flow,stage));
    }
    renderControls();renderCanvas();renderVersions();renderAi();
  }

  async function task(action){
    if(busy) return;
    busy=true;updateButtons();
    try{await action();}
    catch(error){show(error.message,true);}
    finally{busy=false;render();}
  }

  function liveAsset(current,revision){
    const found=current.assets[id];
    if(!found?.draft) throw new Error('这张部件草稿已移除。');
    if(found.draft.revision!==revision) throw new Error('草稿在另一处更新了。请重新操作。');
    return found;
  }

  async function saveDraft(updater,message){
    const revision=asset().draft.revision;
    try{
      doc=await store.change(current=>{
        const draft=liveAsset(current,revision);
        const next=updater(draft.draft.parts,draft);
        draft.draft.parts=next;
        draft.draft.revision=uid();
        // P0 过期标记：部件结构修订号变了，基于旧修订号生成的三视图/渲染结果标过期
        if(draft.flow?.stages&&(draft.flow.stages.ortho||draft.flow.stages.render)){
          const flowNext={...draft.flow,stages:{...draft.flow.stages}};
          stageBook.markStale(flowNext,'refine');
          draft.flow=flowNext;
        }
        draft.updatedAt=Math.max(Date.now(),(draft.updatedAt||0)+1);
      });
    }catch(error){doc=await store.read();throw error;}
    show(message);
    scheduleLiveShape();
  }

  function nextName(items){return '部件 '+(items.length+1);}
  function addShape(shape){
    return task(async()=>{
      const partId=uid();
      await saveDraft((items,source)=>[...items,model.createPart(partId,shape,nextName(items),{
        x:source.width/2,y:source.height/2,width:source.width*.27,height:source.height*.22,angle:0
      },source)],'已添加部件，可拖动位置或设置参数。');
      selected=partId;trace=false;
    });
  }

  $('addRectangle').onclick=()=>void addShape('rectangle');
  $('addEllipse').onclick=()=>void addShape('ellipse');
  $('tracePart').onclick=()=>{
    trace=!trace;
    renderControls();renderCanvas();
  };
  $('showReference').onchange=renderCanvas;
  $('triToggle').onchange=()=>{
    triView=$('triToggle').checked;
    if(triView&&trace){ trace=false; $('tracePart').setAttribute('aria-pressed','false'); }
    renderControls();renderCanvas();
  };
  $('loadExample').onclick=()=>void task(async()=>{
    await saveDraft((items,source)=>{
      if(items.length) return items;
      const template=[
        ['灯座','rectangle',.50,.82,.43,.10,true],
        ['支架','rectangle',.50,.56,.059,.44,true],
        ['灯罩','ellipse',.50,.28,.47,.27,false]
      ];
      return template.map(([name,shape,x,y,width,height,locked])=>model.createPart(uid(),shape,name,{
        x:x*source.width,y:y*source.height,width:width*source.width,height:height*source.height,angle:0,locked
      },source));
    },'已载入台灯，灯座与支架已锁定。可试着改变灯罩宽度。');
  });
  $('toggleLock').onclick=()=>void task(async()=>{
    const part=active();
    if(!part) return;
    await saveDraft((items,source)=>{
      // P1：锁定写入方案级 design.locks（唯一真实源），同时双写 draft 部件的 locked，
      // 让像素链路（editRegion/renderRegion 保护区）在过渡期继续工作
      designModel.applyLock(source,part.id,!part.locked);
      return model.updatePart(items,part.id,{locked:!part.locked},source);
    },
      part.locked?'已解除 '+part.name+' 的锁定。':'已锁定 '+part.name+'。');
  });
  // 锁定其余：只留当前部件可改（微调最常用的一步）
  $('lockOthers').onclick=()=>void task(async()=>{
    const part=active();
    if(!part) return;
    await saveDraft((items,source)=>{
      for(const item of items) designModel.applyLock(source,item.id,item.id!==part.id);
      return items.map(item=>({...item,locked:item.id!==part.id}));
    },'已锁定其余部件，只保留「'+part.name+'」可改。');
  });
  // 矢量化底图：线稿位图 → 二值化 → 连通域轮廓 → 简化 → 逐个描线部件（P2）
  $('vectorize').onclick=()=>void task(async()=>{
    const ref=asset()?.draft?.reference;
    if(!ref) throw new Error('这份草稿没有底图：先回到草图阶段转线稿，再进入微调。');
    const url=await cachedUrl(ref.blobId);
    if(!url) throw new Error('底图读取失败，请回到草图重新进入微调。');
    const image=await new Promise((resolve,reject)=>{
      const node=new Image();
      node.onload=()=>resolve(node);
      node.onerror=()=>reject(new Error('底图解码失败，请重新转线稿。'));
      node.src=url;
    });
    const source=asset();
    const sheet=document.createElement('canvas');
    sheet.width=source.width;sheet.height=source.height;
    const context=sheet.getContext('2d');
    context.drawImage(image,0,0,sheet.width,sheet.height);
    const pixels=context.getImageData(0,0,sheet.width,sheet.height);
    const grid=vectorize.binarize(pixels.data,sheet.width,sheet.height);
    const found=vectorize.detectParts(grid,sheet.width,sheet.height,
      {minPixels:Math.round(sheet.width*sheet.height/9000),minArea:sheet.width*sheet.height*0.0015,maxParts:8});
    if(!found.length) throw new Error('底图里没找到闭合轮廓：先回到草图跑一次「整理线稿」再试。');
    let created=0;
    await saveDraft((items,source0)=>{
      const next=[...items];
      for(const candidate of found){
        try{ next.push(model.tracePart(uid(),nextName(next),candidate.points,source0)); created++; }
        catch{ /* 轮廓不闭合或过于复杂：跳过，不打断其余部件 */ }
      }
      if(!created) throw new Error('识别到的轮廓不够闭合，先整理线稿再试。');
      return next;
    },'已从底图矢量化出 '+created+' 个部件（共识别 '+found.length+' 个轮廓）。');
    if(created) selected=null;
  });
  $('removePart').onclick=()=>void task(async()=>{
    const part=active();
    if(part) await saveDraft(items=>model.removePart(items,part.id),'已移除 '+part.name+'。');
  });
  $('partForm').onsubmit=event=>{
    event.preventDefault();
    const part=active();
    if(!part||part.locked) return;
    const patch=Object.fromEntries(Object.entries(fields).map(([key,control])=>[key,key==='name'?control.value:control.valueAsNumber]));
    void task(()=>saveDraft((items,source)=>model.updatePart(items,part.id,patch,source),'已更新 '+part.name+' 的参数。'));
  };
  $('variantField').onchange=()=>{
    $('variantAmountLabel').firstElementChild.textContent=$('variantField').value==='angle'?'幅度（°）':'幅度（%）';
  };

  function childPosition(current,source,index){
    const x=source.x+320;
    let y=source.y+index*255;
    const occupied=[...Object.values(current.assets),...Object.values(current.blocks)];
    while(occupied.some(node=>Math.abs(node.x-x)<240&&Math.abs(node.y-y)<224)) y+=255;
    return {x,y};
  }
  $('variantForm').onsubmit=event=>{
    event.preventDefault();
    const part=active(), revision=asset().draft.revision, key=$('variantField').value, amount=$('variantAmount').valueAsNumber;
    if(!part||part.locked) return;
    void task(async()=>{
      let count=0,lineage;
      try{
        doc=await store.change(current=>{
          const parent=liveAsset(current,revision);
          lineage=model.snapshot(parent);
          const list=model.variants(parent.draft.parts,part.id,key,amount,parent);
          count=list.length;
          list.forEach((candidate,index)=>{
            const id=uid(),time=Date.now(), reference=parent.draft.reference;
            current.assets[id]={id,name:part.name+' · '+candidate.label,...childPosition(current,parent,index),
              width:parent.width,height:parent.height,layers:[],createdAt:time,updatedAt:time,
              draft:{revision:uid(),parts:candidate.parts,lineage,...(reference?{reference}:{})}};
          });
        });
      }catch(error){doc=await store.read();throw error;}
      comparison=lineage;
      show('已生成 '+count+' 个可编辑候选。只有 '+part.name+' 的'+model.labels[key]+'发生变化。');
    });
  };
  async function adoptVersion(entryId){
    await task(async()=>{
      doc=await store.change(current=>{
        const picked=current.assets[entryId], group=picked?.draft?.lineage;
        if(!group) throw new Error('该候选已不存在。');
        for(const item of Object.values(current.assets)){
          const parent=item.draft?.lineage;
          if(parent?.parentId===group.parentId&&parent.revision===group.revision) item.adopted=item.id===entryId;
        }
      });
      show('已采用该候选。它仍是可以继续编辑的独立草稿。');
    });
  }

  $('exportComparison').onclick=()=>{
    const data=family();
    if(!data) return;
    const output={project:project.name,baseline:data.root,
      versions:data.items.map(item=>({id:item.id,name:item.name,createdAt:item.createdAt,adopted:!!item.adopted,
        changes:model.diff(data.root.parts,item.draft.parts),parts:item.draft.parts}))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'}));
    const anchor=element('a');anchor.download='物映-部件对照.json';anchor.href=url;
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  };

  function canvasPoint(event){
    const p=canvas.createSVGPoint();p.x=event.clientX;p.y=event.clientY;
    const point=p.matrixTransform(canvas.getScreenCTM().inverse());
    const limit=gesture?.layout||(triView?triLayout():asset());
    return {x:Math.min(limit.width,Math.max(0,point.x)),y:Math.min(limit.height,Math.max(0,point.y))};
  }
  canvas.onpointerdown=event=>{
    if(event.button!==0||busy||gesture) return;
    const layout=triView?triLayout():null;
    const start=canvasPoint(event);
    if(trace&&!layout){
      gesture={id:event.pointerId,points:[start]};
    }else{
      const nodeEl=event.target.closest('[data-node]');
      if(nodeEl){
        // P2 节点拖动：描线部件的锚点，未锁定时才可拖
        const part=parts().find(item=>item.id===nodeEl.dataset.part);
        if(part&&!part.locked&&part.shape==='polygon'){
          selected=part.id;renderControls();
          gesture={id:event.pointerId,kind:'node',index:Number(nodeEl.dataset.node),source:part,part,layout:null,invalid:false};
        }
      }else{
      const handle=event.target.closest('[data-handle]');
      if(handle){
        const part=parts().find(item=>item.id===handle.dataset.part);
        if(part&&!part.locked){
          selected=part.id;renderControls();
          gesture={id:event.pointerId,kind:'depth',mode:handle.dataset.handle==='depth-side'?'side':'top',
            start,source:part,part,layout};
        }
      }else{
        const part=parts().find(item=>item.id===event.target.closest('[data-part]')?.dataset.part);
        if(!part) return;
        selected=part.id;renderControls();
        if(!part.locked){
          if(!layout) gesture={id:event.pointerId,kind:'move',start,source:part,part,layout};
          else if(start.x>layout.side.x) gesture={id:event.pointerId,kind:'z',axis:'x',start,source:part,part,layout};
          else if(start.y>layout.top.y) gesture={id:event.pointerId,kind:'z',axis:'y',start,source:part,part,layout};
          else gesture={id:event.pointerId,kind:'move',start,source:part,part,layout};
        }
      }
      }
    }
    renderCanvas();
    if(gesture) canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove=event=>{
    if(gesture?.id!==event.pointerId) return;
    const point=canvasPoint(event);
    if(gesture.points){
      const last=gesture.points.at(-1);
      if(gesture.points.length<700&&Math.hypot(last.x-point.x,last.y-point.y)>.9) gesture.points.push(point);
    }else if(gesture.kind==='node'){
      // P2：屏幕坐标 → 部件归一化局部坐标（逆旋转 + 逆缩放），自交/退化就保持上一合法形状
      const part=gesture.source;
      const angle=part.angle*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
      const dx=point.x-part.x,dy=point.y-part.y;
      const local={x:(dx*c+dy*s)/(part.width||1),y:(-dx*s+dy*c)/(part.height||1)};
      const result=model.moveNode(part,gesture.index,local);
      if(result.ok){ gesture.part=result.part; gesture.invalid=false; }
      else gesture.invalid=true;
    }else if(gesture.kind==='move'){
      const {source,start}=gesture;
      const patch={x:source.x+point.x-start.x,y:source.y+point.y-start.y};
      try{gesture.part=model.updatePart([source],source.id,patch,asset())[0];}catch{}
    }else if(gesture.kind==='z'){
      const delta=gesture.axis==='x'?point.x-gesture.start.x:point.y-gesture.start.y;
      gesture.part={...gesture.source,z:Math.round((gesture.source.z+delta)*100)/100};
    }else if(gesture.kind==='depth'){
      const delta=gesture.mode==='side'?point.x-gesture.start.x:point.y-gesture.start.y;
      gesture.part={...gesture.source,depth:Math.max(4,Math.round((gesture.source.depth+delta)*100)/100)};
    }
    renderCanvas();
  };
  canvas.onpointerup=event=>{
    if(gesture?.id!==event.pointerId) return;
    const final=gesture;
    gesture=undefined;renderCanvas();
    if(final.points){
      const partId=uid();
      void task(async()=>{
        await saveDraft((items,source)=>[...items,model.tracePart(partId,nextName(items),final.points,source)],'已添加描线部件。');
        selected=partId;trace=false;
      });
    }else if(final.kind==='node'){
      if(final.part!==final.source&&JSON.stringify(final.part.points)!==JSON.stringify(final.source.points)){
        void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{points:final.part.points},source),
          '已调整 '+final.part.name+' 的节点。'));
      }
    }else if(final.kind==='move'){
      if(final.part.x!==final.source.x||final.part.y!==final.source.y){
        void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{x:final.part.x,y:final.part.y},source),'已移动 '+final.part.name+'。'));
      }
    }else if(final.kind==='z'){
      if(final.part.z!==final.source.z){
        void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{z:final.part.z},source),'已调整 '+final.part.name+' 的深度位置。'));
      }
    }else if(final.kind==='depth'){
      if(final.part.depth!==final.source.depth){
        void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{depth:final.part.depth},source),'已调整 '+final.part.name+' 的厚度。'));
      }
    }
  };
  canvas.onpointercancel=()=>{gesture=undefined;renderCanvas();};

  $('partAiForm').onsubmit=event=>{
    event.preventDefault();
    const part=active(), draft=asset().draft;
    if(!part||part.locked) return;
    const prompt=$('partPrompt').value.trim();
    if(!prompt){show('请输入当前部件需要改动的内容。',true);$('partPrompt').focus();return;}
    const prefs=flow.modelPrefs();
    if(!prefs.checkpoint){show('请在本机模型设置中读取并选择 ComfyUI 基础模型。',true);return;}
    void task(async()=>{
      controller=new AbortController();updateButtons();
      const signal=controller.signal;
      try{
        await flow.run(store,{kind:'modify',sourceId:id,partId:part.id,draftRevision:draft.revision,
          prompt,quantity:1,provider:'comfy',endpoint:prefs.endpoint,checkpoint:prefs.checkpoint},{
          signal,onStatus:message=>show(message)
        });
        show('已完成 '+part.name+' 的精修，可查看结果或放到工作台。');
      }catch(error){
        if(signal.aborted) show('已停止精修。');else throw error;
      }finally{controller=undefined;doc=await store.read();}
    });
  };
  $('partAiCancel').onclick=()=>controller?.abort();

  // ── 锁定感知实时辅助：只重渲选中的未锁定部件，锁定部件像素保持不变 ──
  // 源图始终是进入微调时的底图（draft.reference），遮罩是选中部件外扩后的轮廓
  // （外扩是为了把旧轮廓的线条一起重绘掉）；条件图是新轮廓的栅格化线稿，走 ControlNet
  // 锁住形状，避免模型自由发挥；渲染完把补丁合成回底图预览，锁定部件永不改动。
  let liveOn=false, liveBusy=false, liveTimer, liveController, liveSeed=crypto.getRandomValues(new Uint32Array(1))[0], liveUrl='';
  const liveParts=()=>{ const part=active(); return part&&!part.locked?{edit:part,locked:parts().filter(item=>item.locked&&item.id!==part.id)}:null; };
  const partPoints=(part,width,height)=>model.polygon(part).map(({x,y})=>({x:x/width,y:y/height}));
  // 遮罩外扩：以质心为基准放大轮廓，让重绘覆盖到旧轮廓线（沿部件最小边的固定比例）
  function dilatePolygon(points,factor=1.05){
    const cx=points.reduce((sum,p)=>sum+p.x,0)/points.length;
    const cy=points.reduce((sum,p)=>sum+p.y,0)/points.length;
    return points.map(p=>({x:cx+(p.x-cx)*factor,y:cy+(p.y-cy)*factor}));
  }
  // 线稿条件图：把当前轮廓（含其他部件轮廓作上下文）栅格化到裁剪尺寸，喂给 ControlNet
  function buildGuideBlob(prepared,edit,size){
    const {crop}=prepared;
    const width=Math.max(64,Math.round(crop.width/2)*2),height=Math.max(64,Math.round(crop.height/2)*2);
    const sheet=document.createElement('canvas');
    sheet.width=width;sheet.height=height;
    const ctx=sheet.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    const sx=width/crop.width,sy=height/crop.height;
    const map=point=>({x:(point.x*size.width-crop.x)*sx,y:(point.y*size.height-crop.y)*sy});
    const trace=points=>{
      const mapped=points.map(map);
      ctx.beginPath();
      mapped.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));
      ctx.closePath();
      ctx.stroke();
    };
    ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle='#000';
    ctx.lineWidth=Math.max(1.5,width/260);ctx.globalAlpha=.4;
    for(const part of parts()) if(part.id!==edit.id) trace(model.polygon(part));
    ctx.globalAlpha=1;
    ctx.lineWidth=Math.max(3,width/110);
    trace(model.polygon(edit));
    return new Promise(resolve=>sheet.toBlob(resolve,'image/png'));
  }
  // ControlNet 解析：优先后台已选，否则从 ComfyUI 里挑一个 scribble/lineart
  let controlnetCache=null;
  async function resolveControlnet(prefs){
    if(prefs.controlnet) return prefs.controlnet;
    if(controlnetCache!==null) return controlnetCache;
    try{
      const base=(prefs.endpoint||'http://127.0.0.1:8188').replace(/\/+$/,'');
      const response=await fetch(base+'/object_info/ControlNetLoader');
      const data=await response.json();
      const names=data?.ControlNetLoader?.input?.required?.control_net_name?.[0]||[];
      controlnetCache=names.find(name=>/scribble|lineart|line[_-]art/i.test(name))||names[0]||'';
    }catch{ controlnetCache=''; }
    return controlnetCache;
  }
  function liveState(message,error=false){
    $('liveState').textContent=message;
    $('liveState').dataset.error=String(error);
    $('liveRetry').hidden=!error;
  }
  function scheduleLiveShape(){
    if(!liveOn) return;
    clearTimeout(liveTimer);
    liveTimer=setTimeout(()=>void renderLiveShape(),500);
  }
  // 结构条件渲染：把所有部件的当前轮廓画成一张结构图（灰面 + 深色边），
  // 走 scribble ControlNet 出整图产品效果图。锁定部件因为轮廓就在结构图里，形态不会变。
  function buildStructureBlob(size){
    const sheet=document.createElement('canvas');
    sheet.width=size.width;sheet.height=size.height;
    const ctx=sheet.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,sheet.width,sheet.height);
    const draw=(part,fill,alpha)=>{
      const points=model.polygon(part);
      ctx.globalAlpha=alpha;
      ctx.fillStyle=fill;
      ctx.strokeStyle='#1d1d1f';
      ctx.lineWidth=Math.max(3,size.width/260);
      ctx.lineJoin='round';ctx.lineCap='round';
      ctx.beginPath();
      points.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));
      ctx.closePath();
      ctx.fill();ctx.stroke();
      ctx.globalAlpha=1;
    };
    for(const part of parts()) draw(part,part.locked?'#c9c9cc':'#dedede',1);
    return new Promise(resolve=>sheet.toBlob(resolve,'image/png'));
  }
  function livePrompt(subject){
    return [
      $('partPrompt').value.trim(),
      subject||'product',
      'front view product design render, single object centered, white and light gray matte plastic with brushed aluminum, bright clean studio background, soft shadows',
      'clean industrial design, crisp edges, high detail'
    ].filter(Boolean).join(', ');
  }
  const liveNegative='lowres, worst quality, low quality, jpeg artifacts, blurry, out of focus, watermark, text, extra objects, cluttered, deformed, sketch, lineart, outline, white background with black lines';
  async function renderStructure(prefs,size,subject){
    // 尺寸保持画布比例，长边 768（实时帧够快且细节够看）
    const long=768;
    const ratio=size.width/size.height;
    const latentWidth=ratio>=1?long:Math.round(long*ratio/8)*8;
    const latentHeight=ratio>=1?Math.round(long/ratio/8)*8:long;
    const structure=await buildStructureBlob(size);
    const controlnet=await resolveControlnet(prefs);
    const {blob}=await window.WuyingComfy.renderLive({
      endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,controlnet,
      prompt:livePrompt(subject),negative:liveNegative,input:'sketch',quality:'live',
      sourceImage:structure,strength:.9,seed:liveSeed,
      latentWidth,latentHeight,tier:'balanced',
      slot:'shape-live-'+id.slice(0,8),signal:liveController.signal,onStatus:()=>{}
    });
    return {blob,controlnet};
  }
  async function renderRegion(prefs,target,size,subject){
    const sourceBlob=await store.getBlob(asset()?.draft?.reference?.blobId);
    if(!sourceBlob) throw new Error('底图丢失，无法局部重绘。');
    // 遮罩比轮廓外扩 5%，连旧轮廓线一起重绘，避免新旧边线叠影
    const maskPoints=dilatePolygon(partPoints(target.edit,size.width,size.height),1.05);
    const prepared=await window.WuyingImageSelection.prepare(sourceBlob,maskPoints,
      target.locked.map(part=>partPoints(part,size.width,size.height)));
    const guideBlob=await buildGuideBlob(prepared,target.edit,size);
    const controlnet=await resolveControlnet(prefs);
    const {blob}=await window.WuyingComfy.renderRegion({
      endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,prompt:livePrompt(subject),
      sourceImage:prepared.sourceImage,maskImage:prepared.maskImage,
      guideImage:guideBlob,controlnet,controlStrength:.85,
      denoise:Number($('liveStrength').value)/100,seed:liveSeed,
      slot:'shape-live-'+id.slice(0,8),signal:liveController.signal,onStatus:()=>{}
    });
    return {blob:await window.WuyingImageSelection.composite(prepared,blob,{feather:6}),controlnet};
  }
  async function renderLiveShape(){
    if(!liveOn) return;
    const ref=asset()?.draft?.reference, prefs=flow.modelPrefs();
    const mode=$('liveMode').value;
    const target=liveParts();
    // 结构渲染只需要部件结构，不必选中部件；局部重绘必须有选中的未锁定部件
    if(mode==='region'&&!target){liveState('局部重绘需要先选中一个未锁定的部件。');return;}
    if(!parts().length){liveState('还没有部件：先描轮廓或矢量化底图。',true);return;}
    if(mode==='region'&&!ref){liveState('这份草稿没有底图，先回图像编辑出图，再「拆成部件」。',true);return;}
    if(liveBusy){scheduleLiveShape();return;}
    liveBusy=true;
    $('liveToggle').disabled=true;
    liveState(mode==='region'?'正在局部重绘 '+(target.edit.name)+'…':'正在按结构渲染…');
    liveController=new AbortController();
    try{
      const size=asset();
      const brief=asset()?.flow?.brief||{};
      const subject=[brief.category,brief.text].filter(Boolean).join(', ');
      const {blob,controlnet}=mode==='region'
        ?await renderRegion(prefs,target,size,subject)
        :await renderStructure(prefs,size,subject);
      if(liveUrl) URL.revokeObjectURL(liveUrl);
      liveUrl=URL.createObjectURL(blob);
      $('liveImage').src=liveUrl;
      liveState(mode==='region'
        ?'已按最新轮廓重绘 '+target.edit.name+(controlnet?'（线稿锁形）':'（提示词兜底）')+'，锁定部件像素未改动。'
        :'已按当前结构渲染'+(controlnet?'（线稿锁形）':'（提示词兜底）')+'：所有部件轮廓与画布一致，锁定件形态不变。');
    }catch(error){
      if(liveController?.signal.aborted) liveState('已停止。');
      else liveState('渲染失败：'+error.message,true);
    }finally{
      liveBusy=false;liveController=undefined;
      $('liveToggle').disabled=busy;
    }
  }
  function setLiveShape(on){
    liveOn=on;
    $('liveToggle').textContent=on?'关闭实时辅助':'开启实时辅助';
    $('liveToggle').setAttribute('aria-pressed',String(on));
    $('livePane').hidden=!on;
    if(on){ liveSeed=crypto.getRandomValues(new Uint32Array(1))[0]; scheduleLiveShape(); }
    else{ clearTimeout(liveTimer); liveController?.abort(); liveState('等待调整'); }
  }
  $('liveToggle').onclick=()=>{
    const prefs=flow.modelPrefs();
    if(!liveOn&&(!prefs.endpoint||!prefs.checkpoint)){show('请先在本机模型设置里连接 ComfyUI。',true);return;}
    setLiveShape(!liveOn);
  };
  $('liveRetry').onclick=()=>{ $('liveRetry').hidden=true; scheduleLiveShape(); };
  $('liveStrength').addEventListener('input',()=>{ $('liveStrengthValue').textContent=$('liveStrength').value+'%'; });
  $('liveStrength').addEventListener('change',scheduleLiveShape);
  $('liveMode').addEventListener('change',scheduleLiveShape);
  $('partPrompt').addEventListener('input',scheduleLiveShape);

  // ── 阶段轨道：微调完成去三视图 / 回草图（P0：前进条件 + 冻结快照）──
  const boardQuery='?project='+encodeURIComponent(project?.id||'');
  $('railSketch').href='image-studio.html'+boardQuery+'&asset='+encodeURIComponent(id);
  $('railOrtho').href='image-studio.html'+boardQuery+'&asset='+encodeURIComponent(id)+'&stage=ortho';
  $('railRender').href='image-studio.html'+boardQuery+'&asset='+encodeURIComponent(id)+'&stage=render';
  const stepHref={sketch:$('railSketch').href,ortho:$('railOrtho').href,render:$('railRender').href};
  async function goStage(event,stage){
    event.preventDefault();
    // 前进条件：离开微调至少要有 1 个部件（违规校验随 P2 约束系统补上）
    if(stage!=='sketch'&&!parts().length){
      show('还没有部件：先描轮廓或添加矩形、椭圆，再去下一阶段。',true);
      return;
    }
    try{
      doc=await store.change(current=>{
        const target=current.assets[id];
        if(!target?.flow) return;
        const next={...target.flow,stage};
        next.stages={...(target.flow.stages||{})};
        // 冻结快照：离开微调时把当前结构修订号存档，三视图/渲染以它判定过期
        if(stage!=='sketch'&&target.draft?.revision){
          stageBook.capture(next,'refine',{revision:target.draft.revision});
        }
        target.flow=next;
        target.updatedAt=Date.now();
      });
      location.assign(stepHref[stage]);
    }catch(error){ show(error.message,true); }
  }
  for(const [stage,anchor] of [['sketch',$('railSketch')],['ortho',$('railOrtho')],['render',$('railRender')]]){
    anchor.addEventListener('click',event=>void goStage(event,stage));
  }

  window.addEventListener('pageshow',event=>{
    if(event.persisted&&store) void store.read().then(next=>{doc=next;render();}).catch(error=>show(error.message,true));
  });
  window.addEventListener('pagehide',event=>{
    controller?.abort();
    if(!event.persisted) for(const pending of urls.values()) void pending.then(url=>{if(url)URL.revokeObjectURL(url);});
  });

  async function init(){
    try{
      if(!store) throw new Error('找不到这个项目。');
      doc=await store.read();
      if(!asset()?.draft) throw new Error('找不到这份部件草稿。');
      // 旧草稿迁移：部件补全厚度/深度位置（读取时一次性落盘）
      if(model.needsNormalize(asset().draft.parts)){
        doc=await store.change(current=>{
          const target=current.assets[id];
          if(target?.draft&&model.needsNormalize(target.draft.parts)){
            target.draft.parts=model.normalizeParts(target.draft.parts);
            target.draft.revision=uid();
            target.updatedAt=Date.now();
          }
        });
        show('已为旧草稿的部件补全厚度与深度位置。');
      }
      // P1 数据模型迁移：draft → design（方案级锁定表 + 正视轮廓节点），draft 保留一个周期
      if(designModel.needsMigration(asset())){
        doc=await store.change(current=>{
          const target=current.assets[id];
          if(target&&designModel.migrate(target)) target.updatedAt=Date.now();
        });
        show('部件草稿已迁移到方案结构 design，锁定改存方案级锁定表。');
      }
      $('shapeBack').href=toBoard(id);
      $('shapeImage').href=toImage(id);$('shapeImage').hidden=false;
      $('shapeFlowRail').hidden=false;
      $('shapeProject').textContent=project.name;
      $('shapeShell').hidden=false;
      render();
    }catch(error){show(error.message,true);}
  }
  void init();
})();

