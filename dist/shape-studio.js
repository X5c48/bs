(async () => {
  'use strict';
  if (!await window.WuyingLocalWorkspace.requireProject()) return;
  const $=id=>document.getElementById(id);
  const model=window.WuyingShapeModel, flow=window.WuyingWorkflow;
  const projects=window.WuyingProjects, project=projects.get(projects.idFromLocation());
  const id=new URLSearchParams(location.search).get('asset');
  const canvas=$('shapeCanvas'), svgNS='http://www.w3.org/2000/svg';
  const fields={name:$('partName'),x:$('partX'),y:$('partY'),width:$('partWidth'),height:$('partHeight'),angle:$('partAngle')};
  const query='?project='+encodeURIComponent(project?.id||'');
  const toBoard=assetId=>'workbench.html'+query+'&asset='+encodeURIComponent(assetId);
  const toDraft=assetId=>'shape-studio.html'+query+'&asset='+encodeURIComponent(assetId);
  const toImage=assetId=>'image-studio.html'+query+'&asset='+encodeURIComponent(assetId);
  const store=project?window.WuyingWorkspace.open(project.id):null;
  const urls=new Map();
  const uid=()=>crypto.randomUUID();
  let doc, selected=null, trace=false, gesture, busy=false, controller, comparison;

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
  function drawPolygon(part,{selected=false,changed=false,removed=false}={}){
    const node=svg('polygon');
    node.setAttribute('points',pointString(model.polygon(part)));
    node.setAttribute('class','shape-stroke');
    node.dataset.part=part.id;
    node.dataset.selected=String(selected);
    node.dataset.locked=String(part.locked);
    node.dataset.changed=String(changed);
    node.dataset.removed=String(removed);
    const title=svg('title');title.textContent=part.name;node.append(title);
    return node;
  }
  function cachedUrl(blobId){
    if(!urls.has(blobId)) urls.set(blobId,store.getBlob(blobId).then(blob=>blob?URL.createObjectURL(blob):null).catch(()=>null));
    return urls.get(blobId);
  }

  function renderCanvas(){
    const current=asset();
    measure(canvas,current);
    $('shapeSheet').style.setProperty('--sheet-ratio',current.width+'/'+current.height);
    canvas.replaceChildren(...parts().map(part=>{
      const shown=gesture?.part?.id===part.id?gesture.part:part;
      return drawPolygon(shown,{selected:part.id===selected});
    }));
    if(gesture?.points){
      const line=svg('polyline');line.setAttribute('class','trace-line');line.setAttribute('points',pointString(gesture.points));
      canvas.append(line);
    }
    const ref=current.draft.reference, image=$('shapeReference'), useRef=!!ref&&$('showReference').checked;
    $('referenceToggle').hidden=!ref;
    $('shapeSheet').dataset.reference=String(useRef);
    image.hidden=!useRef;
    if(useRef) void cachedUrl(ref.blobId).then(url=>{if(url&&asset()?.draft.reference?.blobId===ref.blobId)image.src=url;});
    $('shapeSheet').dataset.trace=String(trace);
    $('tracePart').setAttribute('aria-pressed',String(trace));
  }

  function updateButtons(){
    const part=active(), restricted=busy||!part||part.locked;
    $('partFields').disabled=restricted;
    for(const key of ['generateVariants','variantField','variantAmount','partAiRun','partPrompt','removePart']) $(key).disabled=restricted;
    for(const key of ['tracePart','addRectangle','addEllipse','loadExample','toggleLock']) $(key).disabled=busy;
    $('partAiCancel').hidden=!controller;
  }

  function renderControls(){
    const items=parts();
    $('partCount').textContent=items.length+' 个 · '+items.filter(part=>part.locked).length+' 锁定';
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
    $('loadExample').hidden=!!parts().length||!!asset().draft.reference;
    if(part){
      $('toggleLock').textContent=part.locked?'解除锁定':'锁定部件';
      $('toggleLock').setAttribute('aria-pressed',String(part.locked));
      for(const [key,control] of Object.entries(fields)) control.value=part[key];
    }
    $('shapeHint').textContent=trace?'在画布沿部件边缘拖动，松开后闭合轮廓。':
      items.length?'选中部件可拖动位置，也可以输入精确参数。虚线轮廓表示已锁定。':'添加基本形状，或用「描轮廓」沿底图勾画。';
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
        draft.updatedAt=Math.max(Date.now(),(draft.updatedAt||0)+1);
      });
    }catch(error){doc=await store.read();throw error;}
    show(message);
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
    await saveDraft((items,source)=>model.updatePart(items,part.id,{locked:!part.locked},source),
      part.locked?'已解除 '+part.name+' 的锁定。':'已锁定 '+part.name+'。');
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
    return {x:Math.min(asset().width,Math.max(0,point.x)),y:Math.min(asset().height,Math.max(0,point.y))};
  }
  canvas.onpointerdown=event=>{
    if(event.button!==0||busy||gesture) return;
    const start=canvasPoint(event);
    if(trace){
      gesture={id:event.pointerId,points:[start]};
    }else{
      const part=parts().find(item=>item.id===event.target.closest('[data-part]')?.dataset.part);
      if(!part) return;
      selected=part.id;renderControls();
      if(!part.locked) gesture={id:event.pointerId,start,source:part,part};
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
    }else{
      const {source,start}=gesture;
      const patch={x:source.x+point.x-start.x,y:source.y+point.y-start.y};
      try{gesture.part=model.updatePart([source],source.id,patch,asset())[0];}catch{}
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
    }else if(final.part.x!==final.source.x||final.part.y!==final.source.y){
      void task(()=>saveDraft((items,source)=>model.updatePart(items,final.part.id,{x:final.part.x,y:final.part.y},source),'已移动 '+final.part.name+'。'));
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
      $('shapeBack').href=toBoard(id);
      $('shapeImage').href=toImage(id);$('shapeImage').hidden=false;
      $('shapeProject').textContent=project.name;
      $('shapeShell').hidden=false;
      render();
    }catch(error){show(error.message,true);}
  }
  void init();
})();

