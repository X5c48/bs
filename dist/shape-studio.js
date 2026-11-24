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
  let pickedNode=null;
  function nodeHandlesOf(part,invalid){
    if(!part||part.locked||part.shape!=='polygon'||!Array.isArray(part.points)) return [];
    const angle=part.angle*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    return part.points.flatMap((point,index)=>{
      const x=part.x+point.x*part.width*c-point.y*part.height*s;
      const y=part.y+point.x*part.width*s+point.y*part.height*c;
      const node=svg('circle');
      node.setAttribute('cx',x);node.setAttribute('cy',y);node.setAttribute('r',4.2);
      node.setAttribute('class','shape-node'+(invalid?' is-invalid':''));
      node.style.cursor='crosshair';
      node.dataset.node=String(index);node.dataset.part=part.id;
      if(pickedNode?.id!==part.id||pickedNode.index!==index) return [node];
      node.style.stroke='#d25913';
      const handles=[];
      for(const side of ['in','out']){
        const actual=model.world(part,point[side]||point);
        // 零长度手柄显示在锚点两侧，直到第一次拖动才写入轮廓。
        if(Math.hypot(actual.x-x,actual.y-y)<1) actual.x+=side==='in'?-14:14;
        handles.push(guideLine(x,y,actual.x,actual.y));
        const handle=node.cloneNode(false);
        handle.dataset.control=side;
        handle.setAttribute('cx',actual.x);handle.setAttribute('cy',actual.y);
        handle.style.fill='#ffb477'; handles.push(handle);
      }
      return [...handles,node];
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
      const invalid=gesture?.kind==='node'&&gesture.invalid===true;
      for(const part of parts()){
        const shown=shownOf(part);
        nodes.push(drawPolygon(shown,{selected:part.id===selected,invalid:invalid&&part.id===selected}));
      }
      const active=parts().find(part=>part.id===selected);
      if(active&&!active.locked&&!trace){
        const shown=shownOf(active);
        for(const sx of [-1,1]) for(const sy of [-1,1]){
          const corner=model.world(shown,{x:sx*(.5+8/shown.width),y:sy*(.5+8/shown.height)});
          const handle=svg('rect');
          handle.setAttribute('x',corner.x-4.5);handle.setAttribute('y',corner.y-4.5);
          handle.setAttribute('width',9);handle.setAttribute('height',9);
          handle.setAttribute('class','shape-handle');handle.dataset.scale=active.id;
          handle.dataset.sx=sx;handle.dataset.sy=sy;
          handle.style.cursor=sx===sy?'nwse-resize':'nesw-resize';nodes.push(handle);
        }
        nodes.push(...nodeHandlesOf(shown,invalid));
      }
    }
    if(gesture?.points){
      // 描线预览必须进 nodes 一起提交：之前是单独 append，紧接着 replaceChildren 就把它抹掉了，
      // 表现为「描轮廓时看不到自己画的线」。
      const line=svg('polyline');line.setAttribute('class','trace-line');line.setAttribute('points',pointString(gesture.points));
      nodes.push(line);
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
  function tint(hex,k){
    const n=parseInt(hex.slice(1),16),c=v=>Math.round(v*k);
    return 'rgb('+c(n>>16&255)+','+c(n>>8&255)+','+c(n&255)+')';
  }
  function renderPeek(){
    const list=parts().map(part=>gesture?.part?.id===part.id?gesture.part:part);
    drawLiveOutline(list);
    $('shapePeek').hidden=!list.length;
    if(!list.length){peekSvg.replaceChildren();return;}
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
    $('removePart').title=part?.locked?'先解锁此部件，再删除。':part?'删除「'+part.name+'」':'请先选择一个部件。';
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
    if(selected!==lastSelected){lastSelected=selected;if(liveOn&&$('liveMode').value==='region') resetLiveImage();scheduleLiveShape();}
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
    syncTidy();
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
    // 过期标记：三视图归到产品渲染下，任一取景方式的旧结果过期都在同一段提示。
    $('railRender').classList.toggle('is-stale',
      stageBook.staleOf(asset()?.flow,'render')||stageBook.staleOf(asset()?.flow,'ortho'));
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
        const frontView=draft.design?.views?.front;
        if(frontView&&!frontView.renderBase&&draft.draft.reference){
          frontView.renderBase={blobId:draft.draft.reference.blobId,parts:structuredClone(draft.draft.parts),revision};
        }
        const next=updater(draft.draft.parts,draft);
        const previous=draft.draft.parts;
        if(frontView?.renderBase){
          for(const part of next) if(!previous.some(item=>item.id===part.id)&&!frontView.renderBase.parts.some(item=>item.id===part.id)){
            frontView.renderBase.parts.push(structuredClone(part));
          }
        }
        draft.draft.parts=next;
        draft.draft.revision=uid();
        if(draft.design?.views?.front){
          const front=draft.design.views.front;
          for(const part of next){
            if(previous.find(old=>old.id===part.id)!==part) front.outlines[part.id]=model.outline(part);
          }
          for(const old of previous) if(!next.some(part=>part.id===old.id)) delete front.outlines[old.id];
          front.revision=draft.design.revision=draft.draft.revision;
        }
        // P0 过期标记：部件结构修订号变了，基于旧修订号生成的三视图/渲染结果标过期
        if(draft.flow?.stages&&(draft.flow.stages.ortho||draft.flow.stages.render)){
          const flowNext={...draft.flow,stages:{...draft.flow.stages}};
          stageBook.markStale(flowNext,'refine');
          draft.flow=flowNext;
        }
        draft.updatedAt=Math.max(Date.now(),(draft.updatedAt||0)+1);
      });
    }catch(error){doc=await store.read();throw error;}
    show(typeof message==='function'?message():message);
    scheduleLiveShape(500);
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
        try {
          const traced=model.tracePart(uid(),nextName(next),candidate.points,source0);
          const fit=model.regularize(traced,source0);
          next.push(fit.ok && fit.score >= .82 ? fit.part : traced);
          created++;
        }
        catch{ /* 轮廓不闭合或过于复杂：跳过，不打断其余部件 */ }
      }
      if(!created) throw new Error('识别到的轮廓不够闭合，先整理线稿再试。');
      return next;
    },()=>'已从底图矢量化出 '+created+' 个部件（共识别 '+found.length+' 个轮廓）。');
    if(created) selected=null;
  });
  $('removePart').onclick=()=>void task(async()=>{
    const part=active();
    if(!part||part.locked) return;
    const index=parts().findIndex(item=>item.id===part.id);
    await saveDraft((items,source)=>{
      const remaining=model.removePart(items,part.id);
      if(source.design){
        delete source.design.parts[part.id];delete source.design.locks[part.id];
        for(const view of Object.values(source.design.views||{})) if(view.outlines) delete view.outlines[part.id];
        const span=model.depthSpan(remaining);
        source.design.bounds.depth=span.max-span.min;
      }
      return remaining;
    },'已删除 '+part.name+'。');
    pickedNode=null;selected=parts()[Math.min(index,parts().length-1)]?.id||null;
    resetLiveImage();
    if(liveOn&&$('liveMode').value==='region'&&parts().length){
      $('liveMode').value='render';updateLiveControls();
      show('部件已删除，已切换到结构渲染以预览剩余部件。');
    }
    if(!parts().length&&liveOn) setLiveShape(false);
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

  // ── 规整化：描线吸附标准几何，产物仍是可拖节点 ──
  const tidyNames={circle:'圆',ellipse:'椭圆',rectangle:'矩形',rounded:'圆角矩形'};
  function syncTidy(){
    const part=active();
    const hint=$('tidyHint'),suggest=$('tidySuggest');
    const buttons=[...document.querySelectorAll('[data-tidy]')];
    const editable=!!part&&!part.locked&&part.shape==='polygon';
    for(const button of buttons) button.disabled=!editable;
    suggest.disabled=!editable;
    if(!part){hint.textContent='先选中一个部件。';suggest.hidden=false;suggest.textContent='按建议规整';return;}
    if(part.locked){hint.textContent='部件已锁定，先解除锁定再规整。';suggest.hidden=false;suggest.textContent='按建议规整';return;}
    if(part.shape!=='polygon'){
      hint.textContent='已经是标准'+model.shapeNames[part.shape]+'，拖节点或用参数微调即可。';
      suggest.hidden=false;suggest.textContent='按建议规整';return;
    }
    const info=model.describeOutline(part);
    if(!info){hint.textContent='这个部件没有可规整的轮廓。';return;}
    const {suggestion}=info;
    suggest.hidden=!suggestion.target;
    suggest.textContent=suggestion.target
      ?'建议规整为'+tidyNames[suggestion.target]+'（匹配 '+Math.round(suggestion.score*100)+'%）'
      :'轮廓更接近自由造型';
    hint.textContent=suggestion.target
      ?'吸附成'+tidyNames[suggestion.target]+'后仍是可拖节点，随时能改回局部形状。'
      :'自由造型不会被强行掰圆；需要的话在下面手动选一个标准形。';
  }
  function applyTidy(target){
    const part=active();
    if(!part||busy) return;
    let result;
    try{ result=model.regularize(part,asset(),target?{target}:{}); }
    catch(error){show(error.message,true);return;}
    if(!result.ok){show(result.message||'这个轮廓暂时无法规整。',true);return;}
    if(!target&&!result.changed){show('这个部件已经是所选标准形了。');return;}
    const label=tidyNames[result.target]||'标准形';
    void task(()=>saveDraft((items,source)=>model.updatePart(items,part.id,{
      x:result.part.x,y:result.part.y,width:result.part.width,height:result.part.height,
      angle:0,points:result.part.points},source),'已规整为'+label+'，节点仍可拖动微调。'));
  }
  $('tidySuggest').onclick=()=>applyTidy(null);
  for(const button of document.querySelectorAll('[data-tidy]')) button.onclick=()=>applyTidy(button.dataset.tidy);

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
  function commitNodes(part,result,message){
    if(!result.ok){show('轮廓必须闭合、至少有三个节点且不自交。',true);return;}
    void task(()=>saveDraft((items,source)=>model.updatePart(items,part.id,{points:result.part.points},source),message));
  }
  function insertAt(event){
    const part=active();
    if(busy||trace||triView||part?.shape!=='polygon'||part.locked) return;
    const hit=model.nearestSegment(part,canvasPoint(event));
    if(hit.distance*canvas.getScreenCTM().a>10||hit.t<.002||hit.t>.998) return;
    const result=model.editNode(part,hit.index,'insert',hit.t);
    if(result.ok) pickedNode={id:part.id,index:hit.index+1};
    commitNodes(part,result,'已在线段上添加节点。');
    return true;
  }
  canvas.onkeydown=event=>{
    const part=active();
    if(event.key!=='Delete'||busy||gesture||triView||trace||!part||part.locked||pickedNode?.id!==part.id) return;
    event.preventDefault();
    const result=model.editNode(part,pickedNode.index,'delete');
    if(result.ok) pickedNode=null;
    commitNodes(part,result,'已删除选中节点。');
  };
  $('scaleApply').onclick=()=>void task(()=>{
    const part=active(),scale=$('partScale').valueAsNumber/100;
    if(!part||!Number.isFinite(scale)||scale<=0) throw new Error('请填写正的缩放比例。');
    return saveDraft((items,source)=>model.updatePart(items,part.id,{width:part.width*scale,height:part.height*scale,depth:part.depth*scale},source),'已按比例缩放部件。');
  });
  let lastPress=null;
  canvas.onpointerdown=event=>{
    if(event.button!==0||busy||gesture) return;
    const layout=triView?triLayout():null;
    const start=canvasPoint(event);
    const previous=lastPress;
    lastPress={x:event.clientX,y:event.clientY,time:event.timeStamp,id:selected};
    if(!trace&&!layout&&!event.target.closest('[data-node],[data-scale]')&&previous?.id===selected&&
       event.timeStamp-previous.time<450&&Math.hypot(previous.x-event.clientX,previous.y-event.clientY)<5&&insertAt(event)){
      lastPress=null;canvas.focus({preventScroll:true});return;
    }
    if(event.target.dataset.scale&&!layout){
      const part=active();
      if(!part||part.locked) return;
      gesture={id:event.pointerId,kind:'scale',sx:Number(event.target.dataset.sx),sy:Number(event.target.dataset.sy),start,source:part,part};
    }else if(trace&&!layout){
      gesture={id:event.pointerId,points:[start]};
    }else{
      const nodeEl=event.target.closest('[data-node]');
      if(nodeEl){
        // P2 节点拖动：描线部件的锚点，未锁定时才可拖
        const part=parts().find(item=>item.id===nodeEl.dataset.part);
        if(part&&!part.locked&&part.shape==='polygon'){
          pickedNode={id:part.id,index:Number(nodeEl.dataset.node)};
          canvas.focus({preventScroll:true});
          selected=part.id;renderControls();
          gesture={id:event.pointerId,control:nodeEl.dataset.control,kind:'node',index:Number(nodeEl.dataset.node),source:part,part,layout:null,invalid:false};
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
      const result=model.editNode(part,gesture.index,gesture.control||'anchor',local,event.altKey);
      if(result.ok){ gesture.part=result.part; gesture.invalid=false; }
      else gesture.invalid=true;
    }else if(gesture.kind==='scale'){
      const {source,start}=gesture,rad=source.angle*Math.PI/180;
      const dx=point.x-start.x,dy=point.y-start.y;
      const width=source.width+2*gesture.sx*(dx*Math.cos(rad)+dy*Math.sin(rad));
      const height=event.shiftKey?source.height*width/source.width:source.height+2*gesture.sy*(dy*Math.cos(rad)-dx*Math.sin(rad));
      try{gesture.part=model.updatePart([source],source.id,{width,height},asset())[0];}catch{}
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
    // 拖动中每 140ms 记录一次最新几何；渲染进行中也照常记录，不再丢帧
    if(liveOn&&gesture.part&&!gesture.invalid&&performance.now()-lastDragSample>=140){
      lastDragSample=performance.now();
      scheduleLiveShape(0);
    }
  };
  canvas.onpointerup=event=>{
    if(gesture?.id!==event.pointerId) return;
    const final=gesture;
    gesture=undefined;renderCanvas();
    if(liveOn){
      if(dragRequest) liveController?.abort();
      scheduleLiveShape(500);
    }
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
    }else if(final.kind==='scale'&&final.part!==final.source){
      const {width,height}=final.part;
      void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{width,height},source),'已缩放部件。'));
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
  canvas.onpointercancel=()=>{gesture=undefined;renderCanvas();scheduleLiveShape(500);};

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
  const liveParts=()=>{ const part=gesture?.part?.id===selected?gesture.part:active(); return part&&!part.locked?{edit:part,locked:parts().filter(item=>item.locked&&item.id!==part.id)}:null; };
  const partPoints=(part,width,height)=>model.polygon(part).map(({x,y})=>({x:x/width,y:y/height}));
  // 线稿条件图：把当前轮廓（含其他部件轮廓作上下文）栅格化到裁剪尺寸，喂给 ControlNet
  function buildGuideBlob(prepared,edit,size){
    const {crop}=prepared;
    const width=Math.max(64,Math.round(crop.width/2)*2),height=Math.max(64,Math.round(crop.height/2)*2);
    const sheet=document.createElement('canvas');
    sheet.width=width;sheet.height=height;
    const ctx=sheet.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    const sx=width/crop.width,sy=height/crop.height;
    const map=point=>({x:(point.x-crop.x)*sx,y:(point.y-crop.y)*sy});
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
    // 细长部件（表针等）的描边不能盖过自身宽度，否则条件图里只剩一团黑
    const bounds=model.outlineBounds(edit);
    const dim=Math.min(bounds.width,bounds.height);
    ctx.lineWidth=Math.min(Math.max(3,width/110),Math.max(1.5,dim*.4));
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
    }catch{ return ''; }
    return controlnetCache;
  }
  function resetLiveImage(){
    liveRevision++;liveController?.abort();liveFrame=null;
    $('liveAdopt').disabled=true;
    $('liveImage').hidden=true;$('liveImage').removeAttribute('src');
    if(liveUrl){URL.revokeObjectURL(liveUrl);liveUrl='';}
  }
  function drawLiveOutline(items){
    if(!liveOn) return;
    const overlay=$('liveOutline'),size=asset();
    overlay.parentElement.style.aspectRatio=size.width+'/'+size.height;
    overlay.setAttribute('viewBox','0 0 '+size.width+' '+size.height);
    overlay.replaceChildren();
    // 出图后轮廓线仍然保留在预览之上（半透明深色），方便对照渲染结果与造型是否一致；
    // 旧逻辑在这里直接 return，导致「渲染结果里看不到产品轮廓」。
    const onRender=!!liveUrl&&!livePending;
    for(const part of items){
      const line=svg('polygon');
      line.setAttribute('points',pointString(model.polygon(part)));
      line.setAttribute('fill',liveUrl?'none':'#d9d5cb');
      line.setAttribute('stroke',part.id===selected?'#816bff':onRender?'rgba(20,20,22,.55)':'#8190a5');
      line.setAttribute('stroke-width',onRender?'1':'1.5');
      line.setAttribute('vector-effect','non-scaling-stroke');
      if(onRender)line.setAttribute('class','live-contour');
      overlay.append(line);
    }
  }
  function liveState(message,error=false){
    $('liveState').textContent=message;
    $('liveState').dataset.error=String(error);
    $('liveRetry').hidden=!error;
  }
  let liveRevision=0, livePending=false, dragRequest=false;
  let lastDragSample=-Infinity, liveFrame=null, lastSelected=null, liveDue=0;
  function scheduleLiveShape(delay=140){
    if(!liveOn) return;
    clearTimeout(liveTimer);
    liveDue=performance.now()+(typeof delay==='number'?delay:140);
    livePending=true;
    // Qwen 单帧十几秒，拖动期间出图只会堆积无用请求：只同步轮廓，松手后出一帧。
    if(gesture&&qwenPref(flow.modelPrefs())){
      livePending=false;
      drawLiveOutline(parts().map(p=>gesture?.part?.id===p.id?gesture.part:p));
      liveState('拖动中只更新轮廓；松手后用 Qwen 出预览（约 15 秒）。');
      return;
    }
    if(!liveBusy){
      // 几何真的变了：作废旧帧与在途结果，按新轮廓排队渲染
      liveFrame=null;$('liveAdopt').disabled=true;
      liveRevision++;
      liveTimer=setTimeout(()=>void renderLiveShape(),Math.max(0,liveDue-performance.now()));
    }
    // 渲染中继续拖动：只记录最新到期时间，不丢弃采样也不作废在途请求——
    // 在途帧完成后照常显示（快速反馈），随后按最新几何补一帧
    drawLiveOutline(parts().map(p=>gesture?.part?.id===p.id?gesture.part:p));
    liveState(liveBusy?'已记录调整，正在更新预览…':'轮廓已更新，等待渲染…');
  }
  // 结构条件渲染：把所有部件的当前轮廓画成一张结构图（灰面 + 深色边），
  // 走 scribble ControlNet 出整图产品效果图。锁定部件因为轮廓就在结构图里，形态不会变。
  function buildStructureBlob(size,items){
    const sheet=document.createElement('canvas');
    sheet.width=size.width;sheet.height=size.height;
    const ctx=sheet.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,sheet.width,sheet.height);
    const draw=(part,fill,alpha)=>{
      const points=model.polygon(part);
      ctx.globalAlpha=alpha;
      ctx.fillStyle=fill;
      ctx.strokeStyle='#1d1d1f';
      // 细长部件的描边按自身尺寸收窄，避免在结构图里被涂成实心黑块（秒针等问题）
      const box=model.outlineBounds(part);
      ctx.lineWidth=Math.min(Math.max(3,size.width/260),Math.max(1.5,Math.min(box.width,box.height)*.4));
      ctx.lineJoin='round';ctx.lineCap='round';
      ctx.beginPath();
      points.forEach((point,index)=>index?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));
      ctx.closePath();
      ctx.fill();ctx.stroke();
      ctx.globalAlpha=1;
    };
    for(const part of items) draw(part,'#fff',1);
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
  // Qwen 分体式模型不能走 SD 实时工作流（CheckpointLoaderSimple 会 400），单独走 Qwen 通道。
  const qwenPref=prefs=>/^qwen[_ ]?image/i.test(String(prefs?.checkpoint||''));
  async function renderStructure(prefs,size,subject){
    // 拖动预览用更小的长边（512）换响应速度，松手后的最终帧回到 768
    const tier=gesture?'speed':$('liveTier').value;
    const long=gesture?512:768;
    const ratio=size.width/size.height;
    const latentWidth=ratio>=1?long:Math.round(long*ratio/8)*8;
    const latentHeight=ratio>=1?Math.round(long/ratio/8)*8:long;
    const structure=await buildStructureBlob(size,parts().map(part=>gesture?.part?.id===part.id?gesture.part:part));
    // Qwen：结构图（白底实体 + 深色边）直接当参考图，造型与比例跟着它走；不接 ControlNet。
    if(qwenPref(prefs)){
      const {blob}=await window.WuyingComfy.renderQwen({
        endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,
        prompt:livePrompt(subject),negative:liveNegative,
        sourceImage:structure,resolution:gesture?512:Number($('liveTier').value==='quality'?640:576),
        seed:liveSeed,slot:'shape-live-'+id.slice(0,8),
        cancelPending:true,signal:liveController.signal,onStatus:()=>{}
      });
      return {blob,controlnet:''};
    }
    const controlnet=await resolveControlnet(prefs);
    const {blob}=await window.WuyingComfy.renderLive({
      endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,controlnet,
      prompt:livePrompt(subject),negative:liveNegative,input:'sketch',quality:'live',
      sourceImage:structure,strength:.9,seed:liveSeed,
      latentWidth,latentHeight,tier,
      slot:'shape-live-'+id.slice(0,8),signal:liveController.signal,onStatus:()=>{}
    });
    return {blob,controlnet};
  }
  async function renderRegion(prefs,target,size,subject){
    const draft=size.draft,base=size.design?.views?.front?.renderBase;
    const sourceBlob=await store.getBlob(base?.blobId||draft.reference?.blobId);
    if(!sourceBlob) throw new Error('找不到局部重绘底图。');
    const before=(base?.parts||draft.parts).find(part=>part.id===target.edit.id)||target.edit;
    const points=part=>partPoints(part,size.width,size.height);
    const prepared=await window.WuyingImageSelection.prepare(sourceBlob,points(target.edit),target.locked.map(points),
      {previous:points(before),longEdge:target.preview?448:640,
        cleanInk:(!base||base.blobId===draft.reference?.blobId)&&size.layers?.some(layer=>layer.kind==='ink'&&layer.strokes?.length)
          &&size.layers.every(layer=>layer.visible===false||layer.kind==='ink')&&
          JSON.stringify(points(before))!==JSON.stringify(points(target.edit)),
        inkStrokes:size.layers?.filter(layer=>layer.visible!==false && layer.opacity!==0 && layer.kind==='ink').flatMap(layer=>layer.strokes||[]),
        neighbors:draft.parts.filter(part=>part.id!==target.edit.id).map(points)});
    const guideBlob=await buildGuideBlob(prepared,target.edit,size);
    const controlnet=await resolveControlnet(prefs);
    const {blob}=await window.WuyingComfy.renderRegion({
      endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,prompt:livePrompt(subject),
      sourceImage:prepared.sourceImage,maskImage:prepared.maskImage,
      guideImage:guideBlob,controlnet,controlStrength:.85,liveTier:target.preview?'speed':'balanced',
      denoise:Number($('liveStrength').value)/100,seed:liveSeed,
      slot:'shape-live-'+id.slice(0,8),signal:liveController.signal,onStatus:()=>{}
    });
    return {blob:await window.WuyingImageSelection.composite(prepared,blob,{feather:8}),controlnet};
  }
  async function renderLiveShape(){
    if(!liveOn) return;
    const ref=asset()?.draft?.reference, prefs=flow.modelPrefs();
    const mode=$('liveMode').value;
    const target=liveParts();
    if(target) target.preview=!!gesture;
    // 结构渲染只需要部件结构，不必选中部件；局部重绘必须有选中的未锁定部件
    if(mode==='region'&&!target){liveState('局部重绘需要先选中一个未锁定的部件。');return;}
    if(mode==='region'&&qwenPref(prefs)){liveState('局部重绘请换 SD1.5 模型；Qwen 用于结构渲染。',true);return;}
    if(!parts().length){liveState('还没有部件：先描轮廓或矢量化底图。',true);return;}
    if(mode==='region'&&!ref){liveState('这份草稿没有底图，先回图像编辑出图，再「拆成部件」。',true);return;}
    if(liveBusy) return;
    const revision=liveRevision;
    livePending=false;
    liveBusy=true;dragRequest=!!gesture;
    const started=performance.now();
    liveState(mode==='region'?'正在局部重绘 '+(target.edit.name)+'…':'正在按结构渲染…');
    liveController=new AbortController();
    try{
      const size=asset();
      const brief=asset()?.flow?.brief||{};
      const subject=[brief.category,brief.text].filter(Boolean).join(', ');
      const {blob,controlnet}=mode==='region'
        ?await renderRegion(prefs,target,size,subject)
        :await renderStructure(prefs,size,subject);
      if(!liveOn||revision!==liveRevision||liveController.signal.aborted) return;
      if(liveUrl) URL.revokeObjectURL(liveUrl);
      liveUrl=URL.createObjectURL(blob);
      $('liveImage').src=liveUrl;$('liveImage').hidden=false;
      // 出图后保留轮廓叠加：这样才能一眼对照「渲染结果 vs 造型」是否一致。
      // 旧逻辑在这里 replaceChildren() 清空，正是「渲染结果里看不到轮廓线」的第二处根因。
      drawLiveOutline(parts().map(part=>gesture?.part?.id===part.id?gesture.part:part));
      if(mode==='region'&&!target.preview&&!gesture&&target.edit.id===selected){
        liveFrame={blob,revision:size.draft.revision,partId:selected};
        $('liveAdopt').disabled=false;
      }
      liveState(mode==='region'
        ?'已按最新轮廓重绘 '+target.edit.name+(controlnet?'（线稿锁形）':'（提示词兜底）')+'，'+(target.preview?'拖动预览':'最终帧')+' '+((performance.now()-started)/1000).toFixed(1)+' 秒。'
        :'已按当前结构渲染'+(controlnet?'（线稿锁形）':'（提示词兜底）')+'，用时 '+((performance.now()-started)/1000).toFixed(1)+' 秒。');
    }catch(error){
      if(!liveOn||revision!==liveRevision||liveController.signal.aborted) return;
      else liveState('渲染失败：'+error.message,true);
    }finally{
      liveBusy=false;dragRequest=false;liveController=undefined;
      if(liveOn&&livePending) liveTimer=setTimeout(()=>void renderLiveShape(),Math.max(0,liveDue-performance.now()));
    }
  }
  function setLiveShape(on){
    liveOn=on;
    $('liveToggle').textContent=on?'关闭实时辅助':'开启实时辅助';
    $('liveToggle').setAttribute('aria-pressed',String(on));
    $('livePane').hidden=!on;
    liveFrame=null;$('liveAdopt').disabled=true;
    if(on){ liveSeed=crypto.getRandomValues(new Uint32Array(1))[0]; scheduleLiveShape(); }
    else{ clearTimeout(liveTimer);livePending=false;resetLiveImage();liveState('等待调整'); }
  }
  $('liveToggle').onclick=()=>{
    const prefs=flow.modelPrefs();
    if(!liveOn&&(!prefs.endpoint||!prefs.checkpoint)){show('请先在本机模型设置里连接 ComfyUI。',true);return;}
    setLiveShape(!liveOn);
  };
  $('liveAdopt').onclick=()=>void task(async()=>{
    const frame=liveFrame;
    if(!frame||gesture||selected!==frame.partId) return;
    const blobId=uid(),childId=uid();
    doc=await store.change(current=>{
      const parent=liveAsset(current,frame.revision),draft=parent.draft,time=Date.now();
      const front=parent.design.views.front;
      const old=front.renderBase||{parts:draft.parts,revision:draft.revision};
      const lineage={...model.snapshot(parent),revision:old.revision,parts:structuredClone(old.parts)};
      const baseParts=old.parts.filter(part=>part.id!==frame.partId);
      const updated=draft.parts.find(part=>part.id===frame.partId);
      if(!updated||updated.locked) throw new Error('目标部件已更改，请重绘。');
      const parts=old.parts.some(p=>p.id===updated.id)?old.parts.map(p=>p.id===updated.id?updated:p):[...baseParts,updated];
      draft.revision=uid();
      front.revision=parent.design.revision=draft.revision;
      if(parent.flow?.stages) stageBook.markStale(parent.flow,'refine');
      front.renderBase={blobId,parts:structuredClone(parts),revision:draft.revision};
      parent.updatedAt=time;
      const child=structuredClone(parent);
      Object.assign(child,{id:childId,name:updated.name+' · 局部重绘',...childPosition(current,parent,0),createdAt:time,adopted:true,
        layers:[{id:uid(),kind:'image',name:'采用的局部重绘',blobId,opacity:1,visible:true}]});
      child.draft.lineage=lineage;
      current.assets[childId]=child;
    },[{id:blobId,blob:frame.blob}]);
    liveFrame=null;$('liveAdopt').disabled=true;
    comparison=doc.assets[childId].draft.lineage;show('已采用局部重绘并保存版本。');
  });
  $('liveRetry').onclick=()=>{ $('liveRetry').hidden=true; scheduleLiveShape(); };
  $('liveStrength').addEventListener('input',()=>{ $('liveStrengthValue').textContent=$('liveStrength').value+'%'; });
  $('liveStrength').addEventListener('change',scheduleLiveShape);
  function updateLiveControls(){
    const region=$('liveMode').value==='region';
    $('liveAdopt').hidden=!region;
    $('liveTier').closest('label').hidden=region;
    $('liveStrength').hidden=!region;$('liveStrengthValue').closest('label').hidden=!region;
    $('liveTier').disabled=region;
    $('liveStrength').disabled=!region;
  }
  updateLiveControls();
  $('liveTier').addEventListener('change',scheduleLiveShape);
  $('liveMode').addEventListener('change',()=>{updateLiveControls();resetLiveImage();scheduleLiveShape();});
  $('partPrompt').addEventListener('input',scheduleLiveShape);

  // ── 阶段轨道：微调完成去产品渲染（三视图在展示区切换）/ 回草图（P0：前进条件 + 冻结快照）──
  const boardQuery='?project='+encodeURIComponent(project?.id||'');
  $('railSketch').href='image-studio.html'+boardQuery+'&asset='+encodeURIComponent(id);
  $('railRender').href='image-studio.html'+boardQuery+'&asset='+encodeURIComponent(id)+'&stage=render';
  const stepHref={sketch:$('railSketch').href,render:$('railRender').href};
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
  for(const [stage,anchor] of [['sketch',$('railSketch')],['render',$('railRender')]]){
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
      // 草图同步：进入微调后上游草图被改过（refine 过期）时，把底图换成最新画面，
      // 并作废基于旧底图的渲染基准；部件保持可编辑，形状对不上的可重新描轮廓。
      if(stageBook.staleOf(asset()?.flow,'refine')){
        const png=await window.WuyingWorkspaceComposite.toPng(asset(),store).catch(()=>null);
        if(png){
          const blobId=uid();
          doc=await store.change(next=>{
            const target=next.assets[id];
            if(!target?.draft) return;
            target.draft.reference={...target.draft.reference,blobId,assetId:id,label:target.name};
            if(target.design?.views?.front) delete target.design.views.front.renderBase;
            target.draft.revision=uid();
            if(target.design?.views?.front) target.design.views.front.revision=target.design.revision=target.draft.revision;
            if(target.flow?.stages){
              stageBook.capture(target.flow,'sketch',{blobId,layersSig:stageBook.layersSig(target.layers)});
              if(target.flow.stages.refine) target.flow.stages.refine.stale=false;
            }
            target.updatedAt=Date.now();
          },[{id:blobId,blob:png}]);
          show('草图已修改：底图已同步为最新画面；部件轮廓仍可编辑，形状对不上的可重新描轮廓或矢量化底图。');
        }else{
          show('上游草图已修改：旧部件草稿基于修改前的画面，建议重新描轮廓或矢量化底图。');
        }
      }
      $('file1Review').hidden=project.id!=='bc1df03d-50be-4cc0-aecf-c40795477a69'||id!=='1b49c604-4c03-4e4b-a306-394511ae9879';
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

