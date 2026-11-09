(() => {
  'use strict';

  const workbench=window.WuyingWorkbench, board=workbench?.board;
  const core=window.WuyingStudioCore, rules=window.WuyingSketchRules, graphCore=window.WuyingNodeGraphCore;
  const graph=workbench?.graph;
  if(!board||!core||!rules)return;
  const $=id=>document.getElementById(id);
  const shell=document.querySelector('.app-shell'), visual=$('studioVisual'), gallery=$('studioVariants');
  const inkColors=$('studioInks'), tones=$('studioTones'), renderList=$('studioRenderList');
  const layers=[...document.querySelectorAll('[data-layer]')];
  const toneKeys=Object.keys(core.tones);
  const prefsKey='wuying-studio-material-v1'+(workbench.demo?'-demo':'');
  let tone='silver', light=38, ink='graphite';
  try{
    const prefs=JSON.parse(localStorage.getItem(prefsKey)||'null');
    if(Object.hasOwn(core.tones,prefs?.tone))tone=prefs.tone;
    if(Number.isFinite(prefs?.light))light=Math.max(0,Math.min(100,prefs.light));
  }catch{}
  let frame=0, phase='', documentId, aiId=null, aiViewStamp=null, animation=null;
  let latestResults=[], resultKeys='', lastVariant='', lastVariantUnderlay=null, variantButtons=[], lastVisualMarkup='';
  const opts=(key,id,ratio)=>({tone:key,light,id,ratio});

  function persistMaterial(){
    try{localStorage.setItem(prefsKey,JSON.stringify({tone,light}));}catch{}
  }

  function swatch(group, key, value, kind){
    const button=document.createElement('button');
    button.type='button';
    button.dataset[kind]=key;
    button.title=value.label;
    button.setAttribute('aria-label',value.label);
    button.setAttribute('aria-pressed','false');
    const color=document.createElement('b');
    color.style.backgroundColor=value.chip||value.color;
    button.append(color);
    if(kind==='tone'){
      const label=document.createElement('span');label.textContent=value.label;button.append(label);
    }
    group.append(button);
  }
  Object.entries(core.inks).forEach(([key,value])=>swatch(inkColors,key,value,'ink'));
  Object.entries(core.tones).forEach(([key,value])=>swatch(tones,key,value,'tone'));

  function setPressed(container,key,kind){
    for(const button of container.querySelectorAll('button')){
      button.setAttribute('aria-pressed',String(button.dataset[kind]===key));
    }
  }

  function requestRender(){
    if(!frame)frame=requestAnimationFrame(sync);
  }

  function selectTone(next){
    if(!Object.hasOwn(core.tones,next))return;
    tone=next;aiId=null;
    setPressed(tones,tone,'tone');setPressed(gallery,tone,'materialVariant');
    persistMaterial();
    requestRender();
  }

  function image(src,alt){
    const result=new Image();
    result.src=src;result.alt=alt;result.draggable=false;
    return result;
  }

  function setVisual(scene,result,hasContent,mode,connected){
    const kind=result?'ai':scene.reference?'reference':hasContent?'live':connected?'empty':'unlinked';
    if(kind!=='live')lastVisualMarkup='';
    if(kind==='ai'||kind==='reference'){
      const src=result?.src||scene.reference;
      if(visual.dataset.kind!==kind||visual.querySelector('img')?.getAttribute('src')!==src){
        visual.replaceChildren(image(src,result?'ComfyUI 生成效果图':'参考图片'));
      }
    }else if(kind==='live'){
      const markup=mode==='line'?graphCore.lineSvg(scene,rules,core,'studio-main'):
        core.renderSvg(scene,rules,{...opts(tone,'studio-main',1.38),style:mode==='material'?'material':'ps'});
      if(lastVisualMarkup!==markup){lastVisualMarkup=markup;visual.innerHTML=markup;}
    }else if(visual.dataset.kind!==kind){
      const note=document.createElement('div');note.className='studio-empty';
      const title=document.createElement('strong');title.textContent=connected?'等待草图内容':'等待草图输入';
      const help=document.createElement('span');help.textContent=connected?'在相连的节点中画几笔，或导入线稿。':'将草图输出口接到此节点的输入口。';
      note.append(title,help);visual.replaceChildren(note);
    }
    visual.dataset.kind=kind;
  }

  function buildVariants(scene,hasForm){
    if(!hasForm){
      if(lastVariant!=='empty'){
        const note=document.createElement('p');note.className='studio-variant-empty';
        note.textContent='选一份闭合草稿，或用画笔画出一圈轮廓，即可比较配色。';
        gallery.replaceChildren(note);variantButtons=[];lastVariant='empty';
      }
      return;
    }
    const key=JSON.stringify([scene.curve,scene.ink,scene.frame,scene.profile,light]);
    if(lastVariant!==key||lastVariantUnderlay!==scene.underlay){
      if(!variantButtons.length){
        gallery.replaceChildren();
        variantButtons=toneKeys.map((material,index)=>{
          const button=document.createElement('button');
          button.type='button';button.dataset.materialVariant=material;
          const art=document.createElement('span');art.className='variant-visual';
          const caption=document.createElement('span');caption.className='variant-caption';
          const number=document.createElement('small');number.textContent=String(index+1).padStart(2,'0');
          caption.append(number,document.createTextNode(core.tones[material].label));
          button.append(art,caption);gallery.append(button);return button;
        });
      }
      for(const [index,button] of variantButtons.entries()){
        button.firstElementChild.innerHTML=core.renderSvg(scene,rules,opts(toneKeys[index],'studio-v'+index,1.60));
      }
      lastVariant=key;lastVariantUnderlay=scene.underlay;
    }
    setPressed(gallery,tone,'materialVariant');
  }

  function stopMotion(){
    const running=animation;
    animation=null;
    running?.cancel();
    $('playShot').setAttribute('aria-pressed','false');
    $('playShot').textContent='播放镜头预览';
  }

  function sync(){
    frame=0;
    const editing=board.sceneState(), next=shell.dataset.panel;
    const useGraph=graph?.inBoard(), node=useGraph?graph.activePreview():null;
    const source=useGraph?graph.previewScene():editing;
    const scene=source||{id:null,ink:[],title:'未连接'};
    const mode=node?.mode||'ps';
    const forms=mode==='shape'?graph?.previewForms(scene)||[]:[];
    const output=forms[node?.variant]?.scene||forms[0]?.scene||scene;
    if(next!==phase||scene.id!==documentId){
      stopMotion();
      if(scene.id!==documentId)aiId=null;
      phase=next;documentId=scene.id;
    }
    if(!scene.curve&&scene.ink.length)scene.form=core.inkOutline(scene.ink,rules);
    const hasForm=!!(scene.curve?.closed||scene.form||scene.underlay?.mask);
    const hasContent=!!(scene.curve||scene.ink.length||scene.reference||scene.underlay);
    const editContent=!!(editing.curve||editing.ink.length||editing.reference||editing.underlay);
    const inGallery=phase==='iterate'&&(mode==='ps'||mode==='material')&&!!source;
    latestResults=source?board.resultsFor(scene.id):[];
    const stamp=aiId?board.controlSource(scene.id).stamp:null;
    if(aiId&&(scene.drawing||stamp!==aiViewStamp))aiId=null;
    const result=latestResults.find(item=>item.id===aiId);
    const showingAI=!!result&&!inGallery&&(mode==='ps'||mode==='material');
    graph?.setAppearance({tone,light});

    $('studioDocument').textContent=editing.title;
    $('stage').dataset.blank=String(!editContent);
    $('inkCount').textContent=editing.ink.length+' 笔';
    $('undoInk').disabled=!editing.canUndo;
    $('redoInk').disabled=!editing.canRedo;
    for(const button of layers){
      const layer=button.dataset.layer;
      const visible=layer==='underlay'?editing.showUnderlay:layer==='ink'?editing.showInk:editing.showContour;
      const available=layer!=='underlay'||editing.hasUnderlay;
      button.disabled=!available;
      button.setAttribute('aria-pressed',String(available&&visible));
      button.querySelector('b').textContent=available?(visible?'可见':'隐藏'):'未导入';
    }
    $('studioOutputTitle').textContent=inGallery?'配色方案':phase==='present'?'展示画面':showingAI?'AI 效果图':'实时预览';
    $('studioOutputHint').textContent=inGallery?'保留当前造型，比较不同配色':phase==='present'?'当前效果 · 可导出 PNG':
      showingAI?(result.sourceStamp===stamp?'由当前草稿生成':'此草稿上次生成的效果'):
      hasForm?'跟随已连接的草图':hasContent?'笔迹实时同步':'等待草图输入';
    $('studioLiveTag').hidden=inGallery||phase==='present'||showingAI;
    $('studioToneName').textContent=showingAI?'ComfyUI · '+result.title:inGallery?'当前选择 · '+core.tones[tone].label:
      !source?'未连接':mode==='shape'?(forms[node?.variant]?.label||forms[0]?.label||'等待闭合轮廓'):
      mode==='line'?'原始线稿':graphCore.MODES[mode]+' · '+core.tones[tone].label;
    $('toggleAIView').hidden=inGallery||!latestResults.length||mode==='line'||mode==='shape';
    $('toggleAIView').textContent=showingAI?'回到实时预览':'查看 AI 效果图';
    const keys=latestResults.map(item=>item.id).join('|');
    if(keys!==resultKeys){
      renderList.replaceChildren(...latestResults.map((item,index)=>new Option('效果 '+String(latestResults.length-index).padStart(2,'0'),item.id)));
      resultKeys=keys;
    }
    renderList.hidden=!showingAI||latestResults.length<2;
    if(showingAI)renderList.value=aiId;
    $('chosenTone').textContent=core.tones[tone].label;
    $('chosenToneChip').style.backgroundColor=core.tones[tone].chip;
    $('useVariant').disabled=!hasForm;
    $('startShapeVariant').disabled=!scene.curve?.closed;
    $('playShot').disabled=!hasContent;
    $('exportPoster').disabled=!hasContent;
    $('studioLightValue').textContent=light+'%';
    $('studioLight').value=light;
    setPressed(tones,tone,'tone');

    visual.hidden=inGallery;gallery.hidden=!inGallery;
    if(inGallery)buildVariants(scene,hasForm);
    else setVisual(output,showingAI?result:null,hasContent,mode,!!source);
  }

  inkColors.addEventListener('click',event=>{
    const button=event.target.closest('[data-ink]');
    if(!button)return;
    ink=button.dataset.ink;setPressed(inkColors,ink,'ink');
    board.setBrush({color:ink});
    board.setTool('brush');
  });
  $('brushSize').addEventListener('input',event=>{
    const size=Number(event.target.value);
    $('brushSizeValue').textContent=size+' px';
    board.setBrush({size});
  });
  $('brushOpacity').addEventListener('input',event=>{
    const opacity=Number(event.target.value);
    $('brushOpacityValue').textContent=opacity+'%';
    board.setBrush({opacity:opacity/100});
  });
  $('undoInk').onclick=()=>board.stepInk();
  $('redoInk').onclick=()=>board.stepInk(false);
  for(const button of layers)button.addEventListener('click',()=>{
    board.setLayer(button.dataset.layer,button.getAttribute('aria-pressed')!=='true');
  });

  tones.addEventListener('click',event=>{
    const button=event.target.closest('[data-tone]');
    if(button)selectTone(button.dataset.tone);
  });
  gallery.addEventListener('click',event=>{
    const button=event.target.closest('[data-material-variant]');
    if(button)selectTone(button.dataset.materialVariant);
  });
  $('studioLight').addEventListener('input',event=>{
    light=Number(event.target.value);aiId=null;
    persistMaterial();requestRender();
  });
  $('toggleAIView').onclick=()=>{
    aiId=aiId?null:latestResults[0]?.id;
    aiViewStamp=board.controlSource(graph?.linkedDocumentId()??undefined).stamp;
    requestRender();
  };
  renderList.addEventListener('change',()=>{
    aiId=renderList.value;aiViewStamp=board.controlSource(graph?.linkedDocumentId()??undefined).stamp;requestRender();
  });
  $('useVariant').onclick=()=>workbench.setPanel('present');
  $('startShapeVariant').onclick=()=>{
    const id=graph?.linkedDocumentId();
    workbench.setPanel('derive');
    if(id&&id!==board.sceneState().id)board.openCurve(id);
    board.setTool('select');
    $('vectorTools').open=true;
    $('vectorTools').scrollIntoView({block:'nearest'});
  };

  $('playShot').onclick=()=>{
    if(animation){stopMotion();return;}
    const art=visual.firstElementChild;
    if(!art)return;
    const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
    animation=art.animate(reduce?[{opacity:.55},{opacity:1}]:[
      {transform:'translate(-.9%, .4%) scale(1.005)'},
      {transform:'translate(1.1%, -.4%) scale(1.105)'}
    ],{duration:reduce?700:3200,easing:'cubic-bezier(.2,.7,.3,1)'});
    animation.onfinish=stopMotion;
    $('playShot').setAttribute('aria-pressed','true');
    $('playShot').textContent='停止镜头预览';
  };

  async function poster(){
    const svg=visual.querySelector('svg'), photo=visual.querySelector('img');
    if(!svg&&!photo)throw new Error('请先选择一份有内容的草稿。');
    const url=svg?URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'})):null;
    try{
      const art=url?image(url,''):photo;
      await art.decode();
      const canvas=document.createElement('canvas');
      canvas.width=1600;canvas.height=Math.max(1,Math.round(1600*art.naturalHeight/art.naturalWidth));
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#f3f0e8';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(art,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片导出失败。')),'image/png'));
    }finally{if(url)URL.revokeObjectURL(url);}
  }
  $('exportPoster').onclick=async()=>{
    const button=$('exportPoster'),status=$('posterStatus');
    button.disabled=true;status.textContent='正在准备展示图…';
    try{
      const blob=await poster();
      workbench.download(blob,'物映-展示图.png');
      status.textContent='展示图已导出。';
    }catch(error){status.textContent=error.message;}
    finally{requestRender();}
  };

  window.addEventListener('studiorender',event=>{
    const {id,source}=event.detail;
    const active=board.controlSource(graph?.linkedDocumentId()??undefined);
    if(active.id===source.id&&active.stamp===source.stamp){aiId=id;aiViewStamp=active.stamp;}
    requestRender();
  });
  window.addEventListener('graphchange',requestRender);
  window.addEventListener('boardscenechange',requestRender);
  window.addEventListener('sketchstatechange',requestRender);
  setPressed(inkColors,ink,'ink');
  sync();
})();
