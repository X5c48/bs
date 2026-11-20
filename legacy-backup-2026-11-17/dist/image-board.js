(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const projects = window.WuyingProjects;
  const id = projects.idFromLocation();
  const project = projects.get(id);
  if (!project) {
    location.replace('projects.html');
    return;
  }

  const suffix = projects.suffix(id);
  const query = '?project=' + encodeURIComponent(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const selection = window.WuyingImageSelection;
  const comfy = window.WuyingComfy;
  const view = $('boardView'), world = $('boardWorld'), extent = $('boardExtent');
  const container = $('boardCards'), wires = $('boardWires'), dialog = $('editDialog');
  const drawing = $('maskDrawing'), image = $('maskImage'), endpoint = $('regionEndpoint'), checkpoint = $('regionCheckpoint');
  const locationKey = 'wuying-image-board-v1' + suffix;
  const modelKey = 'wuying-region-model-v1';
  const cards = new Map(), persisted = new Map(), objectURLs = new Map(), cardElements = new Map();
  const params = new URLSearchParams(location.search);
  const requested = params.get('image');
  let active = null, drag = null, pan = null, zoom = 1, size = [0,0], positions = {};
  let editing = null, points = [], gesture = null, tool = 'lasso', running = null, connecting = null;
  let configured, connectedAddress = '', preferredCheckpoint = '';
  const strideX = 278, strideY = 225, origin = 34;
  const typeLabel = { sketch:'草图', render:'渲染结果', image:'导入图片', region:'局部修改' };

  function readPrefs(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch { return {}; }
  }

  function writePrefs(key,value) {
    try { localStorage.setItem(key,JSON.stringify(value)); }
    catch { /* Canvas positions and model preferences are optional. */ }
  }

  const deskPrefs = readPrefs(locationKey);
  if (deskPrefs.positions && typeof deskPrefs.positions === 'object') positions = deskPrefs.positions;
  let wanted = requested || deskPrefs.active;
  const modelPrefs = readPrefs(modelKey);
  try { configured = localStorage.getItem('wuying.comfyEndpoint'); } catch {}
  endpoint.value = modelPrefs.endpoint || configured || 'http://127.0.0.1:8189';
  preferredCheckpoint = modelPrefs.checkpoint || readPrefs('wuying.liveModels').checkpoint;

  const editorURL = draftId => 'index.html' + query + (draftId ? '&draft=' + encodeURIComponent(draftId) : '');
  $('boardBrief').href = 'concept.html' + query;
  $('boardBrief').textContent = project.name;
  $('boardBrief').title = '打开设计简报';
  $('boardHome').href = 'image-board.html' + query;
  $('boardEditor').href = $('emptySketch').href = editorURL(project.activeDraftId);
  if (matchMedia('(max-width: 740px)').matches) zoom = .72;
  document.title = project.name + ' · 方案画布 · 物映';

  function status(node,message,error=false) {
    node.textContent = message;
    node.dataset.error = String(error);
  }

  function urlFor(card) {
    if (card.kind === 'sketch') return card.src;
    if (!objectURLs.has(card.id)) objectURLs.set(card.id,URL.createObjectURL(card.blob));
    return objectURLs.get(card.id);
  }

  function saveDesk() { writePrefs(locationKey,{active,positions}); }

  function placeCards() {
    const occupied = [];
    const valid = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
    for (const card of cards.values()) {
      if (valid(positions[card.id])) occupied.push(positions[card.id]);
    }
    for (const card of cards.values()) {
      if (valid(positions[card.id])) continue;
      const parent = positions[card.parentId];
      const x = valid(parent) ? parent.x+strideX : card.kind === 'sketch' ? origin : origin+strideX;
      let y = valid(parent) ? parent.y : 64;
      while (occupied.some(point => Math.abs(point.x-x)<243 && Math.abs(point.y-y)<205)) y+=strideY;
      positions[card.id] = {x,y};
      occupied.push(positions[card.id]);
    }
  }

  function updateLayout() {
    let width = 300,height = 260;
    const paths = [];
    for (const card of cards.values()) {
      const {x,y} = positions[card.id];
      const element = cardElements.get(card.id);
      element.style.left = x+'px';
      element.style.top = y+'px';
      width = Math.max(width,x+264);
      height = Math.max(height,y+230);
      const parent = cards.get(card.parentId);
      if (!parent) continue;
      const from = positions[parent.id];
      const fromX = from.x+224, fromY = from.y+98, toY = y+98;
      const bend = Math.max(28,Math.abs(x-fromX)*.45);
      const path = document.createElementNS(svgNS,'path');
      path.setAttribute('d','M'+fromX+' '+fromY+' C'+(fromX+bend)+' '+fromY+' '+(x-bend)+' '+toY+' '+x+' '+toY);
      paths.push(path);
    }
    wires.replaceChildren(...paths);
    size = [width,height];
    world.style.width = width+'px';
    world.style.height = height+'px';
    applyZoom();
  }

  function applyZoom() {
    world.style.transform = 'scale('+zoom+')';
    extent.style.width = size[0]*zoom+'px';
    extent.style.height = size[1]*zoom+'px';
    $('boardFit').textContent = Math.round(zoom*100)+'%';
  }

  function setZoom(next) {
    const old = zoom;
    zoom = Math.min(1.45,Math.max(.2,next));
    applyZoom();
    view.scrollLeft *= zoom/old;
    view.scrollTop *= zoom/old;
  }
  $('boardZoomOut').onclick = () => setZoom(zoom-.1);
  $('boardZoomIn').onclick = () => setZoom(zoom+.1);
  $('boardFit').onclick = () => {
    setZoom(Math.min(1,view.clientWidth/size[0],view.clientHeight/size[1]));
    view.scrollTo(0,0);
  };
  view.addEventListener('pointerdown',event => {
    if (event.pointerType!=='mouse' || event.button!==0 || event.target.closest('.card, a, button')) return;
    if (view.scrollWidth<=view.clientWidth && view.scrollHeight<=view.clientHeight) return;
    pan = {id:event.pointerId,x:event.clientX+view.scrollLeft,y:event.clientY+view.scrollTop};
    view.setPointerCapture(event.pointerId);
    view.dataset.panning = 'true';
  });
  view.addEventListener('pointermove',event => {
    if (pan?.id===event.pointerId) view.scrollTo(pan.x-event.clientX,pan.y-event.clientY);
  });
  view.addEventListener('lostpointercapture',event => {
    if (pan?.id!==event.pointerId) return;
    pan = null;
    delete view.dataset.panning;
  });

  function highlight(id, reveal=false) {
    const card = cards.get(id);
    active = card?.id || null;
    for (const [key,element] of cardElements) {
      const selected = key===active;
      element.dataset.active = String(selected);
      element.querySelector('button').setAttribute('aria-pressed',String(selected));
    }
    $('inspectorEmpty').hidden = !!card;
    $('inspectorContent').hidden = !card;
    $('selectedType').textContent = card ? typeLabel[card.kind] : '';
    if (!card) return;
    const src = urlFor(card);
    const parent = cards.get(card.parentId);
    const isSketch = card.kind==='sketch';
    $('selectedThumb').hidden = !src;
    if (src) $('selectedThumb').src = src;
    $('selectedName').textContent = card.label;
    const oldDraft = parent?.kind==='sketch' && card.sourceStamp && card.sourceStamp!==parent.stamp;
    $('selectedOperation').textContent = card.edit?.prompt || (parent ? '来自 '+parent.label+(oldDraft?' · 对应旧稿':'') : '');
    $('selectedLineage').hidden = !parent;
    $('compareSource').hidden = !parent || parent.kind==='sketch' && !parent.src;
    $('goSource').textContent = parent?.kind==='sketch'?'选中源草稿':'选中源图';
    $('editSelected').hidden = isSketch;
    $('openSketch').hidden = !isSketch;
    $('openSketch').href = editorURL(card.id);
    $('downloadSelected').hidden = isSketch;
    if (!isSketch) {
      $('downloadSelected').href = src;
      const extension = card.blob.type==='image/jpeg'?'.jpg':card.blob.type==='image/webp'?'.webp':'.png';
      $('downloadSelected').download = card.label+extension;
    }
    if (reveal) {
      const {x,y} = positions[id];
      const left = Math.max(0,x*zoom-22);
      const top = Math.max(0,y*zoom-22);
      if (left < view.scrollLeft || left+248*zoom > view.scrollLeft+view.clientWidth) view.scrollLeft = left;
      if (top < view.scrollTop || top+218*zoom > view.scrollTop+view.clientHeight) view.scrollTop = top;
    }
    saveDesk();
  }

  function makeCard(card) {
    const article = document.createElement('article');
    article.className = 'card';
    article.dataset.card = card.id;
    article.dataset.kind = card.kind;
    const handle = document.createElement('div');
    handle.className = 'card-handle';
    const title = document.createElement('strong');
    title.textContent = card.label;
    const type = document.createElement('span');
    type.textContent = typeLabel[card.kind];
    handle.append(title,type);
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('aria-label',card.label);
    open.setAttribute('aria-pressed','false');
    const src = urlFor(card);
    if (src) {
      const thumb = new Image();
      thumb.src = src;
      thumb.alt = '';
      thumb.draggable = false;
      open.append(thumb);
    } else open.textContent = '空白草稿';
    const originLabel = document.createElement('span');
    originLabel.className = 'card-origin';
    const parent = cards.get(card.parentId);
    originLabel.textContent = parent ? '来自 '+parent.label : card.kind==='region'?'源图暂不可用':typeLabel[card.kind];
    handle.onpointerdown = event => {
      if (event.button!==0 || drag) return;
      highlight(card.id);
      handle.setPointerCapture(event.pointerId);
      const {x,y} = positions[card.id];
      drag = {id:event.pointerId,key:card.id,x,y,clientX:event.clientX,clientY:event.clientY};
    };
    handle.onpointermove = event => {
      if (drag?.id!==event.pointerId || drag.key!==card.id) return;
      positions[card.id] = {
        x:Math.max(12,drag.x+(event.clientX-drag.clientX)/zoom),
        y:Math.max(12,drag.y+(event.clientY-drag.clientY)/zoom)
      };
      updateLayout();
    };
    handle.onlostpointercapture = () => {
      if (drag?.key!==card.id) return;
      drag = null;
      saveDesk();
    };
    open.onclick = () => highlight(card.id);
    open.ondblclick = () => {
      if (card.kind==='sketch') location.assign(editorURL(card.id));
      else openEdit(card);
    };
    article.append(handle,open,originLabel);
    return article;
  }

  function renderCards() {
    placeCards();
    cardElements.clear();
    for (const card of cards.values()) cardElements.set(card.id,makeCard(card));
    container.replaceChildren(...cardElements.values());
    $('boardEmpty').hidden = cards.size>0;
    $('boardCount').textContent = cards.size ? cards.size+' 张稿件' : '';
    updateLayout();
    const requestedCard = cards.has(wanted) ? wanted : cards.has(active) ? active : null;
    if (requestedCard===wanted) wanted = null;
    highlight(requestedCard,!!requestedCard);
  }

  function combineCards() {
    cards.clear();
    for (const scene of window.WuyingBoard.listSavedScenes(suffix)) {
      const content = scene.curve || scene.ink.length || scene.underlay;
      const svg = content && window.WuyingNodeGraphCore.lineSvg(scene,window.WuyingSketchRules,window.WuyingStudioCore,'board-'+scene.id,1.38);
      cards.set(scene.id,{id:scene.id,label:scene.title,kind:'sketch',stamp:window.WuyingBoard.sceneStamp(scene),
        src:svg?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg):null});
    }
    const items = historyStore.list().slice().reverse();
    for (const [index,item] of items.entries()) {
      cards.set(item.id,{id:item.id,kind:'render',label:'渲染 '+String(index+1).padStart(2,'0'),
        parentId:item.draftId,sourceStamp:item.sourceStamp,blob:item.blob,created:item.created});
    }
    for (const item of [...persisted.values()].sort((a,b)=>a.created-b.created)) cards.set(item.id,item);
    renderCards();
  }

  const historyStore = window.WuyingFlowResults.create('wuying-render-results-v1'+suffix,combineCards);
  combineCards();
  projects.listImageCards(id).then(items => {
    for (const item of items) persisted.set(item.id,item);
    combineCards();
  }).catch(error => status($('boardStatus'),error.message,true));

  $('boardImport').onclick = () => $('boardFile').click();
  $('boardFile').onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 20*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type)) {
      status($('boardStatus'),'请选择 20 MB 以内的 PNG、JPG 或 WebP。',true);
      return;
    }
    $('boardImport').disabled = true;
    try {
      const bitmap = await selection.decode(file);
      bitmap.close();
      const card = {id:crypto.randomUUID(),label:file.name.replace(/\.[^.]+$/,'').slice(0,54)||'导入效果图',kind:'image',blob:file,created:Date.now()};
      await projects.saveImageCard(id,card);
      persisted.set(card.id,card);
      wanted = card.id;
      combineCards();
      status($('boardStatus'),'图片已加入画布。');
      try {projects.update(id,{desk:'editor'});} catch { /* The image has already been stored. */ }
    } catch (error) {status($('boardStatus'),error.message,true);}
    finally {$('boardImport').disabled = false;}
  };
  $('goSource').onclick = () => highlight(cards.get(active)?.parentId,true);
  $('compareSource').onclick = () => {
    const card = cards.get(active), parent = cards.get(card?.parentId);
    if (!parent) return;
    $('compareBefore').src = urlFor(parent);
    $('compareAfter').src = urlFor(card);
    $('compareBeforeTitle').textContent = '源图 · '+parent.label;
    $('compareAfterTitle').textContent = '当前版本 · '+card.label;
    $('compareDialog').showModal();
  };
  $('closeCompare').onclick = () => $('compareDialog').close();
  $('editSelected').onclick = () => openEdit(cards.get(active));

  function fitImage() {
    const stage = $('editStage');
    if (!image.naturalWidth || !stage.clientWidth || !stage.clientHeight) return;
    const ratio = Math.min(stage.clientWidth/image.naturalWidth,stage.clientHeight/image.naturalHeight);
    $('maskFrame').style.width = Math.floor(image.naturalWidth*ratio)+'px';
    $('maskFrame').style.height = Math.floor(image.naturalHeight*ratio)+'px';
  }
  new ResizeObserver(fitImage).observe($('editStage'));
  image.onload = fitImage;

  function syncForm() {
    const ready = connectedAddress && connectedAddress===endpoint.value.trim() && checkpoint.value;
    $('runRegion').disabled = !!running || !ready || !selection.enough(points) || !$('regionPrompt').value.trim();
    $('stopRegion').hidden = !running;
    $('closeEdit').disabled = !!running;
    $('clearMask').disabled = !!running || !points.length;
    $('regionPrompt').disabled = $('regionStrength').disabled = !!running;
    checkpoint.disabled = !!running || !connectedAddress;
    endpoint.disabled = !!running;
    $('connectRegion').disabled = !!running || !!connecting;
    for (const button of document.querySelectorAll('[data-selection-tool]')) button.disabled = !!running;
  }

  function openEdit(card) {
    if (!card || card.kind==='sketch' || running) return;
    editing = card;
    $('editSource').textContent = '当前源图 · '+card.label;
    image.src = urlFor(card);
    $('regionPrompt').value = '';
    $('regionStrength').value = '72';
    $('strengthValue').textContent = '72%';
    points = [];
    drawMask();
    status($('editStatus'),'');
    dialog.showModal();
    fitImage();
    if (!connectedAddress) {
      $('regionModelSettings').open = true;
      if (!connecting) connectModel();
    } else $('regionModelSettings').open = false;
  }

  function pointOf(event) {
    const rect = drawing.getBoundingClientRect();
    const limit = value => Math.max(0,Math.min(1,value));
    return {x:limit((event.clientX-rect.left)/rect.width),y:limit((event.clientY-rect.top)/rect.height)};
  }

  function drawMask() {
    const d = points.length ? 'M'+points.map(point => (point.x*1000).toFixed(2)+' '+(point.y*1000).toFixed(2)).join(' L')+' Z' : '';
    $('maskOutline').setAttribute('d',d);
    $('maskStatus').textContent = selection.enough(points)?'已圈选。仅处理蓝色区域。':'拖动圈出要改的位置';
    syncForm();
  }

  function updateGesture(event) {
    const point = pointOf(event), start = gesture.start;
    if (tool==='rectangle') {
      points = [start,{x:point.x,y:start.y},point,{x:start.x,y:point.y}];
    } else if (points.length<900) {
      const previous = points.at(-1);
      if (Math.hypot(point.x-previous.x,point.y-previous.y)>.002) points.push(point);
    }
    drawMask();
  }

  drawing.onpointerdown = event => {
    if (event.button!==0 || running || gesture || !image.naturalWidth) return;
    const start = pointOf(event);
    gesture = {id:event.pointerId,start};
    points = [start];
    drawing.setPointerCapture(event.pointerId);
    drawMask();
  };
  drawing.onpointermove = event => { if (gesture?.id===event.pointerId) updateGesture(event); };
  drawing.onpointerup = event => { if (gesture?.id===event.pointerId) updateGesture(event); };
  drawing.onlostpointercapture = () => {
    gesture = null;
    if (!selection.enough(points)) points = [];
    drawMask();
  };
  for (const button of document.querySelectorAll('[data-selection-tool]')) button.onclick = () => {
    tool = button.dataset.selectionTool;
    for (const other of document.querySelectorAll('[data-selection-tool]')) other.setAttribute('aria-pressed',String(other===button));
  };
  $('clearMask').onclick = () => { points=[]; drawMask(); };
  $('regionPrompt').oninput = syncForm;
  $('regionStrength').oninput = () => { $('strengthValue').textContent=$('regionStrength').value+'%'; };
  $('closeEdit').onclick = () => dialog.close();
  dialog.addEventListener('cancel',event => { if (running) event.preventDefault(); });
  $('stopRegion').onclick = () => running?.abort();

  function resetModel() {
    connectedAddress = '';
    checkpoint.replaceChildren(new Option('先连接 ComfyUI',''));
    $('regionConnection').textContent = '未连接';
  }

  function saveModel() {
    preferredCheckpoint = checkpoint.value;
    writePrefs(modelKey,{endpoint:connectedAddress,checkpoint:preferredCheckpoint});
  }

  async function connectModel() {
    if (connecting || running) return;
    const controller = new AbortController();
    const address = endpoint.value.trim();
    connecting = controller;
    resetModel();
    status($('editStatus'),'正在读取本机模型…');
    syncForm();
    try {
      const models = await comfy.testConnection(address,{signal:controller.signal});
      if (address!==endpoint.value.trim()) return;
      if (!models.checkpoints.length) throw new Error('ComfyUI 没有可用的基础模型。');
      checkpoint.replaceChildren(...models.checkpoints.map(name => new Option(name,name)));
      checkpoint.value = models.checkpoints.includes(preferredCheckpoint) ? preferredCheckpoint
        : models.checkpoints.find(name => /cyberrealistic/i.test(name)) || models.checkpoints[0];
      connectedAddress = address;
      $('regionConnection').textContent = '已连接';
      $('regionModelSettings').open = false;
      saveModel();
      status($('editStatus'),'');
    } catch (error) {
      if (!controller.signal.aborted) status($('editStatus'),error.message,true);
    } finally {connecting=null; syncForm();}
  }

  endpoint.oninput = () => { connecting?.abort(); resetModel(); syncForm(); };
  checkpoint.onchange = () => { saveModel(); syncForm(); };
  $('connectRegion').onclick = connectModel;

  $('regionForm').onsubmit = async event => {
    event.preventDefault();
    if (running || $('runRegion').disabled || !editing) return;
    const source = editing, chosen = points.map(p => ({...p}));
    const prompt = $('regionPrompt').value.trim();
    const denoise = Number($('regionStrength').value)/100;
    const model = checkpoint.value, address = connectedAddress;
    const controller = new AbortController();
    running = controller;
    syncForm();
    try {
      status($('editStatus'),'正在准备源图和选区…');
      const prepared = await selection.prepare(source.blob,chosen);
      controller.signal.throwIfAborted();
      const result = await comfy.renderRegion({
        endpoint:address,checkpoint:model,prompt,denoise,sourceImage:prepared.sourceImage,
        maskImage:prepared.maskImage,slot:'region-'+crypto.randomUUID(),signal:controller.signal,
        onStatus:message => status($('editStatus'),message)
      });
      status($('editStatus'),'正在把选区结果合回源图…');
      const blob = await selection.composite(prepared,result.blob);
      controller.signal.throwIfAborted();
      if (!persisted.has(source.id)) {
        await projects.saveImageCard(id,source);
        persisted.set(source.id,source);
      }
      controller.signal.throwIfAborted();
      const editCount = [...persisted.values()].filter(card => card.kind==='region').length+1;
      const card = {id:crypto.randomUUID(),kind:'region',label:'局部修改 '+String(editCount).padStart(2,'0'),
        parentId:source.id,blob,created:Date.now(),edit:{prompt,denoise,points:chosen,model,promptId:result.promptId}};
      await projects.saveImageCard(id,card);
      persisted.set(card.id,card);
      wanted = card.id;
      dialog.close();
      combineCards();
      cardElements.get(card.id)?.querySelector('button').focus({preventScroll:true});
      status($('boardStatus'),'已生成 '+card.label+'，可选中它继续修改。');
    } catch (error) {
      status($('editStatus'),controller.signal.aborted?'已停止。当前源图和选区仍在。':error.message,!controller.signal.aborted);
    } finally {running=null; syncForm();}
  };

  window.addEventListener('pagehide',event => {
    connecting?.abort();
    running?.abort();
    if (!event.persisted) {
      historyStore.dispose();
      for (const src of objectURLs.values()) URL.revokeObjectURL(src);
    }
  });
})();
