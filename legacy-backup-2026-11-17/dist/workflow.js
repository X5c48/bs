(() => {
  'use strict';

  const workbench=window.WuyingWorkbench;
  if(!workbench)return;
  const {board,graph,live,studio}=workbench;
  const $=id=>document.getElementById(id);
  const shell=document.querySelector('.app-shell');
  const compare=$('flowCompare'), compareRange=$('flowCompareRange'), compareArt=$('flowCompareArt');
  const tiles=$('flowResultTiles'), visual=$('studioVisual'), iterationSource=$('flowIterationSource');
  const stages=[...document.querySelectorAll('[data-flow-step]')];
  const phaseDescriptions={
    derive:'左侧画草图，右侧同步上色。',
    generate:'从草图到效果，查看近期高清结果。',
    iterate:'沿用同一份草图，比较配色和造型。',
    present:'把选中的方案带到展示和导出。'
  };
  let frame=0, comparing=false, compareMarkup='', tileKey='', dragPointer=null, showDraft=false, creatingDraft=false;
  shell.dataset.iteration='color';

  function updateSoon(){
    if(!frame)frame=requestAnimationFrame(sync);
  }

  function canCompare(scene,phase){
    return phase==='generate'&&graph.paired()&&visual.dataset.kind!=='unlinked'&&
      !!(scene?.curve?.nodes?.length||scene?.ink?.length||scene?.underlay||scene?.reference);
  }

  function updateComparison(scene,phase){
    const available=canCompare(scene,phase);
    if(!available)comparing=false;
    $('flowCompareToggle').disabled=!available;
    $('flowCompareToggle').setAttribute('aria-pressed',String(comparing));
    compare.hidden=!comparing;
    if(!comparing)return;
    const photo=visual.querySelector('img');
    const width=photo?.naturalWidth||visual.clientWidth||800;
    const height=photo?.naturalHeight||visual.clientHeight||640;
    const label=window.WuyingStudioCore.sketchViews[scene.view]?.label;
    $('flowCompareSource').textContent=scene.reference?'参考图':label?label+'草图':'当前草图';
    $('flowCompareOutput').textContent=label?label+'效果':'效果预览';
    if(scene.reference){
      if(compareArt.querySelector('img')?.getAttribute('src')!==scene.reference){
        const image=new Image();image.src=scene.reference;image.alt='';image.draggable=false;
        compareArt.replaceChildren(image);
      }
      compareMarkup='';
    }else{
      const stable={...scene,frame:board.captureComposition(scene,{width,height})};
      const markup=window.WuyingNodeGraphCore.lineSvg(stable,window.WuyingSketchRules,window.WuyingStudioCore,'flow-compare',width/height);
      if(compareMarkup!==markup){compareMarkup=markup;compareArt.innerHTML=markup;}
    }
  }

  function resultTile(result,index){
    const button=document.createElement('button');
    button.type='button';
    button.setAttribute('aria-pressed','false');
    if(!result){button.dataset.flowLive='';button.textContent='实时';return button;}
    button.dataset.flowResult=result.id;
    const title='效果 '+String(index+1).padStart(2,'0')+' · '+new Date(result.created).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    button.title=title;
    button.setAttribute('aria-label',title);
    const image=new Image();image.src=result.src;image.alt='';image.draggable=false;
    button.append(image);
    return button;
  }

  function updateResults(phase,status,entries,picked){
    const visible=graph.inBoard()&&graph.paired()&&phase==='generate';
    $('flowResults').hidden=!visible;
    if(!visible)return;
    $('flowResultProgress').hidden=!status?.finalBusy;
    const nextKey=entries.map(entry=>entry.id).join('|');
    if(nextKey!==tileKey){
      tileKey=nextKey;
      tiles.replaceChildren(...(entries.length?[resultTile(),...entries.map(resultTile)]:[]));
    }
    for(const button of tiles.querySelectorAll('button')){
      button.setAttribute('aria-pressed',String(picked?button.dataset.flowResult===picked.id:button.hasAttribute('data-flow-live')));
    }
    const label=live.resultStorage()==='session'?'本次保留':'保存在此浏览器';
    $('flowResultStatus').textContent=status?.finalBusy?'正在生成高清…':entries.length
      ?(picked?'已选 · ':'')+entries.length+' 张 · '+label
      :status?.connected?'生成高清后可在这里挑选':'连接 AI 后可生成';
    $('flowAnother').hidden=!entries.length;
    $('flowAnother').disabled=!status?.connected||!!status.busy;
    $('flowReuse').hidden=!picked;
    $('flowDraftFromResult').hidden=!picked;
    const editLink=$('flowEditResult');
    editLink.hidden=!picked||!workbench.projectId;
    if(!editLink.hidden)editLink.href='image-board.html?project='+encodeURIComponent(workbench.projectId)+'&image='+encodeURIComponent(picked.id);
    $('flowDraftFromResult').disabled=creatingDraft;
    $('flowPresentSelected').hidden=!picked;
  }

  function updateIterationSource(phase,form,picked,entries,status){
    if(phase!=='iterate')showDraft=false;
    const result=picked||entries[0]||status?.result;
    const available=phase==='iterate'&&!form&&graph.paired()&&!!result?.src&&
      graph.linkedDocumentId()===board.sceneState().id;
    const button=$('flowReferenceToggle');
    button.hidden=!available;
    button.textContent=showDraft?'看参考效果':'看草图';
    button.setAttribute('aria-expanded',String(available&&!showDraft));
    iterationSource.hidden=!available||showDraft;
    if(iterationSource.hidden)return;
    if(iterationSource.querySelector('img')?.getAttribute('src')!==result.src){
      iterationSource.querySelector('img')?.remove();
      const image=new Image();image.src=result.src;image.alt='当前方案的渲染参考';image.draggable=false;
      iterationSource.prepend(image);
    }
    $('flowIterationSourceLabel').textContent=picked?'推演参考 · 已选效果图':'推演参考 · 最近效果图';
  }

  function sync(){
    frame=0;
    const phase=shell.dataset.panel;
    const position=stages.findIndex(section=>section.dataset.flowStep===phase);
    for(const [index,section] of stages.entries()){
      section.hidden=index!==position;
      $(section.getAttribute('aria-labelledby')).dataset.before=String(index<position);
    }
    if(graph.inBoard()&&graph.paired()&&phaseDescriptions[phase]){
      $('workbenchDescription').textContent=phaseDescriptions[phase];
    }
    const node=graph.activePreview(), scene=graph.previewScene();
    const status=node&&live.view(node.id);
    const entries=node?live.results(node.id):[];
    const picked=entries.find(entry=>entry.id===studio.selectedResult());
    $('flowNextIterate').firstChild.nodeValue=picked?'推演此图':'比较方案';
    const render=$('flowRender');
    render.querySelector('span').textContent=picked?'下载此图':status?.finalBusy?'高清生成中':
      status?.resultMatches&&status.result?.quality==='final'?'下载高清':'生成高清';
    render.disabled=!picked&&!!status?.finalBusy;
    const form=shell.dataset.iteration==='form';
    const closed=!!scene?.curve?.closed;
    $('flowColorTab').setAttribute('aria-pressed',String(!form));
    $('flowShapeTab').setAttribute('aria-pressed',String(form));
    $('flowIterateHint').textContent=form?(closed?'保留固定轮廓，比较可编辑候选':'选择闭合矢量草稿后可推演'):'同一份草图，比较六组本地配色';
    $('flowUseTone').hidden=form;
    $('flowUseTone').disabled=$('useVariant').disabled;
    $('flowRunShape').hidden=!form;
    $('flowRunShape').disabled=!closed;
    $('flowPlay').disabled=$('playShot').disabled;
    const playing=$('playShot').getAttribute('aria-pressed')==='true';
    $('flowPlay').setAttribute('aria-pressed',String(playing));
    $('flowPlay').textContent=playing?'停止镜头':'播放镜头';
    $('flowExport').disabled=$('exportPoster').disabled;
    updateComparison(scene,phase);
    updateIterationSource(phase,form,picked,entries,status);
    updateResults(phase,status,entries,picked);
  }

  function iteration(mode){
    shell.dataset.iteration=mode;
    window.dispatchEvent(new Event('sketchstatechange'));
  }

  $('flowLayers').onclick=()=>$('toggleLayers').click();
  $('flowNextRender').onclick=()=>workbench.setPanel('generate');
  $('flowNextIterate').onclick=()=>workbench.setPanel('iterate');
  $('flowNewView').onclick=()=>$('addModelNode').click();
  $('flowRender').onclick=()=>{
    const node=graph.activePreview();
    const picked=live.results(node?.id).find(entry=>entry.id===studio.selectedResult());
    if(picked){live.download(node.id,picked.id);return;}
    studio.selectResult(null);
    live.renderFinal();
  };
  $('flowAnother').onclick=()=>{studio.selectResult(null);live.renderFinal({variant:true});};
  $('flowReuse').onclick=()=>{
    live.restoreResult(studio.selectedResult());
    studio.selectResult(null);
    $('renderPrompt').focus();
  };
  $('flowPresentSelected').onclick=()=>workbench.setPanel('present');
  $('flowDraftFromResult').onclick=async()=>{
    if(creatingDraft)return;
    const node=graph.activePreview(), id=studio.selectedResult();
    const result=live.results(node?.id).find(entry=>entry.id===id);
    if(!result)return;
    creatingDraft=true;updateSoon();
    try{
      const current=()=>shell.dataset.panel==='generate'&&graph.activePreview()?.id===node.id&&studio.selectedResult()===id;
      const draft=await board.addResultDraft(result,current);
      if(draft){
        graph.connectSketch(draft.id);
        workbench.setPanel('derive');
        workbench.toast('已另存为底稿，可以在上面继续画。');
        $('freeBoard').focus({preventScroll:true});
      }
    }finally{creatingDraft=false;updateSoon();}
  };
  tiles.onclick=event=>{
    const button=event.target.closest('button');
    if(!button)return;
    studio.selectResult(button.dataset.flowResult||null);
    updateSoon();
  };
  $('flowCompareToggle').onclick=()=>{
    comparing=!comparing;updateSoon();
    if(comparing&&matchMedia('(max-width: 720px)').matches){
      $('studioOutputStage').scrollIntoView({block:'center'});
    }
  };
  function reveal(){
    compare.style.setProperty('--flow-reveal',compareRange.value+'%');
  }
  function moveDivider(event){
    const bounds=compare.getBoundingClientRect();
    compareRange.value=Math.min(100,Math.max(0,Math.round((event.clientX-bounds.left)*100/bounds.width)));
    reveal();
  }
  compareRange.oninput=reveal;
  compareRange.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    comparing=false;
    $('flowCompareToggle').focus();
    updateSoon();
  });
  compare.onpointerdown=event=>{
    if(event.target===compareRange||event.button!==0||dragPointer!==null)return;
    dragPointer=event.pointerId;
    compare.setPointerCapture(event.pointerId);
    moveDivider(event);
  };
  compare.onpointermove=event=>{if(dragPointer===event.pointerId)moveDivider(event);};
  compare.onlostpointercapture=()=>{dragPointer=null;};
  $('flowColorTab').onclick=()=>iteration('color');
  $('flowShapeTab').onclick=()=>iteration('form');
  $('flowUseTone').onclick=studio.presentTone;
  $('flowReferenceToggle').onclick=()=>{showDraft=!showDraft;updateSoon();};
  $('flowRunShape').onclick=()=>{
    const id=graph.linkedDocumentId();
    if(!id)return;
    if(board.sceneState().id!==id)board.openCurve(id);
    board.setTool('select');
    $('generateSketch').click();
  };
  $('flowPlay').onclick=()=>$('playShot').click();
  $('flowExport').onclick=()=>$('exportPoster').click();

  const observer=new MutationObserver(updateSoon);
  observer.observe(visual,{attributes:true,attributeFilter:['data-kind'],childList:true});
  visual.addEventListener('load',updateSoon,true);
  observer.observe($('playShot'),{attributes:true,attributeFilter:['disabled','aria-pressed']});
  for(const id of ['exportPoster','useVariant'])observer.observe($(id),{attributes:true,attributeFilter:['disabled']});
  new ResizeObserver(updateSoon).observe(visual);
  for(const event of ['sketchstatechange','boardscenechange','graphchange','wuyinglivechange','wuyingresultchange'])window.addEventListener(event,updateSoon);
  updateSoon();
})();
