(async () => {
  'use strict';
  if (!await window.WuyingLocalWorkspace.requireProject()) return;

  const $ = selector => document.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const projectId = window.WuyingProjects?.idFromLocation();
  const assetId = params.get('asset');
  const project = window.WuyingProjects?.get(projectId);
  const boardUrl = project ? 'workbench.html?project=' + encodeURIComponent(projectId) : 'files.html';
  const boardSelection = boardUrl + (project && assetId ? '&asset=' + encodeURIComponent(assetId) : '');
  const flow = window.WuyingWorkflow, variations = window.WuyingVariationControls;
  const compose = window.WuyingWorkspaceComposite;
  const regions = window.WuyingImageSelection;
  const stage = $('#studioStage');
  const canvas = $('#studioCanvas');
  const overlay = $('#studioOverlay');
  const form = $('#studioOperation');
  const kinds = {instant:'快速渲染',render:'提示渲染',explore:'方案发散',scene:'情境渲染',studio:'高品质呈现',modify:'修改图像',color:'配色变化',form:'造型变化',view:'生成视角',cutout:flow.names.cutout,upscale:flow.names.upscale,outpaint:flow.names.outpaint};
  const toolHints = {brush:'画笔 · 拖动画线',erase:'橡皮 · 擦除当前手绘层',lasso:'套索 · 圈出要修改的区域',rect:'矩形 · 拖出修改区域'};
  const iconNS = 'http://www.w3.org/2000/svg';
  const defaultEndpoint = 'http://127.0.0.1:8188';
  const maxHistory = 32;

  let store, doc, activeLayerId, tool = 'brush', selection = [], gesture, picked, showInput = false;
  let pending = Promise.resolve(), saving = 0, displayToken = 0, running, connecting;
  let settings = {}, retrySeed, retryRun, runningInfo;
  const undo = [], redo = [];
  const thumbnails = new Map();
  const asset = () => doc?.assets && Object.hasOwn(doc.assets, assetId) ? doc.assets[assetId] : undefined;
  const pickedOutput = () => doc?.jobs?.[picked?.jobId]?.outputs?.find(output => output.id === picked.outputId);
  const layers = () => asset()?.layers || [];
  const activeLayer = () => layers().find(layer => layer.id === activeLayerId);
  const clone = value => structuredClone(value);
  const selectionValid = () => !!regions?.enough(selection);
  const isAreaTool = () => tool === 'rect' || tool === 'lasso';
  const formControl=variations.form(undefined,syncOperation);
  const palette=variations.palette([],async()=>{
    if(!asset()) throw new Error('找不到源图。');
    await pending;
    return window.WuyingWorkspaceRender.imagePalette(await compose.toPng(asset(),store));
  },syncOperation);
  const angles=variations.viewpoint([],syncOperation);
  $('#studioVariation').append(formControl.root,palette.root,angles.root);
  // 方案发散的方向勾选：默认前四个，至少两个、至多六个。
  for(const [key,preset] of Object.entries(flow.directionPresets)){
    const label=element('label','direction-item');
    const input=element('input');
    input.type='checkbox';input.value=key;input.checked=['minimal','organic','rugged','retro'].includes(key);
    input.addEventListener('change',syncOperation);
    label.append(input,element('span','',preset.label));
    $('#studioDirectionList').append(label);
  }
  // 模块 4：呈现镜头（默认主图+特写）与材质预设。
  for(const [key,preset] of Object.entries(flow.shotPresets)){
    const label=element('label','direction-item');
    const input=element('input');
    input.type='checkbox';input.value=key;input.checked=true;
    input.addEventListener('change',syncOperation);
    label.append(input,element('span','',preset.label));
    $('#studioShotList').append(label);
  }
  $('#studioMaterial').append(...Object.entries(flow.materialPresets).map(([key,preset])=>new Option(preset.label,key)));
  const readShots=()=>[...document.querySelectorAll('#studioShotList input:checked')].map(input=>input.value);
  const readDirections=()=>[...document.querySelectorAll('#studioDirectionList input:checked')].map(input=>input.value);
  function writeDirections(list){
    const wanted=flow.normalizeDirections(list);
    if(!wanted.length)return;
    for(const input of document.querySelectorAll('#studioDirectionList input'))input.checked=wanted.includes(input.value);
  }

  $('#studioClose').href = boardSelection;
  $('#studioReturn').href = boardUrl;
  for(const [value,label] of Object.entries(compose.blendModes)) $('#studioBlendMode').add(new Option(label,value));
  $('#studioProject').textContent = project?.name || '';

  function element(tag, name, text) {
    const node = document.createElement(tag);
    if (name) node.className = name;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(iconNS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(iconNS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function control(label, css, callback) {
    const button = element('button', css);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', callback);
    return button;
  }

  function status(node, message, error = false) {
    node.textContent = message;
    node.dataset.error = String(error);
  }

  function saved(message, state) {
    $('#studioSaved').textContent = message;
    $('#studioSaved').dataset.state = state;
  }

  function loadError(error) {
    $('#studioShell').hidden = true;
    $('#studioLoadError').hidden = false;
    $('#studioLoadMessage').textContent = error.message;
    $('#studioExport').disabled = true;
    saved('无法载入', 'error');
  }

  function thumb(blobId, name) {
    const image = element('img', name);
    image.alt = '';
    image.loading = 'lazy';
    if (!thumbnails.has(blobId)) {
      thumbnails.set(blobId, store.getBlob(blobId).then(blob => blob && URL.createObjectURL(blob)).catch(() => null));
    }
    thumbnails.get(blobId).then(url => {
      if (url && image.isConnected) image.src = url;
    });
    return image;
  }

  function syncLayers() {
    const list = $('#studioLayers');
    const all = layers();
    if (!activeLayer()) activeLayerId = all.at(-1)?.id;
    list.replaceChildren();
    if (!all.length) list.append(element('li','layer-empty','画布为空。可以直接绘画，或导入一张图片。'));
    for (const layer of all.slice().reverse()) {
      const row = element('li','layer-row');
      row.dataset.layerId = layer.id;
      row.dataset.selected = String(layer.id === activeLayerId);
      row.dataset.visible = String(layer.visible !== false);
      const main = control(layer.name, 'layer-main', () => { activeLayerId = layer.id; syncLayers(); });
      main.setAttribute('aria-pressed',row.dataset.selected);
      const preview = layer.blobId ? thumb(layer.blobId,'layer-preview') : element('span','layer-preview');
      if (!layer.blobId) preview.append(icon('pen'));
      const details = element('span','layer-name');
      details.append(element('strong','',layer.name),element('span','',layer.kind === 'ink' ? '手绘' : '图片'));
      main.append(preview,details);
      const visible = layer.visible !== false;
      const eye = control((visible ? '隐藏' : '显示') + layer.name, 'icon layer-eye', () => {
        void editLayer(layer.id,current => { current.visible = current.visible === false; });
      });
      eye.append(icon(visible ? 'eye' : 'hidden'));
      row.append(main,eye);
      list.append(row);
    }
    const selected = activeLayer();
    $('#studioLayerOptions').hidden = !selected;
    if (selected) {
      const opacity = Math.round((selected.opacity ?? 1) * 100);
      $('#studioOpacity').value = opacity;
      $('#studioOpacityValue').textContent = opacity + '%';
      $('#studioBlendMode').value=compose.normalizeBlend(selected.blendMode);
      $('#studioLayerUp').disabled = selected.id === all.at(-1)?.id;
      $('#studioLayerDown').disabled = selected.id === all[0]?.id;
    }
    $('#studioUndo').disabled = !undo.length;
    $('#studioRedo').disabled = !redo.length;
  }

  function syncResults() {
    const area = $('#studioResults');
    const jobs = Object.values(doc?.jobs || {}).filter(job =>
      job.sourceId === assetId && job.kind!=='video' && job.outputs?.length
    ).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
    area.replaceChildren();
    $('#studioResultCount').textContent = jobs.reduce((count,job) => count + job.outputs.length,0);
    if (runningInfo) {
      const waiting = Math.max(0,runningInfo.count - runningInfo.done);
      const group = element('section','run-group is-pending');
      const heading = element('div','run-heading');
      heading.append(element('strong','',runningInfo.label + ' · 生成中'),element('span','',runningInfo.done + '/' + runningInfo.count));
      const grid = element('div','candidate-grid');
      for (let i = 0; i < waiting; i++) {
        const card = element('div','candidate skeleton');
        card.setAttribute('aria-hidden','true');
        grid.append(card);
      }
      group.setAttribute('aria-busy','true');
      group.append(heading,grid);
      area.append(group);
    }
    if (!jobs.length && !runningInfo) area.append(element('p','run-hint','生成的候选会出现在这里。'));
    for (const job of jobs) {
      const group = element('section','run-group');
      const heading = element('div','run-heading');
      const date = job.createdAt ? new Date(job.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
      const finish = job.kind==='instant' ? ' · '+(flow.fidelityStages[job.settings?.targetFidelity]?.label||'自动推进') : '';
      const title = (kinds[job.kind] || '生成') + finish + (job.rerunOf ? ' · 按原输入重跑' : '');
      heading.append(element('strong','',title),element('time','',date));
      if (job.outputs.length >= 2) {
        const compareButton = control('并排对比','link compare-open',() => openCompare(job.id));
        compareButton.textContent = '并排对比';
        heading.append(compareButton);
      }
      if (job.prompt) heading.title = job.prompt;
      const grid = element('div','candidate-grid');
      for (const [index,output] of job.outputs.entries()) {
        const name = output.name || '候选 ' + (index + 1);
        const button = control(name,'candidate',() => {
          picked = {jobId:job.id,outputId:output.id};
          showInput = false;
          syncResults();
          void renderCanvas();
        });
        button.dataset.outputId = output.id;
        button.setAttribute('aria-pressed',String(picked?.outputId === output.id && picked.jobId === job.id));
        if (output.blobId) button.append(thumb(output.blobId,''));
        button.append(element('span','',name));
        grid.append(button);
      }
      group.append(heading,grid);
      area.append(group);
    }
    const previewing = !!pickedOutput();
    $('#studioExitPreview').hidden=!previewing;
    $('#studioCandidateActions').hidden = !previewing;
    $('#studioPreviewBanner').hidden = !previewing;
    if(typeof syncLiveLayout==='function')syncLiveLayout();
    stage.dataset.preview = String(previewing);
    $('#studioPreviewLabel').textContent = showInput ? '生成时的源图' : '候选预览';
    $('#studioShowInput').hidden = !doc?.jobs?.[picked?.jobId]?.inputBlobId;
    $('#studioShowInput').textContent = showInput ? '查看候选' : '查看源图';
    $('#studioShowInput').setAttribute('aria-pressed',String(showInput));
    const toolOutput=pickedOutput();
    const pickedKind=doc?.jobs?.[picked?.jobId]?.kind;
    const enlarged=['upscale','outpaint','studio'].includes(pickedKind)&&(toolOutput?.width!==asset()?.width||toolOutput?.height!==asset()?.height);
    $('#studioApplyResult').disabled=showInput||enlarged;
    $('#studioApplyResult').textContent=toolOutput?.transparent&&!enlarged?'应用透明图层':'添加到图层';
    $('#studioApplyResult').title=enlarged?(pickedKind==='studio'?'呈现图尺寸与画布不同，请放到工作台，再在工作台上放大 2×':'放到工作台或导出可保留放大尺寸'):'';
    const onBoard = !!(pickedOutput() && doc.assets[pickedOutput().id]);
    $('#studioPromoteResult').disabled = showInput || onBoard;
    $('#studioPromoteResult').textContent = onBoard ? '已在工作台' : '放到工作台';
    $('#studioRerun').disabled = !!running || !doc?.jobs?.[picked?.jobId]?.inputBlobId;
    $('#studioCandidate3d').disabled = showInput || !pickedOutput()?.blobId;
  }

  // 模块 2：并排对比。源图 + 本轮全部候选同屏，点选后可采用为图层或放到工作台。
  let compareState;
  function openCompare(jobId) {
    const job = doc?.jobs?.[jobId];
    if (!job?.outputs?.length) return;
    compareState = {jobId, outputId: picked?.jobId === jobId ? picked.outputId : undefined};
    renderCompare();
    const dialog = $('#studioCompare');
    if (!dialog.open) dialog.showModal();
  }
  function renderCompare() {
    const job = doc?.jobs?.[compareState?.jobId];
    const grid = $('#studioCompareGrid');
    grid.replaceChildren();
    if (!job) return;
    $('#studioCompareMeta').textContent = (kinds[job.kind] || '生成') + ' · ' + job.outputs.length + ' 个候选';
    if (job.inputBlobId) {
      const source = element('figure','compare-cell is-source');
      source.append(thumb(job.inputBlobId,''),element('figcaption','','源图'));
      grid.append(source);
    }
    for (const [index,output] of job.outputs.entries()) {
      const name = output.name || '候选 ' + (index + 1);
      const cell = control('选择 ' + name,'compare-cell',() => {
        compareState.outputId = output.id;
        renderCompare();
      });
      cell.dataset.outputId = output.id;
      cell.setAttribute('aria-pressed',String(compareState.outputId === output.id));
      if (output.blobId) cell.append(thumb(output.blobId,''));
      cell.append(element('span','compare-name',name));
      grid.append(cell);
    }
    const chosen = job.outputs.find(output => output.id === compareState.outputId);
    const onBoard = !!(chosen && doc.assets[chosen.id]);
    $('#studioCompareApply').disabled = !chosen?.blobId;
    $('#studioComparePromote').disabled = !chosen || onBoard;
    $('#studioComparePromote').textContent = onBoard ? '已在工作台' : '放到工作台';
    if (!chosen) status($('#studioCompareStatus'),'点选一张候选，再采用或放到工作台。');
  }
  function compareChoice() {
    const job = doc?.jobs?.[compareState?.jobId];
    return job && job.outputs.find(output => output.id === compareState.outputId);
  }

  // 模块 5：情境化设计。照片在最底层，笔触层在上；缺任一项都给出明确提示。
  function sceneReady() {
    const visible = layers().filter(layer => layer.visible !== false && (layer.opacity ?? 1) > 0);
    const photo = visible.some(layer => layer.kind === 'image' && layer.blobId);
    const sketch = visible.some(layer => layer.kind === 'ink' && layer.strokes?.some(stroke => !stroke.erase));
    return {photo, sketch, ok: photo && sketch};
  }
  function syncScene() {
    const ready = sceneReady();
    const note = $('#studioSceneStatus');
    if (note.dataset.lock) return;
    status(note, !ready.photo ? '第一步：上传一张场景照片（无笔触时画布会跟随照片比例）。'
      : !ready.sketch ? '第二步：在照片上画出产品草图。' : '照片和草图已就绪。', false);
  }
  async function importScenePhoto(file) {
    const note = $('#studioSceneStatus');
    const image = await regions.decode(file);
    const ratioW = image.width, ratioH = image.height;
    image.close();
    const long = Math.min(2048, Math.max(512, Math.max(ratioW, ratioH)));
    const scale = long / Math.max(ratioW, ratioH);
    const width = Math.round(ratioW * scale / 8) * 8, height = Math.round(ratioH * scale / 8) * 8;
    const id = crypto.randomUUID();
    let resized = false;
    const wrote = await changeLayers((all, current) => {
      const inked = all.some(layer => layer.kind === 'ink' && layer.strokes?.length);
      if (!inked && (current.width !== width || current.height !== height)) {
        current.width = width; current.height = height; resized = true;
      }
      all.unshift({id, name: '场景照片 · ' + (file.name.replace(/\.[^.]+$/, '') || '照片'), kind: 'image', blobId: id, visible: true, opacity: 1});
    }, [{id, blob: file}]);
    if (!wrote) return;
    activeLayerId = id;
    note.dataset.lock = '1';
    status(note, resized ? '画布已跟随照片比例：' + width + ' × ' + height + '。现在在照片上画产品草图。'
      : '照片已放到最底层。画布已有笔触，保持原比例（照片按比例留白）。');
    setTimeout(() => { delete note.dataset.lock; }, 4000);
    fitCanvas();
    syncLayers();
    syncOperation();
  }

  function syncOperation() {
    const kind = $('#studioKind').value;
    const instant=kind==='instant', isExplore=kind==='explore', isRender=kind==='render'||isExplore, isForm=kind==='form', isColor=kind==='color', isView=kind==='view';
    const viewCount=isView?angles.read().length:0, imageTool=flow.isImageTool(kind);
    const expanding=kind==='outpaint';
    $('#studioExpandFields').hidden=!expanding;
    const direction=formControl.read();
    // 影响力口径（方案 §7.3）：render/instant 为草图影响力 0–150%，其余为改动强度 25–95%，两档各自记忆。
    const strengthInput=$('#studioStrength');
    const influenceMode=instant||isRender;
    strengthInput.min=influenceMode?'0':'25';
    strengthInput.max=influenceMode?'150':'95';
    strengthInput.step=influenceMode?'5':'1';
    if(influenceMode){
      strengthInput.value=strengthInput.dataset.influence||'80';
      strengthInput.dataset.influence=strengthInput.value;
    }else if(kind==='studio'){
      // 高品质呈现以保形为主，默认改动强度 40%（img2img 保留造型）。
      strengthInput.value=strengthInput.dataset.studio||'40';
      strengthInput.dataset.studio=strengthInput.value;
    }else if(kind==='scene'){
      // 情境渲染需要高重绘强度才能把草图区域变成实物；单独记忆，默认 85%。
      strengthInput.value=strengthInput.dataset.scene||'85';
      strengthInput.dataset.scene=strengthInput.value;
    }else{
      strengthInput.value=strengthInput.dataset.adjust||'55';
      strengthInput.dataset.adjust=strengthInput.value;
    }
    $('#studioStrengthLabel').textContent=influenceMode?'草图影响力':'改动强度';
    $('#studioStrengthField').hidden=imageTool||(isForm&&!!(direction.x||direction.y));
    $('#studioFidelityField').hidden=!instant;
    $('#studioVariation').hidden=!isForm&&!isColor&&!isView;
    const isScene=kind==='scene';
    $('#studioSceneFields').hidden=!isScene;
    if(isScene) syncScene();
    const isStudio=kind==='studio', shotCount=isStudio?readShots().length:0;
    $('#studioShots').hidden=!isStudio;
    $('#studioShots').disabled=!!running;
    const directionCount=isExplore?readDirections().length:0;
    $('#studioDirections').hidden=!isExplore;
    $('#studioDirections').disabled=!!running;
    $('#studioDirectionCount').textContent=isExplore?directionCount+' / '+flow.directionLimit:'';
    for(const input of document.querySelectorAll('#studioDirectionList input'))input.disabled=!!running||(!input.checked&&directionCount>=flow.directionLimit);
    formControl.root.hidden=!isForm;
    palette.root.hidden=!isColor;
    angles.root.hidden=!isView;
    formControl.root.disabled=palette.root.disabled=angles.root.disabled=!!running;
    // 实时辅助开启时提示词始终可改，改动 500 ms 后自动重渲。
    $('#studioPromptField').hidden=(instant||imageTool)&&!stage.dataset.live;
    $('#studioPromptField label').textContent=isForm||isColor||viewCount||isExplore||isStudio?'补充说明（可选）':isView?'描述目标角度':'描述想要的结果';
    const quantity=$('#studioQuantity'), allowed=flow.quantityOptions(kind);
    for(const item of quantity.options) item.hidden=item.disabled=!allowed.includes(Number(item.value));
    if(!allowed.includes(Number(quantity.value))) quantity.value='1';
    quantity.closest('label').hidden=quantity.disabled=!!viewCount||imageTool||isExplore||isStudio;
    quantity.closest('.operation-split').hidden=imageTool||expanding;
    $('#studioGenerateLabel').textContent=instant?'渲染':imageTool?'运行':'生成';
    const target=flow.resolveFidelity(doc||{jobs:{}},asset(),$('#studioFidelity').value);
    const renderInputs=$('#studioRenderInputs'), reference=$('#studioReference'), style=$('#studioRenderStyle');
    renderInputs.hidden=!instant&&!isRender;
    const previous=reference.value;
    const candidates=Object.values(doc?.assets||{}).filter(item=>item.id!==assetId&&item.mediaType!=='video'&&
      (item.draft?.parts.length||item.layers?.some(layer=>layer.visible!==false&&(layer.blobId||layer.strokes?.length))));
    reference.replaceChildren(new Option('不使用参考图',''),...candidates.map(item=>new Option(item.name,item.id)));
    if(candidates.some(item=>item.id===previous)) reference.value=previous;
    const styleAllowed=!instant||['shaded','realistic'].includes(target);
    $('#studioRenderStyleLabel').hidden=style.hidden=!styleAllowed;
    $('#studioReferenceRoleLabel').hidden=$('#studioReferenceRole').hidden=!reference.value;
    const hints = {
      instant:'本次目标：'+flow.fidelityStages[target].label+'。自动推进依据已有阶段记录，首次从色块开始。输出保持源图尺寸。',
      render:'根据画布中的草图渲染。已连接的 ControlNet 会约束轮廓。',
      explore:directionCount<2?'至少选择两个设计方向。':'同一张草图按 '+directionCount+' 个方向各出一张，轮廓由 ControlNet 锁定，生成后可并排对比。',
      modify:selectionValid() ? '本次仅修改选区，保留选区外的画面。' : '套索或矩形可以把修改限制在选区内。',
      scene:selectionValid() ? '只渲染圈出的区域，草图约束造型，照片其余像素保持不变。' : '只渲染草图所在区域（自动按草图范围定区，也可用套索圈定），照片其余像素保持不变。',
      studio:!shotCount?'至少选择一种镜头。':[readShots().includes('hero')?'棚拍主图：两段高清采样，长边 1280，跟随原图比例':'',readShots().includes('detail')?(selectionValid()?'材质特写：放大圈出的区域到 1280×1024':'材质特写：放大画面中心到 1280×1024，可用套索指定部位'):''].filter(Boolean).join('；')+'。',
      color:'从当前图层提取颜色后调整色板，也可以直接添加目标色。',
      form:'拖动圆点或调整横轴与纵轴。离中心越远，变化越明显。',
      view:viewCount?'':'也可直接描述目标角度，例如右前方 30°。',
      cutout:'本机 ComfyUI · 需要 BiRefNet · 生成透明 PNG',
      outpaint:'本机 ComfyUI · 仅生成新增区域，原图区域保留。扩图结果可作为新图放到工作台。',
      upscale:'本机 ComfyUI · 长边最多 4096 像素，放到工作台或导出可保留尺寸。'
    };
    const billing=(isForm||isColor||isView||isExplore)&&['runninghub','imageapi'].includes(settings.provider)?(viewCount||directionCount||quantity.value)+' 张，按次计费':'';
    const hint=$('#studioRunHint');
    hint.textContent=[hints[kind],billing].filter(Boolean).join(' · ');
    hint.hidden=!hint.textContent;
    $('#studioClearSelection').hidden = !selectionValid();
    $('#studioGenerate').disabled = !!running||(isExplore&&directionCount<2)||(isScene&&!sceneReady().ok)||(isStudio&&!shotCount);
    $('#studioCancelRun').hidden = !running;
    $('#studioModelSettings').disabled = !!running;
    $('#studioHint').textContent = selectionValid() ? '选区已就绪' : toolHints[tool];
    $('#studioStrengthValue').textContent = $('#studioStrength').value + '%';
  }

  function fitCanvas() {
    const current = asset();
    if (!current) return;
    const mode = stage.dataset.live;
    const stacked = mode === 'split' && getComputedStyle(stage).gridTemplateRows.trim().split(/\s+/).length > 1;
    const columns = mode === 'split' && !stacked ? 2 : 1, rows = stacked ? 2 : 1;
    const inset = mode ? 28 : Math.min(48,stage.clientWidth * .1);
    const top = mode ? 52 : 0, caption = mode === 'split' ? 22 : 0;
    const width = Math.max(1,(stage.clientWidth - inset - (columns - 1) * 14) / columns);
    const height = Math.max(1,(stage.clientHeight - inset - top - (rows - 1) * 14) / rows - caption);
    const scale = Math.min(width / current.width,height / current.height);
    const w = Math.floor(current.width * scale) + 'px', h = Math.floor(current.height * scale) + 'px';
    $('#studioCanvasBox').style.width = w;
    $('#studioCanvasBox').style.height = h;
    $('#studioLiveFrame').style.width = w;
    $('#studioLiveFrame').style.height = h;
  }

  function drawPath(ctx, points, width, height, close) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x * width,points[0].y * height);
    for (const p of points.slice(1)) ctx.lineTo(p.x * width,p.y * height);
    if (close) ctx.closePath();
  }

  function drawOverlay() {
    const {width,height} = overlay;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0,0,width,height);
    if (pickedOutput()) return;
    const scale = width / Math.max(1,overlay.clientWidth);
    const area = gesture?.mode === 'area' ? gesture.points : selection;
    if (area.length > 1) {
      drawPath(ctx,area,width,height,true);
      ctx.fillStyle = '#7054ed30';
      ctx.fill('evenodd');
      ctx.strokeStyle = '#4c29d7';
      ctx.lineWidth = 1.5 * scale;
      ctx.setLineDash([5 * scale,4 * scale]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (gesture?.mode !== 'ink') return;
    const {stroke} = gesture;
    const erase = stroke.erase;
    const layer = activeLayer();
    const drawingOnInk = layer?.kind === 'ink' && layer.visible !== false;
    ctx.save();
    ctx.globalAlpha = erase ? .6 : drawingOnInk ? layer.opacity ?? 1 : 1;
    ctx.strokeStyle = ctx.fillStyle = erase ? '#7769a9' : stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineJoin = ctx.lineCap = 'round';
    if (erase) ctx.setLineDash([Math.max(2,stroke.size),Math.max(3,stroke.size * .55)]);
    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.beginPath();
      ctx.arc(p.x * width,p.y * height,stroke.size / 2,0,2 * Math.PI);
      if (erase) ctx.stroke();
      else ctx.fill();
    } else {
      drawPath(ctx,stroke.points,width,height,false);
      ctx.stroke();
    }
    ctx.restore();
  }

  async function renderCanvas() {
    const current = asset();
    if (!current) return;
    const token = ++displayToken;
    const frame = document.createElement('canvas');
    frame.width = current.width;
    frame.height = current.height;
    const candidate = pickedOutput();
    let transparent=compose.isTransparent(current);
    try {
      if (candidate) {
        transparent=showInput?transparent:!!candidate.transparent;
        const blobId = showInput ? doc.jobs[picked.jobId].inputBlobId : candidate.blobId;
        const blob = await store.getBlob(blobId);
        if (!blob) throw new Error('未找到候选的图像。');
        const bitmap = await createImageBitmap(blob);
        const ctx = frame.getContext('2d');
        const ratio = Math.min(frame.width / bitmap.width,frame.height / bitmap.height);
        const width = bitmap.width * ratio, height = bitmap.height * ratio;
        if(!transparent){ctx.fillStyle='#fff';ctx.fillRect(0,0,frame.width,frame.height);}
        ctx.drawImage(bitmap,(frame.width - width) / 2,(frame.height - height) / 2,width,height);
        bitmap.close();
      } else {
        await compose.draw(current,store,frame);
      }
      if (token !== displayToken) return;
      $('#studioCanvasBox').dataset.transparent=String(transparent);
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = overlay.width = frame.width;
        canvas.height = overlay.height = frame.height;
        fitCanvas();
      }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(frame,0,0);
      drawOverlay();
    } catch (error) {
      if (token === displayToken) status($('#studioRunStatus'),error.message,true);
    }
  }

  function refresh() {
    const current = asset();
    if (!current) {
      loadError(new Error('这张图已经从工作台移除。'));
      return;
    }
    $('#studioAsset').textContent = current.name;
    document.title = current.name + ' · 物映';
    $('#studioDimensions').textContent = current.width + ' × ' + current.height;
    syncLayers();
    syncResults();
    syncThemeFields();
    syncOperation();
    fitCanvas();
    void renderCanvas();
  }

  // 实时辅助：Krea 式“左画右出图”并排视图，或 Krita 式把渲染叠在画布上。
  // 画布始终显示草图本身，实时结果只在旁边或叠加层出现，不会覆盖正在画的笔触。
  let liveEnabled=false, liveBlob=null, liveUrl='', liveView='split', liveSeed=0, liveStarted=0, liveFrameAt=0, liveMoveAt=0, livePromptTimer;
  let liveTier='balanced', livePaused=false, hdBusy=null, liveFrames=[], liveViewIndex=0, historyButtons=[];
  const liveImage=$('#studioLiveImage'), liveBlend=$('#studioLiveBlend');
  const newSeed=()=>crypto.getRandomValues(new Uint32Array(1))[0];
  function syncLiveLayout() {
    const on=liveEnabled&&!pickedOutput();
    stage.dataset.live=on?liveView:'';
    $('#studioLivePane').hidden=!on||liveView!=='split';
    $('#studioLiveBar').hidden=!on;
    $('#studioLiveBlendField').hidden=liveView!=='blend';
    liveBlend.hidden=!on||liveView!=='blend'||!liveUrl;
    liveBlend.style.opacity=String(Number($('#studioLiveOpacity').value)/100);
    for(const button of document.querySelectorAll('[data-live-view]'))button.setAttribute('aria-pressed',String(button.dataset.liveView===liveView));
    $('#studioLiveApply').disabled=!liveBlob;
    $('#studioLive3d').disabled=!liveBlob;
    $('#studioLiveHD').disabled=!liveBlob||!!hdBusy;
    syncThemeButton();
    fitCanvas();
  }
  function showFrame(index) {
    const frame=liveFrames[index];
    if(!frame)return;
    liveViewIndex=index;
    liveBlob=frame.blob;
    liveUrl=frame.url;
    liveImage.src=liveBlend.src=frame.url;
    for(const [i,button] of historyButtons.entries())button.setAttribute('aria-pressed',String(i===index));
  }
  function renderLiveHistory() {
    const strip=$('#studioLiveHistory');
    historyButtons=liveFrames.map((frame,index)=>{
      const button=element('button','live-thumb');
      button.type='button';
      button.title='回看这一帧，可直接采用为图层';
      button.setAttribute('aria-label','历史帧 '+(liveFrames.length-index));
      button.setAttribute('aria-pressed',String(index===liveViewIndex));
      const image=element('img');
      image.src=frame.url;
      image.alt='';
      button.append(image);
      button.addEventListener('click',()=>{showFrame(index);$('#studioLiveSize').textContent='';});
      return button;
    });
    strip.replaceChildren(...historyButtons);
    strip.hidden=liveFrames.length<2;
  }
  function pushLiveFrame(blob) {
    liveFrames.unshift({blob,url:URL.createObjectURL(blob)});
    while(liveFrames.length>6)URL.revokeObjectURL(liveFrames.pop().url);
    renderLiveHistory();
    showFrame(0);
  }
  function clearLiveFrames() {
    for(const frame of liveFrames)URL.revokeObjectURL(frame.url);
    liveFrames=[];
    historyButtons=[];
    $('#studioLiveHistory').replaceChildren();
    $('#studioLiveHistory').hidden=true;
    liveBlob=null;
    liveUrl='';
    liveImage.removeAttribute('src');
    liveBlend.removeAttribute('src');
    $('#studioLiveTime').textContent='';
    $('#studioLiveSize').textContent='';
  }
  // Qwen 实时通道无 ControlNet：AI 强度滑块不参与，禁用并说明。
  function syncLiveChannel() {
    const qwen=qwenCheckpoint.test(flow.modelPrefs().checkpoint||'');
    const input=$('#studioLiveStrength'), label=input.closest('.live-range');
    input.disabled=qwen;
    if(label){
      label.classList.toggle('is-disabled',qwen);
      label.title=qwen?'Qwen 实时通道不走 ControlNet，AI 强度不生效':'';
    }
    $('#studioLiveStrengthValue').textContent=qwen?'—':input.value+'%';
  }
  function showLive(state) {
    const dot=$('#studioLiveDot');
    dot.dataset.state=state.status;
    $('#studioLiveFrame').dataset.running=String(state.status==='running'||state.status==='hd');
    if(state.status==='running')liveStarted=performance.now();
    if(state.result){
      pushLiveFrame(state.result);
      liveFrameAt=performance.now();
      $('#studioLiveTime').textContent=((liveFrameAt-liveStarted)/1000).toFixed(1)+' s';
      $('#studioLiveSize').textContent='';
    }
    $('#studioLiveEmpty').hidden=!!liveUrl;
    // 失败态：就地显示原因与「重试」，不必关掉实时辅助再开。
    const failed=state.status==='failed'&&!(state.error?.name==='AbortError');
    $('#studioLiveRetry').hidden=!failed;
    $('#studioLivePane').dataset.failed=String(failed);
    if(failed)$('#studioLiveEmpty').hidden=!!liveUrl;
    const qwenLive=qwenCheckpoint.test(flow.modelPrefs().checkpoint||'');
    $('#studioLiveState').textContent=state.status==='running'
      ?(qwenLive?'正在渲染（Qwen 高质量 · 慢速）…':'正在渲染…')
      :state.status==='failed'?'渲染失败：'+String(state.error?.message||'未知错误').slice(0,80):
      state.status==='paused'?'已暂停':state.status==='hd'?'正在生成高清帧…':
      state.status==='waiting'?'等待笔触':liveUrl?'已跟上最新笔触':'等待笔触';
    if(state.error)status($('#studioRunStatus'),state.error.message,true);
    syncLiveLayout();
  }
  // Qwen-Image-2.1 是分体式模型（无 ControlNet），实时通道走慢速高质量预览。
  const qwenCheckpoint=/^qwen[_ ]?image[_ ]?2\.?1/i;
  const live=window.WuyingWorkspaceRender.createLatestPreview({
    debounce:220,keepRunning:true,
    render:async(current,signal)=>{
      const model=flow.modelPrefs();
      const source=await compose.toPng(current,store);
      signal.throwIfAborted();
      const prompt=[
        $('#studioPrompt').value.trim()||'Industrial design concept preview.',
        window.WuyingWorkspaceRender.themeDirective(asset()?.theme),
        briefDirective(),
        angleDirective()
      ].filter(Boolean).join(' ');
      // Qwen 实时通道：草图作参考图，按画质档降低分辨率（512/640/768）；
      // 失败（8GB 显存不足等）自动降到 512 重试一次，仍失败才报错。
      if(qwenCheckpoint.test(model.checkpoint||'')){
        const run=resolution=>window.WuyingComfy.renderQwen({
          endpoint:model.endpoint,checkpoint:model.checkpoint,prompt,sourceImage:source,seed:liveSeed,
          resolution,slot:'qwen-live-'+assetId.slice(0,36),signal,cancelPending:true,onStatus:()=>{}
        }).then(result=>result.blob);
        const resolution={speed:512,balanced:640,quality:768}[liveTier]??640;
        try{
          return await run(resolution);
        }catch(error){
          if(signal.aborted||resolution<=512)throw error;
          return await run(512);
        }
      }
      return window.WuyingWorkspaceRender.generate({
        kind:'render',provider:'comfy',preview:true,live:true,liveTier,source,signal,endpoint:model.endpoint,checkpoint:model.checkpoint,
        controlnet:model.controlnet,strength:Number($('#studioLiveStrength').value)/100,seed:liveSeed,slot:'live-'+assetId.slice(0,36),
        size:{width:current.width,height:current.height},
        prompt
      });
    },
    onState:showLive
  });
  // 方案主题：写入当前 asset.theme；实时渲染每次取最新值，保存后立刻重渲。
  const themePop = $('#studioThemePop');
  const themeBrief = $('#studioThemeBrief');
  let themeTimer;
  // 把 asset.theme.text 同步到右侧常驻框与工具条浮层；正在编辑的控件不覆盖，避免打断输入。
  function syncThemeFields(active) {
    const text = String(asset()?.theme?.text || '');
    if (themeBrief !== active) themeBrief.value = text;
    if ($('#studioThemeText') !== active) $('#studioThemeText').value = text;
    syncThemeButton();
  }
  // 单一写入口：右侧常驻框与浮层「完成」都走这里，保证两处数据源一致。
  function writeTheme(text, custom, { closePop = false } = {}) {
    text = String(text || '').trim().slice(0, 300);
    custom = String(custom || '').trim().slice(0, 1200);
    saving += 1;
    saved('正在保存主题', 'saving');
    const operation = pending.then(async () => {
      doc = await store.change(document => {
        const current = document.assets[assetId];
        if (!current) throw new Error('这张图已经从工作台移除。');
        if (text || custom) current.theme = { text, custom };
        else delete current.theme;
        current.updatedAt = Date.now();
      });
    });
    pending = operation.catch(() => {});
    return operation.catch(error => {
      saved('未能保存主题', 'error');
      status($('#studioRunStatus'), error.message, true);
    }).then(() => {
      saving -= 1;
      saved('已保存主题', 'saved');
      syncThemeFields();
      refresh();
      scheduleLive();
      if (closePop) closeTheme();
    });
  }
  function syncThemeButton() {
    const theme = asset()?.theme;
    const text = String(theme?.text || '').trim();
    const custom = String(theme?.custom || '').trim();
    const active = !!(text || custom);
    $('#studioLiveTheme').classList.toggle('has-theme', active);
    $('#studioLiveTheme').title = active
      ? '主题：' + (text || custom).slice(0, 60)
      : '给这张方案设置主题，实时渲染会跟着主题走';
  }
  function openTheme() {
    const theme = asset()?.theme || {};
    syncThemeFields();
    $('#studioThemeCustom').value = theme.custom || '';
    themePop.hidden = false;
    $('#studioLiveTheme').setAttribute('aria-expanded', 'true');
    $('#studioThemeText').focus();
  }
  function closeTheme() {
    themePop.hidden = true;
    $('#studioLiveTheme').setAttribute('aria-expanded', 'false');
  }
  function saveTheme() {
    return writeTheme($('#studioThemeText').value, $('#studioThemeCustom').value, { closePop: true });
  }

  // ── 造型流程：阶段轨道 + 产品方向 ──────────────────────────────
  // 阶段只是引导与预设：sketch 自由画，refine 跳部件编辑器（锁定载体），
  // ortho 预选三视图角度，render 显示角度球。锁定与出图仍走同一条链路。
  // P0 收口：前进条件 + 过期标记（橙点）+ 冻结快照，逻辑在 flow-stages.js。
  const flowStages=['sketch','refine','ortho','render'];
  const stageBook=window.WuyingFlowStages;
  const briefPresets={};
  function flowState(){return asset()?.flow||{};}
  function flowBrief(){const brief=flowState().brief;return brief&&typeof brief==='object'?brief:{};}
  function briefDirective(){
    const {category,text}=flowBrief();
    const parts=[];
    if(category) parts.push('Product category: '+category+'.');
    if(text) parts.push('Design direction: '+text+'.');
    return parts.join(' ');
  }
  function angleDirective(){
    if(flowState().stage!=='render'||!angleSphere) return '';
    const mapped=window.WuyingAngleSphere.mapToView(angleSphere.read().azimuth,angleSphere.read().elevation);
    const preset=flow.viewPresets[mapped.view];
    return preset?'Target camera angle: '+preset.prompt:'';
  }
  function syncFlowRail(){
    const stage=stageBook.normalizeStage(flowState().stage);
    for(const step of document.querySelectorAll('#studioFlowRail .flow-step')){
      step.classList.toggle('is-active',step.dataset.stage===stage);
      step.setAttribute('aria-current',step.dataset.stage===stage?'step':'false');
      // 过期标记：上游改过之后，该阶段的旧结果可能不再成立
      const stale=stageBook.staleOf(flowState(),step.dataset.stage);
      step.classList.toggle('is-stale',stale);
      step.title=stale?'上游已修改：这一阶段的旧结果可能过期，进入后可重新生成或保留':step.title;
    }
    const brief=flowBrief(), briefText=[brief.category,brief.text].filter(Boolean).join(' · ');
    const tag=$('#studioFlowBrief');
    tag.textContent=briefText?'产品方向：'+briefText:'设置产品方向';
    tag.hidden=!briefText&&stage!=='sketch';
    $('#sketchQuick').hidden=stage!=='sketch';
    $('#orthoQuick').hidden=stage!=='ortho';
    $('#studioAngleBox').hidden=stage!=='render';
    if(stage==='ortho'&&!angles.read().length) angles.write(['front','left','top']);
    if(stage==='ortho'||stage==='render') $('#studioKind').value='view';
    if(stage!=='sketch') $('#studioFidelityField').hidden=true;
    if(stage==='render') initAngleSphere();
  }
  async function setFlowStage(stage){
    await pending;
    let enteredStale=false;
    doc=await store.change(current=>{
      const target=current.assets[assetId];
      if(!target) throw new Error('这张图已经从工作台移除。');
      const next={...(target.flow||{}),stage};
      next.stages={...(target.flow?.stages||{})};
      // 冻结快照：进入三视图时冻结微调结构修订号；进入渲染时冻结三视图画布
      if(stage==='ortho'&&target.draft?.revision){
        stageBook.capture(next,'refine',{revision:target.draft.revision});
      }
      if(stage==='render'){
        stageBook.capture(next,'ortho',{layersSig:stageBook.layersSig(target.layers)});
      }
      enteredStale=stageBook.staleOf(next,stage);
      target.flow=next;
      target.updatedAt=Date.now();
    });
    syncFlowRail();
    syncOperation();
    if(enteredStale) status($('#studioRunStatus'),'上游已修改：这一阶段的旧结果可能过期，可重新生成，也可以先沿用旧结果。');
  }
  // 草图造型 → 精细微调：把当前合成图存为部件草稿的底图，再进入部件编辑器。
  async function toRefine(){
    const button=$('#studioFlowRail [data-stage="refine"]');
    button.disabled=true;
    try{
      await pending;
      const current=asset();
      if(!current) throw new Error('这张图已经从工作台移除。');
      if(current.draft){ location.assign('shape-studio.html'+location.search); return; }
      if(!liveHasContent(current)) throw new Error('画布还是空的，先画一个造型再进入微调。');
      const blobId=crypto.randomUUID();
      const blob=await compose.toPng(current,store);
      doc=await store.change(doc2=>{
        const target=doc2.assets[assetId];
        if(!target) throw new Error('这张图已经从工作台移除。');
        target.draft={revision:crypto.randomUUID(),parts:[],reference:{blobId,assetId,label:target.name}};
        const next={...(target.flow||{}),stage:'refine'};
        // 冻结快照：把此刻的画布合成图与图层摘要存档，之后草图再改动就会触发过期标记
        stageBook.capture(next,'sketch',{blobId,layersSig:stageBook.layersSig(target.layers)});
        target.flow=next;
        target.updatedAt=Date.now();
      },[{id:blobId,blob}]);
      location.assign('shape-studio.html'+location.search);
    }catch(error){
      status($('#studioRunStatus'),error.message,true);
    }finally{ button.disabled=false; }
  }
  // 一键转线稿：跑「整理线稿」，完成后自动加为新图层。
  async function toLineart(){
    if(running) return;
    const button=$('#studioToLineart');
    const prefs=flow.modelPrefs();
    if(!prefs.endpoint||!prefs.checkpoint){
      status($('#studioRunStatus'),'请在模型设置里选择 ComfyUI 基础模型。',true);
      showModel();
      return;
    }
    button.disabled=true;
    status($('#studioRunStatus'),'正在整理线稿…');
    try{
      await pending;
      const job=await flow.run(store,{kind:'instant',sourceId:assetId,fidelity:'line',quantity:1,
        provider:'comfy',endpoint:prefs.endpoint,checkpoint:prefs.checkpoint,controlnet:prefs.controlnet},
        {onStatus:message=>status($('#studioRunStatus'),message)});
      const output=job.outputs?.at(-1);
      if(!output?.blobId) throw new Error('线稿生成失败，请重试。');
      await addImage(output.blobId,'整理线稿',[{id:output.blobId,blob:await store.getBlob(output.blobId)}]);
      exitPreview();
      status($('#studioRunStatus'),'线稿已加为新图层，可继续在上面画或进入微调。');
    }catch(error){
      status($('#studioRunStatus'),'转线稿失败：'+error.message,true);
    }finally{ button.disabled=false; }
  }
  // 产品方向浮层
  const briefPop=$('#studioFlowBriefPop');
  function openBrief(){
    const brief=flowBrief();
    $('#flowBriefCategory').value=brief.category||'';
    $('#flowBriefText').value=brief.text||'';
    briefPop.hidden=false;
    $('#flowBriefText').focus();
  }
  function closeBrief(){briefPop.hidden=true;}
  async function saveBrief(){
    const category=$('#flowBriefCategory').value.trim(), text=$('#flowBriefText').value.trim().slice(0,200);
    await pending;
    doc=await store.change(current=>{
      const target=current.assets[assetId];
      if(!target) throw new Error('这张图已经从工作台移除。');
      const next={...(target.flow||{})};
      if(category||text) next.brief={category,text}; else delete next.brief;
      target.flow=next;
      target.updatedAt=Date.now();
    });
    closeBrief();
    syncFlowRail();
    scheduleLive();
    status($('#studioRunStatus'),'产品方向已保存，实时辅助与渲染会按这个方向走。');
  }
  document.addEventListener('pointerdown',event=>{
    if(briefPop.hidden||briefPop.contains(event.target)||event.target.closest?.('#studioFlowBrief'))return;
    closeBrief();
  });
  $('#studioFlowBrief').addEventListener('click',()=>briefPop.hidden?openBrief():closeBrief());
  $('#flowBriefSave').addEventListener('click',()=>void saveBrief());
  $('#flowBriefClear').addEventListener('click',()=>{$('#flowBriefCategory').value='';$('#flowBriefText').value='';});
  for(const step of document.querySelectorAll('#studioFlowRail .flow-step[data-stage]')){
    step.addEventListener('click',()=>{
      const stage=step.dataset.stage;
      // 前进条件：产品渲染需要画面里有内容（三视图齐全的替代校验），不满足时报原因不切换
      if(stage==='render'&&!liveHasContent(asset())){
        status($('#studioRunStatus'),'还没有可渲染的画面：先在前面的阶段生成图，或回到草图画一个造型。',true);
        return;
      }
      if(stage==='refine'&&asset()?.draft&&stageBook.staleOf(flowState(),'refine')){
        status($('#studioRunStatus'),'上游草图已修改：旧部件草稿基于修改前的画面，可在微调页继续沿用，或重新进入生成新草稿。');
      }
      if(stage==='refine') void toRefine();
      else void setFlowStage(stage);
    });
  }
  $('#studioToLineart').addEventListener('click',()=>void toLineart());
  // ── 角度球（阶段 5）──────────────────────────────────────────
  let angleSphere=null;
  function syncAngleLabel(){
    if(!angleSphere) return;
    const {azimuth,elevation}=angleSphere.read();
    const mapped=window.WuyingAngleSphere.mapToView(azimuth,elevation);
    $('#studioAngleLabel').textContent='当前视角：'+flow.viewPresets[mapped.view].label+'（水平 '+Math.round(azimuth)+'° · 俯仰 '+Math.round(elevation)+'°）';
  }
  async function generateFromAngle(){
    if(!angleSphere) return;
    const {azimuth,elevation}=angleSphere.read();
    const mapped=window.WuyingAngleSphere.mapToView(azimuth,elevation);
    $('#studioKind').value='view';
    angles.write([mapped.view]);
    syncOperation();
    void generate();
  }
  function initAngleSphere(){
    if(angleSphere||!window.WuyingAngleSphere) return;
    angleSphere=window.WuyingAngleSphere.create({size:148,onChange:({azimuth,elevation})=>{
      syncAngleLabel();
      const mapped=window.WuyingAngleSphere.mapToView(azimuth,elevation);
      $('#studioKind').value='view';
      angles.write([mapped.view]);
      syncOperation();
      if($('#studioAngleAuto').checked){
        if(liveEnabled) scheduleLive(); else void generate();
      }else scheduleLive();
    }});
    $('#studioAngleSphere').append(angleSphere.root);
    syncAngleLabel();
  }

  function liveHasContent(current) {
    return current?.layers?.some(layer=>layer.visible!==false&&(layer.blobId||layer.strokes?.length));
  }
  function scheduleLive(pendingStroke) {
    const current=asset();
    if(!liveEnabled||livePaused||hdBusy||running||pickedOutput()||!current)return;
    const snapshot=window.WuyingWorkspaceRender.liveSnapshot(current,pendingStroke);
    if(liveHasContent(snapshot))live.schedule(snapshot);
  }
  function setLivePaused(paused) {
    if(hdBusy)return;
    livePaused=paused;
    $('#studioLivePause').setAttribute('aria-pressed',String(paused));
    $('#studioLivePause').textContent=paused?'继续':'暂停';
    if(paused){
      live.cancel();
      showLive({status:'paused'});
    }else{
      showLive({status:'waiting'});
      scheduleLive();
    }
  }
  // 高清增强：沿用当前草图、提示词、主题、种子与强度。SD 走 final 档二次采样到 1280×1024；
  // Qwen 走本通道 1024 原生分辨率（输出跟随草图长宽比）。
  function enhanceLive() {
    if(hdBusy||!liveBlob||gesture||saving||!liveEnabled)return;
    const current=asset();
    if(!current||!liveHasContent(current))return;
    const model=flow.modelPrefs();
    const qwen=qwenCheckpoint.test(model.checkpoint||'');
    const controller=new AbortController();
    hdBusy=controller;
    live.cancel();
    showLive({status:'hd'});
    (async()=>{
      const source=await compose.toPng(current,store);
      controller.signal.throwIfAborted();
      const prompt=[
        $('#studioPrompt').value.trim()||'Industrial design concept preview.',
        window.WuyingWorkspaceRender.themeDirective(asset()?.theme)
      ].filter(Boolean).join(' ');
      const blob=qwen
        ? (await window.WuyingComfy.renderQwen({
            endpoint:model.endpoint,checkpoint:model.checkpoint,prompt,sourceImage:source,seed:liveSeed,
            resolution:1024,slot:'qwen-live-hd-'+assetId.slice(0,36),signal:controller.signal,cancelPending:true
          })).blob
        : await window.WuyingWorkspaceRender.generate({
          kind:'render',provider:'comfy',source,signal:controller.signal,endpoint:model.endpoint,checkpoint:model.checkpoint,
          controlnet:model.controlnet,strength:Number($('#studioLiveStrength').value)/100,seed:liveSeed,slot:'live-hd-'+assetId.slice(0,36),
          liveTier,size:{width:current.width,height:current.height},
          prompt
        });
      if(hdBusy!==controller)return;
      pushLiveFrame(blob);
      $('#studioLiveTime').textContent='';
      const bitmap=await createImageBitmap(blob);
      $('#studioLiveSize').textContent='高清 '+bitmap.width+'×'+bitmap.height;
      bitmap.close();
      showLive({status:'done'});
      status($('#studioRunStatus'),'高清帧已生成，可直接采用为图层。');
    })().catch(error=>{
      if(hdBusy!==controller)return;
      showLive({status:'failed',error});
      if(!controller.signal.aborted)status($('#studioRunStatus'),'高清增强失败：'+error.message,true);
    }).finally(()=>{
      if(hdBusy===controller){hdBusy=null;syncLiveLayout();}
    });
  }
  function setLive(enabled) {
    liveEnabled=enabled;
    live.cancel();
    hdBusy?.abort();
    hdBusy=null;
    livePaused=false;
    $('#studioLivePause').setAttribute('aria-pressed','false');
    $('#studioLivePause').textContent='暂停';
    $('#studioLive').setAttribute('aria-pressed',String(enabled));
    if(enabled&&!liveSeed)liveSeed=newSeed();
    if(!enabled)clearLiveFrames();
    showLive({status:'idle'});
    syncResults();
    syncOperation();
    if(enabled)scheduleLive();
  }
  // 实时面板内直接切换基础模型，不必打开全局设置；切换后立刻重渲。
  let liveModelsFetched=false;
  function syncLiveModelSelect() {
    const field=$('#studioLiveModelField'), select=$('#studioLiveModel');
    const names=[...new Set([...(settings.checkpoints||[]),settings.checkpoint]
      .filter(name=>typeof name==='string'&&name))];
    select.replaceChildren(...names.map(name=>new Option(
      qwenCheckpoint.test(name)?name+'（高质量 · 慢速实时）':name,name)));
    const current=flow.modelPrefs().checkpoint;
    if(names.includes(current))select.value=current;
    syncLiveChannel();
    field.hidden=!names.length;
    // 冷启动只有当前模型时，向本机 ComfyUI 拉一次模型列表，让面板能直接换模型。
    if(!liveModelsFetched&&(!settings.provider||settings.provider==='comfy')&&settings.endpoint&&names.length<2){
      liveModelsFetched=true;
      flow.checkModel(settings.endpoint).then(found=>{
        settings.checkpoints=found.checkpoints;
        settings.controlnets=found.controlnets;
        syncLiveModelSelect();
      }).catch(()=>{});
    }
  }
  function changeLayers(update, blobs = [], track = true) {
    saving += 1;
    saved('正在保存', 'saving');
    const operation = pending.then(async () => {
      let before, after, wrote = false;
      doc = await store.change(document => {
        const current = document.assets[assetId];
        if (!current) throw new Error('这张图已经从工作台移除。');
        current.layers ||= [];
        before = track ? clone(current.layers) : null;
        if (update(current.layers,current) === false) return;
        after = track ? clone(current.layers) : null;
        // P0 过期标记：草图阶段改动画面后，与进入微调时冻结的图层摘要比对，
        // 不一致就把微调/三视图/渲染标过期；改回快照状态则自动清除。
        if ((current.flow?.stage||'sketch')==='sketch'&&current.flow?.stages?.sketch?.snapshot){
          const flowNext={...current.flow,stages:{...current.flow.stages}};
          const changed=stageBook.layersSig(current.layers)!==flowNext.stages.sketch.snapshot.layersSig;
          stageBook.markStale(flowNext,'sketch',changed);
          current.flow=flowNext;
        }
        current.updatedAt = Date.now();
        wrote = true;
      }, blobs);
      if (track && wrote) {
        undo.push({before,after});
        if (undo.length > maxHistory) undo.shift();
        redo.length = 0;
      }
      return wrote;
    });
    pending = operation.catch(() => {});
    return operation.catch(error => {
      saved('未能保存', 'error');
      status($('#studioRunStatus'),error.message,true);
      return null;
    }).then(wrote => {
      saving -= 1;
      if (wrote !== null && !saving) saved('已保存','saved');
      refresh();
      if(wrote){ syncFlowRail(); scheduleLive(); }
      return wrote === true;
    });
  }

  function editLayer(id, update) {
    return changeLayers(all => {
      const layer = all.find(item => item.id === id);
      if (!layer) return false;
      update(layer);
    });
  }

  function inkLayer(id, name) {
    return {id,name,kind:'ink',visible:true,opacity:1,strokes:[]};
  }

  function addInk() {
    const id = crypto.randomUUID();
    activeLayerId = id;
    return changeLayers(all => all.push(inkLayer(id,'手绘 ' + (all.filter(layer => layer.kind === 'ink').length + 1))));
  }

  function addImage(blobId, name, blobs = [], transparent = false) {
    const id = crypto.randomUUID();
    activeLayerId = id;
    return changeLayers(all=>{
      if(transparent) for(const layer of all) layer.visible=false;
      all.push({id,name,kind:'image',blobId,visible:true,opacity:1,...(transparent?{transparent:true}:{})});
    },blobs);
  }

  function moveLayer(delta) {
    const id = activeLayerId;
    return changeLayers(all => {
      const index = all.findIndex(layer => layer.id === id), next = index + delta;
      if (index < 0 || next < 0 || next >= all.length) return false;
      [all[index],all[next]] = [all[next],all[index]];
    });
  }

  async function stepHistory(from, to, wanted, expected) {
    const item = from.at(-1);
    if (!item || saving) return;
    let conflicts = false;
    const wrote = await changeLayers(all => {
      if (JSON.stringify(all) !== JSON.stringify(item[expected])) {
        conflicts = true;
        return false;
      }
      all.splice(0,all.length,...clone(item[wanted]));
    },[],false);
    if (conflicts) {
      undo.length = redo.length = 0;
      saved('已刷新','saved');
      status($('#studioRunStatus'),'图层在另一处更新了。已刷新当前内容。');
    } else if (wrote) {
      from.pop();
      to.push(item);
    }
    syncLayers();
  }

  function chooseTool(next) {
    tool = next;
    stage.dataset.tool = next;
    for (const button of document.querySelectorAll('[data-tool]')) {
      if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed',String(button.dataset.tool === next));
    }
    $('#strokeSettings').hidden = isAreaTool();
    syncOperation();
  }

  function pointAt(event) {
    const bounds = overlay.getBoundingClientRect();
    const unit = n => Math.max(0,Math.min(1,n));
    return {x:unit((event.clientX - bounds.left) / bounds.width),y:unit((event.clientY - bounds.top) / bounds.height)};
  }

  function strokeMove(event) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const p = pointAt(event);
    if (gesture.mode === 'area' && tool === 'rect') {
      const first = gesture.start;
      gesture.points = [first,{x:p.x,y:first.y},p,{x:first.x,y:p.y}];
    } else {
      const points = gesture.mode === 'area' ? gesture.points : gesture.stroke.points;
      const last = points.at(-1);
      const distance = Math.hypot(last.x - p.x,last.y - p.y);
      const limit = gesture.mode === 'area' ? 1200 : 12000;
      if (points.length < limit && distance > .0007) points.push(p);
    }
    drawOverlay();
    // 边画边渲染：落笔前就把进行中的笔触送去渲染，调度器只保留最新一份。
    if (gesture.mode === 'ink' && liveEnabled && performance.now() - liveMoveAt > 140) {
      liveMoveAt = performance.now();
      scheduleLive(gesture);
    }
  }

  function beginPointer(event) {
    if (event.button !== 0 || pickedOutput() || !asset() || gesture) return;
    event.preventDefault();
    overlay.focus({preventScroll:true});
    const point = pointAt(event);
    if (isAreaTool()) {
      gesture = {mode:'area',pointer:event.pointerId,start:point,points:[point]};
    } else {
      const layer = activeLayer();
      if (tool === 'erase' && (layer?.kind !== 'ink' || layer.visible === false)) {
        status($('#studioRunStatus'),'请选择可见的手绘图层再使用橡皮。',true);
        return;
      }
      gesture = {
        mode:'ink',pointer:event.pointerId,layerId:layer?.id,
        stroke:{points:[point],color:$('#studioColor').value,size:Number($('#studioSize').value),erase:tool === 'erase'}
      };
    }
    overlay.setPointerCapture(event.pointerId);
    drawOverlay();
  }

  function endPointer(event, cancelled) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!cancelled) strokeMove(event);
    const finished = gesture;
    gesture = null;
    if (!cancelled && finished.mode === 'area') {
      selection = regions.enough(finished.points) ? finished.points : [];
      if (selection.length && !['scene','studio'].includes($('#studioKind').value)) $('#studioKind').value = 'modify';
      syncOperation();
    } else if (!cancelled) {
      const newId = crypto.randomUUID();
      void changeLayers(all => {
        let layer = all.find(item => item.id === finished.layerId);
        if (layer?.kind !== 'ink' || layer.visible === false) {
          if (finished.stroke.erase) return false;
          const offset = all.findIndex(item => item.id === finished.layerId);
          layer = inkLayer(newId,'手绘 ' + (all.filter(item => item.kind === 'ink').length + 1));
          all.splice(offset < 0 ? all.length : offset + 1,0,layer);
          activeLayerId = newId;
        }
        layer.strokes ||= [];
        layer.strokes.push(finished.stroke);
      });
    }
    drawOverlay();
  }

  function clearSelection() {
    selection = [];
    syncOperation();
    drawOverlay();
  }

  function exitPreview() {
    picked = undefined;
    showInput = false;
    syncResults();
    void renderCanvas();
  }

  function options(select, values, preferred, allowEmpty = false) {
    select.replaceChildren();
    const names = [...new Set(values.filter(name => typeof name === 'string' && name))];
    if (allowEmpty || !names.length) select.append(new Option(allowEmpty ? '无' : '选择基础模型',''));
    for (const name of names) select.append(new Option(name,name));
    if (names.includes(preferred)) select.value = preferred;
  }

  const cloud = () => $('#studioProvider').value === 'runninghub';
  const customApi = () => $('#studioProvider').value === 'imageapi';
  let profileRequest, profiles=[];
  function syncProvider() {
    $('#studioCloudFields').hidden = !cloud();
    $('#studioImageApiFields').hidden = !customApi();
    $('#studioComfyFields').hidden = cloud()||customApi();
    $('#studioSaveModel').disabled=customApi()&&(!!profileRequest||!$('#studioImageApi').value);
  }
  async function loadProfiles(){
    profileRequest?.abort();
    if(!customApi()){
      profileRequest=undefined;syncProvider();return;
    }
    const controller=new AbortController();
    profileRequest=controller;
    const select=$('#studioImageApi');
    select.replaceChildren(new Option('正在读取接口',''));
    syncProvider();
    try{
      profiles=await window.WuyingPlatformApi.fillSelect(select,settings.apiProfileId,{signal:controller.signal});
      status($('#studioConnectionStatus'),select.value?'请选择要用的图片接口。':'在后台管理添加支持图片编辑的接口。');
    }catch(error){
      if(!controller.signal.aborted) status($('#studioConnectionStatus'),error.message,true);
    }finally{
      if(profileRequest===controller){profileRequest=undefined;syncProvider();}
    }
  }

  function fillModelDialog() {
    $('#studioProvider').value=settings.provider||'comfy';
    if (flow.cloudModels.includes(settings.cloudModel)) $('#studioCloudModel').value = settings.cloudModel;
    syncProvider();
    status($('#studioConnectionStatus'),'');
    $('#studioEndpoint').value = settings.endpoint || defaultEndpoint;
    options($('#studioCheckpoint'),settings.checkpoints || [settings.checkpoint],settings.checkpoint);
    options($('#studioControlnet'),settings.controlnets || [settings.controlnet],settings.controlnet,true);
  }

  function showModel() {
    fillModelDialog();
    $('#studioConnection').showModal();
    void loadProfiles();
  }

  async function saveModel() {
    if(customApi()){
      const selected=profiles.find(profile=>profile.id===$('#studioImageApi').value&&profile.ready&&profile.edit);
      if(!selected)return;
      settings={...settings,provider:'imageapi',apiProfileId:selected.id,apiProfileName:selected.name};
      flow.saveModel(settings);
      $('#studioConnection').close();
      status($('#studioRunStatus'),'已切换到 '+selected.name+'。');
      return;
    }
    if (cloud()) {
      const button = $('#studioSaveModel');
      button.disabled = true;
      status($('#studioConnectionStatus'),'正在检查 RunningHub…');
      try {
        await flow.checkCloud();
        settings = {...settings,provider:'runninghub',cloudModel:$('#studioCloudModel').value};
        await flow.saveModel(settings);
        $('#studioConnection').close();
        status($('#studioRunStatus'),'已切换到 RunningHub。');
      } catch (error) {
        status($('#studioConnectionStatus'),error.message,true);
      } finally { button.disabled = false; }
      return;
    }
    const endpoint = $('#studioEndpoint').value.trim();
    if (!$('#studioEndpoint').checkValidity() || !endpoint) {
      $('#studioEndpoint').reportValidity();
      return;
    }
    const checkpoint = $('#studioCheckpoint').value;
    if (!checkpoint) {
      status($('#studioConnectionStatus'),'读取模型后选择一个基础模型。',true);
      return;
    }
    settings = {...settings,provider:'comfy',endpoint,checkpoint,controlnet:$('#studioControlnet').value};
    try {
      await flow.saveModel(settings);
      $('#studioConnection').close();
      status($('#studioRunStatus'),'模型设置已保存。');
      syncLiveModelSelect();
      if(liveEnabled)scheduleLive();
    } catch (error) {
      status($('#studioConnectionStatus'),error.message,true);
    }
  }

  async function checkModel(event) {
    event.preventDefault();
    connecting?.abort();
    const controller = new AbortController();
    connecting = controller;
    const endpoint = $('#studioEndpoint').value.trim();
    $('#studioConnect').disabled = true;
    status($('#studioConnectionStatus'),'正在读取本机模型…');
    try {
      const found = await flow.checkModel(endpoint,{signal:controller.signal});
      if (connecting !== controller) return;
      settings.checkpoints = found.checkpoints;
      settings.controlnets = found.controlnets;
      options($('#studioCheckpoint'),found.checkpoints,settings.checkpoint);
      options($('#studioControlnet'),found.controlnets,settings.controlnet,true);
      status($('#studioConnectionStatus'),found.checkpoints.length ? '已连接，选择要使用的模型。' : '服务在线，未发现基础模型。',!found.checkpoints.length);
    } catch (error) {
      if (connecting === controller) status($('#studioConnectionStatus'),error.message,true);
    } finally {
      if (connecting === controller) { connecting = undefined; $('#studioConnect').disabled = false; }
    }
  }

  // 两种来源：当前图层合成（表单），或某一批保存的输入快照（rerunOf）。
  function formRequest() {
    const kind = $('#studioKind').value;
    const prompt = $('#studioPrompt').value.trim();
    const shape=kind==='form'?formControl.read():undefined;
    const colors=kind==='color'?palette.read():undefined;
    const views=kind==='view'?angles.read():undefined;
    const directions=kind==='explore'?readDirections():undefined;
    const shots=kind==='studio'?readShots():undefined;
    if(shots&&!shots.length) throw new Error('请至少选择一种呈现镜头：棚拍主图或材质特写。');
    if(directions&&directions.length<2) throw new Error('方案发散至少选择两个设计方向。');
    if(!flow.isImageTool(kind)&&!prompt&&!flow.sketchKinds.includes(kind)&&kind!=='outpaint'&&kind!=='studio'&&!(shape?.x||shape?.y||colors?.length||views?.length)){
      if(shape) formControl.focus();
      if(colors) palette.focus();
      if(views) throw Object.assign(new Error('请选择视角，或描述想要的角度。'),{field:'#studioPrompt'});
      throw Object.assign(new Error(shape?'请选择造型方向，或补充想要的变化。':colors?'请添加目标色，或补充想要的配色。':'请描述想要的修改。'),
        {field:shape||colors?undefined:'#studioPrompt'});
    }
    const strengthValue = Number($('#studioStrength').value) / 100;
    const request = {
      kind,sourceId:assetId,prompt:kind==='instant'?'':prompt,fidelity:$('#studioFidelity').value,form:shape,palette:colors,views,directions,shots,material:kind==='studio'?$('#studioMaterial').value:undefined,
      outpaint:kind==='outpaint'?{direction:$('#studioExpandDirection').value,percent:Number($('#studioExpandPercent').value)}:undefined,
      stageStyle:$('#studioRenderStyle').value,style:$('#studioRenderStyle').value,
      references:flow.sketchKinds.includes(kind)&&$('#studioReference').value
        ? [{id:$('#studioReference').value,role:$('#studioReferenceRole').value}] : undefined,
      selection:(kind === 'modify' || kind === 'scene' || kind === 'studio') && selectionValid() ? clone(selection) : undefined,
      provider:settings.provider,cloudModel:settings.cloudModel,apiProfileId:settings.apiProfileId,
      endpoint:settings.endpoint,checkpoint:settings.checkpoint,controlnet:settings.controlnet,
      // render/instant 用草图影响力口径；strength 兼容旧消费方，压回 0–1。
      ...(flow.sketchKinds.includes(kind)
        ?{influence:strengthValue,strength:Math.min(1,strengthValue)}
        :{strength:strengthValue}),
      quantity:Number($('#studioQuantity').value),seed:retrySeed
    };
    retrySeed = undefined;
    return request;
  }

  function rerunRequest(job) {
    const prior = job.settings || {};
    return {
      rerunOf:job.id,sourceId:assetId,provider:settings.provider,cloudModel:settings.cloudModel,apiProfileId:settings.apiProfileId,
      endpoint:settings.endpoint,checkpoint:settings.checkpoint,controlnet:settings.controlnet,
      ...(prior.influence !== undefined ? {influence:prior.influence} : {}),
      strength:prior.strength,quantity:prior.quantity
    };
  }

  async function generate(event, rerunJob) {
    event?.preventDefault();
    if (running) return;
    if(liveEnabled)setLive(false);
    const expanding=(rerunJob?.kind||$('#studioKind').value)==='outpaint';
    if(expanding&&(!settings.endpoint||!settings.checkpoint)){
      status($('#studioRunStatus'),'扩图需要本机 ComfyUI 基础模型。');
      showModel();
      return;
    }
    if (!expanding&&!flow.isImageTool(rerunJob?.kind||$('#studioKind').value)&&!flow.ready(settings)) {
      status($('#studioRunStatus'),'请先选择出图来源。');
      showModel();
      return;
    }
    let request;
    try { request = rerunJob ? rerunRequest(rerunJob) : formRequest(); } catch (error) {
      status($('#studioRunStatus'),error.message,true);
      if (error.field) $(error.field).focus();
      return;
    }
    const controller = new AbortController();
    running = controller;
    retryRun = undefined;
    $('#studioRetryRun').hidden = true;
    // 结果区骨架占位：按本次要出的张数画出等待卡片，收到一张换一张。
    runningInfo = {label:kinds[rerunJob?.kind||request.kind]||'生成',done:0,
      count:rerunJob?.settings?.views?.length||rerunJob?.settings?.directions?.length||rerunJob?.settings?.shots?.length||rerunJob?.settings?.quantity
        ||request.views?.length||request.directions?.length||request.shots?.length||request.quantity||1};
    syncOperation();
    syncResults();
    status($('#studioRunStatus'),rerunJob ? '读取这一批的输入快照…' : '准备源图…');
    try {
      await pending;
      const job = await flow.run(store,request,{
        signal:controller.signal,
        onStatus:(message,progress) => {
          if (running !== controller) return;
          const text = typeof message === 'string' ? message : message?.message;
          if (text) status($('#studioRunStatus'),text);
          if (progress?.output) {
            if (runningInfo) runningInfo.done = progress.count || runningInfo.done;
            void pending.then(() => store.read()).then(latest => {
              if (running !== controller || saving) return;
              doc = latest;
              syncResults();
            }).catch(() => {});
          }
        }
      });
      await pending;
      doc = await store.read();
      const result = job.outputs?.[0];
      if (result) {
        picked = {jobId:job.id,outputId:result.id};
        showInput = false;
      }
      status($('#studioRunStatus'),result ? '已生成。选择候选预览或加入图层。' : '已结束。');
    } catch (error) {
      try { doc = await store.read(); } catch {}
      const aborted = controller.signal.aborted;
      status($('#studioRunStatus'),aborted ? '已取消生成。' : '生成失败：' + error.message,!aborted);
      if (!aborted) {
        // 重试沿用这次的请求：表单请求换新种子重提，重跑请求沿用同一批快照。
        retryRun = {rerunJob};
        $('#studioRetryRun').hidden = false;
      }
    } finally {
      running = undefined;
      runningInfo = undefined;
      refresh();
    }
  }

  function restoreRun() {
    const job = doc?.jobs?.[picked?.jobId];
    if (!job) return;
    $('#studioKind').value = Object.hasOwn(kinds,job.kind) ? job.kind : 'modify';
    $('#studioPrompt').value = job.prompt || '';
    const prior = job.settings || {};
    $('#studioFidelity').value = flow.fidelityOptions.some(([key])=>key===prior.fidelity)?prior.fidelity:'auto';
    $('#studioRenderStyle').value=prior.stageStyle||prior.style||'none';
    if(job.references?.length){
      $('#studioReference').value=job.references[0].id;
      $('#studioReferenceRole').value=job.references[0].role;
    }else $('#studioReference').value='';
    if(prior.outpaint){
      $('#studioExpandDirection').value=prior.outpaint.direction;
      $('#studioExpandPercent').value=String(prior.outpaint.percent);
    }
    const influenceMode = flow.sketchKinds.includes(job.kind);
    if (prior.directions?.length) writeDirections(prior.directions);
    if (influenceMode) {
      const influence = Number.isFinite(prior.influence) ? prior.influence : (Number.isFinite(prior.strength) ? prior.strength : .8);
      $('#studioStrength').dataset.influence = String(Math.round(influence * 100));
      $('#studioStrength').value = String(Math.round(influence * 100));
    } else {
      const strength = Number.isFinite(prior.strength) ? prior.strength : .55;
      $('#studioStrength').dataset.adjust = String(Math.round(strength * 100));
      $('#studioStrength').value = String(Math.round(strength * 100));
    }
    formControl.write(prior.form);
    palette.write(prior.palette);
    angles.write(prior.views);
    $('#studioQuantity').value = flow.quantityOptions(job.kind).includes(prior.quantity) ? String(prior.quantity) : '1';
    if(!flow.isImageTool(job.kind)){
      for (const key of ['provider','cloudModel','endpoint','checkpoint','controlnet','apiProfileId','apiProfileName']) {
        if (typeof prior[key] === 'string') settings[key] = prior[key];
      }
    }
    retrySeed = Number.isSafeInteger(prior.seed) ? prior.seed : undefined;
    selection = regions.enough(job.selection || []) ? clone(job.selection) : [];
    if (selection.length) chooseTool('lasso');
    exitPreview();
    syncOperation();
    status($('#studioRunStatus'),'已恢复这一批的生成设置。');
    if(job.kind==='form'&&prior.form) formControl.focus();
    else if(job.kind==='color'&&prior.palette?.length) palette.focus();
    else if(job.kind==='view'&&prior.views?.length) angles.focus();
    else if(flow.isImageTool(job.kind)) $('#studioKind').focus({preventScroll:true});
    else (job.kind==='instant'?$('#studioFidelity'):$('#studioPrompt')).focus({preventScroll:true});
  }

  async function exportImage() {
    const button = $('#studioExport');
    button.disabled = true;
    try {
      await pending;
      const candidate = pickedOutput();
      const blobId = showInput ? doc?.jobs?.[picked?.jobId]?.inputBlobId : candidate?.blobId;
      const blob = blobId ? await store.getBlob(blobId) : await compose.toPng(asset(),store);
      if (!blob) throw new Error('无法读取要导出的图像。');
      const filename = (candidate?.name || asset().name).replace(/[<>:"/\\|?*]/g,'-');
      const href = URL.createObjectURL(blob);
      const download = document.createElement('a');
      download.href = href;
      download.download = filename + (blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png');
      download.click();
      setTimeout(() => URL.revokeObjectURL(href),1000);
    } catch (error) {
      status($('#studioRunStatus'),error.message,true);
    } finally { button.disabled = false; }
  }

  function keyboard(event) {
    if (event.defaultPrevented || event.repeat || event.target.closest('input,textarea,select,dialog,[contenteditable]')) return;
    if (event.key === 'Escape') {
      if (pickedOutput()) exitPreview();
      else clearSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) void stepHistory(redo,undo,'after','before');
      else void stepHistory(undo,redo,'before','after');
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'n') void addInk();
    const tools = {b:'brush',e:'erase',l:'lasso',m:'rect'};
    if (Object.hasOwn(tools,key)) chooseTool(tools[key]);
  }

  async function init() {
    if (!project || !assetId) { loadError(new Error('从工作台打开一张图像。')); return; }
    try {
      if (!compose || !flow || !regions || !window.WuyingWorkspace) throw new Error('工作室资源暂时无法加载。');
      store = window.WuyingWorkspace.open(projectId);
      doc = await store.read();
      if (!asset()) throw new Error('找不到这张图。');
      settings = await flow.modelPrefs() || {};
      $('#studioShell').hidden = false;
      // 阶段轨道：支持 ?stage= 直达（精细微调返回三视图等），并持久化到 asset.flow.stage。
      const requestedStage=new URLSearchParams(location.search).get('stage');
      if(flowStages.includes(requestedStage)&&flowState().stage!==requestedStage){
        await setFlowStage(requestedStage);
      }
      $('#studioFlowRail').hidden=false;
      syncFlowRail();
      saved('已保存','saved');
      syncLiveModelSelect();
      refresh();
    } catch (error) { loadError(error); }
  }

  $('#studioClose').addEventListener('click',async event => {
    if (!saving) return;
    event.preventDefault();
    await pending;
    location.assign(boardSelection);
  });
  $('#studioAddLayer').addEventListener('click',() => void addInk());
  $('#studioScenePhoto').addEventListener('click',() => $('#studioSceneFile').click());
  $('#studioSceneFile').addEventListener('change',async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await importScenePhoto(file); }
    catch (error) { status($('#studioSceneStatus'),'照片无法载入：' + error.message,true); }
  });
  $('#studioImportLayer').addEventListener('click',() => $('#studioLayerFile').click());
  $('#studioLayerFile').addEventListener('change',async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const image = await regions.decode(file);
      image.close();
      const id = crypto.randomUUID();
      await addImage(id,file.name.replace(/\.[^.]+$/,'') || file.name,[{id,blob:file}]);
    } catch (error) { status($('#studioRunStatus'),error.message,true); }
  });
  $('#studioOpacity').addEventListener('input',event => { $('#studioOpacityValue').textContent = event.target.value + '%'; });
  $('#studioOpacity').addEventListener('change',event => {
    const opacity = Number(event.target.value) / 100;
    if (activeLayerId) void editLayer(activeLayerId,layer => { layer.opacity = opacity; });
  });
  $('#studioLayerUp').addEventListener('click',() => void moveLayer(1));
  $('#studioLayerDown').addEventListener('click',() => void moveLayer(-1));
  $('#studioRemoveLayer').addEventListener('click',() => {
    const id = activeLayerId;
    void changeLayers(all => {
      const index = all.findIndex(layer => layer.id === id);
      if (index < 0) return false;
      all.splice(index,1);
      activeLayerId = all[Math.max(index - 1,0)]?.id;
    });
  });
  $('#studioUndo').addEventListener('click',() => void stepHistory(undo,redo,'before','after'));
  $('#studioRedo').addEventListener('click',() => void stepHistory(redo,undo,'after','before'));
  for (const button of document.querySelectorAll('button[data-tool]')) {
    button.addEventListener('click',() => chooseTool(button.dataset.tool));
  }
  $('#studioSize').addEventListener('input',event => { $('#studioSizeValue').textContent = event.target.value + ' px'; });
  overlay.addEventListener('pointerdown',beginPointer);
  overlay.addEventListener('pointermove',strokeMove);
  overlay.addEventListener('pointerup',event => endPointer(event,false));
  overlay.addEventListener('pointercancel',event => endPointer(event,true));
  overlay.addEventListener('lostpointercapture',event => endPointer(event,true));
  $('#studioClearSelection').addEventListener('click',clearSelection);
  $('#studioRenderStyle').replaceChildren(...Object.entries(flow.stylePresets).map(([id,preset])=>new Option(preset.label,id)));
  $('#studioKind').addEventListener('change',syncOperation);
  $('#studioReference').addEventListener('change',syncOperation);
  $('#studioQuantity').addEventListener('change',syncOperation);
  $('#studioFidelity').addEventListener('change',syncOperation);
  $('#studioStrength').addEventListener('input',event => {
    const kind = $('#studioKind').value;
    event.target.dataset[flow.sketchKinds.includes(kind) ? 'influence' : kind === 'scene' ? 'scene' : kind === 'studio' ? 'studio' : 'adjust'] = event.target.value;
    syncOperation();
  });
  $('#studioModelSettings').addEventListener('click',showModel);
  $('#studioCloseConnection').addEventListener('click',() => $('#studioConnection').close());
  $('#studioConnectForm').addEventListener('submit',checkModel);
  $('#studioSaveModel').addEventListener('click',saveModel);
  $('#studioProvider').addEventListener('change',() => { connecting?.abort();syncProvider();status($('#studioConnectionStatus'),'');void loadProfiles(); });
  $('#studioImageApi').addEventListener('change',syncProvider);
  $('#studioLive').addEventListener('click',()=>{
    if(liveEnabled){setLive(false);return;}
    const model=flow.modelPrefs();
    if(!model.endpoint||!model.checkpoint){
      status($('#studioRunStatus'),'请在模型设置里选择 ComfyUI 基础模型。',true);
      showModel();
      return;
    }
    if(pickedOutput())exitPreview();
    setLive(true);
  });
  $('#studioLiveApply').addEventListener('click',async()=>{
    if(!liveBlob||gesture||saving)return;
    const blob=liveBlob, id=crypto.randomUUID();
    await addImage(id,'实时渲染',[{id,blob}]);
    status($('#studioRunStatus'),'已把当前实时渲染加为新图层，可以继续在上面画。');
  });
  for(const button of document.querySelectorAll('[data-live-view]'))button.addEventListener('click',()=>{
    liveView=button.dataset.liveView;syncLiveLayout();
  });
  $('#studioLiveOpacity').addEventListener('input',syncLiveLayout);
  $('#studioLiveStrength').addEventListener('input',event=>{
    $('#studioLiveStrengthValue').textContent=event.target.value+'%';
  });
  $('#studioLiveStrength').addEventListener('change',()=>scheduleLive());
  $('#studioLiveSeed').addEventListener('click',()=>{liveSeed=newSeed();scheduleLive();});
  for(const button of document.querySelectorAll('[data-live-tier]'))button.addEventListener('click',()=>{
    liveTier=button.dataset.liveTier;
    for(const item of document.querySelectorAll('[data-live-tier]'))item.setAttribute('aria-pressed',String(item===button));
    scheduleLive();
  });
  $('#studioLivePause').addEventListener('click',()=>setLivePaused(!livePaused));
  $('#studioLiveHD').addEventListener('click',()=>enhanceLive());
  $('#studioLiveModel').addEventListener('change',event=>{
    const checkpoint=event.target.value;
    if(!checkpoint)return;
    settings={...settings,checkpoint};
    flow.saveModel(settings);
    syncOperation();
    syncLiveChannel();
    scheduleLive();
  });
  $('#studioLiveTheme').addEventListener('click',()=>themePop.hidden?openTheme():closeTheme());
  $('#studioThemeDone').addEventListener('click',saveTheme);
  // 常驻主题框：输入停顿 600ms 后保存；实时辅助开启时保存完立刻重渲一帧。
  themeBrief.addEventListener('input',()=>{
    syncThemeFields(themeBrief);
    clearTimeout(themeTimer);
    themeTimer=setTimeout(()=>{ themeTimer=0; void writeTheme(themeBrief.value,asset()?.theme?.custom); },600);
  });
  themeBrief.addEventListener('blur',()=>{
    if(themeTimer){ clearTimeout(themeTimer); themeTimer=0; void writeTheme(themeBrief.value,asset()?.theme?.custom); }
  });
  $('#studioThemeClear').addEventListener('click',()=>{
    $('#studioThemeText').value='';
    $('#studioThemeCustom').value='';
  });
  document.addEventListener('pointerdown',event=>{
    if(themePop.hidden||themePop.contains(event.target)||event.target.closest?.('#studioLiveTheme'))return;
    closeTheme();
  });
  $('#studioPrompt').addEventListener('input',()=>{
    clearTimeout(livePromptTimer);
    if(liveEnabled)livePromptTimer=setTimeout(()=>scheduleLive(),500);
  });
  form.addEventListener('submit',generate);
  $('#studioCancelRun').addEventListener('click',() => running?.abort());
  $('#studioRetryRun').addEventListener('click',() => { const job = retryRun?.rerunJob; void generate(null,job); });
  $('#studioLiveRetry').addEventListener('click',() => {
    $('#studioLiveRetry').hidden = true;
    showLive({status:'waiting'});
    scheduleLive();
  });
  $('#studioExitPreview').addEventListener('click',exitPreview);
  $('#studioRestoreRun').addEventListener('click',restoreRun);
  $('#studioShowInput').addEventListener('click',() => {
    showInput = !showInput;
    syncResults();
    void renderCanvas();
  });
  $('#studioBlendMode').addEventListener('change',event=>{
    const value=compose.normalizeBlend(event.target.value);
    if(activeLayerId) void editLayer(activeLayerId,layer=>{layer.blendMode=value;});
  });
  $('#studioApplyResult').addEventListener('click',async () => {
    const candidate = pickedOutput();
    if (!candidate?.blobId) return;
    const button = $('#studioApplyResult');
    button.disabled = true;
    try {
      if (await addImage(candidate.blobId,candidate.name || '生成结果',[],!!candidate.transparent)) exitPreview();
    } finally { button.disabled = false; }
  });
  $('#studioPromoteResult').addEventListener('click',async () => {
    const candidate = pickedOutput();
    if (!candidate) return;
    const button = $('#studioPromoteResult');
    button.disabled = true;
    try {
      await pending;
      doc = await store.change(current => { flow.promoteOutput(current,picked.jobId,candidate.id); });
      status($('#studioRunStatus'),'已放到工作台。返回工作台后可从这张图接下一轮操作。');
    } catch (error) {
      status($('#studioRunStatus'),error.message,true);
    } finally { syncResults(); }
  });
  $('#studioCloseCompare').addEventListener('click',() => $('#studioCompare').close());
  $('#studioCompareApply').addEventListener('click',async () => {
    const chosen = compareChoice();
    if (!chosen?.blobId) return;
    const button = $('#studioCompareApply');
    button.disabled = true;
    try {
      if (await addImage(chosen.blobId,chosen.name || '生成结果',[],!!chosen.transparent)) {
        status($('#studioCompareStatus'),'已采用「' + (chosen.name || '候选') + '」为新图层。');
        $('#studioCompare').close();
        exitPreview();
      }
    } catch (error) {
      status($('#studioCompareStatus'),'采用失败：' + error.message,true);
    } finally { if ($('#studioCompare').open) renderCompare(); }
  });
  $('#studioComparePromote').addEventListener('click',async () => {
    const chosen = compareChoice();
    if (!chosen) return;
    const button = $('#studioComparePromote');
    button.disabled = true;
    try {
      await pending;
      const jobId = compareState.jobId;
      doc = await store.change(current => { flow.promoteOutput(current,jobId,chosen.id); });
      renderCompare();
      status($('#studioCompareStatus'),'已放到工作台。');
    } catch (error) {
      status($('#studioCompareStatus'),'放到工作台失败：' + error.message,true);
      renderCompare();
    } finally { syncResults(); }
  });
  $('#studioRerun').addEventListener('click',() => {
    const job = doc?.jobs?.[picked?.jobId];
    if (job) void generate(null,job);
  });
  $('#studioExport').addEventListener('click',exportImage);
  // 模块 3：3D 查看。来源优先级：正在预览的候选 > 画布合成；实时条另有入口取当前实时帧。
  function open3d(kind) {
    const viewer = window.WuyingView3D;
    if (!viewer || !window.WuyingInflate) { status($('#studioRunStatus'),'3D 查看模块没有载入，请刷新页面。',true); return; }
    const candidate = pickedOutput();
    let getBlob, label, name;
    if (kind === 'live') {
      const blob = liveBlob;
      if (!blob) return;
      getBlob = async () => blob; label = '实时帧'; name = (asset()?.name || '物映') + ' 实时帧';
    } else if (candidate?.blobId && !showInput) {
      const blobId = candidate.blobId;
      getBlob = () => store.getBlob(blobId); label = candidate.name || '候选'; name = candidate.name || '候选';
    } else {
      getBlob = async () => { await pending; return compose.toPng(asset(),store); }; label = '画布合成'; name = asset()?.name || '画布';
    }
    viewer.setCaptureSize({width:asset().width,height:asset().height});
    void viewer.open({getBlob,name,sourceLabel:label,onCapture:async blob => {
      const id = crypto.randomUUID();
      if (pickedOutput()) exitPreview();
      if (!await addImage(id,'3D 视角 · ' + label,[{id,blob}])) throw new Error('图层没有保存成功。');
    }});
  }
  $('#studioOpen3d').addEventListener('click',() => open3d());
  $('#studioCandidate3d').addEventListener('click',() => open3d());
  $('#studioLive3d').addEventListener('click',() => open3d('live'));
  document.addEventListener('keydown',event => { if (asset()) keyboard(event); });
  new ResizeObserver(fitCanvas).observe(stage);
  window.addEventListener('storage',event=>{
    if(event.key==='wuying-workspace-model-v1'){
      settings=flow.modelPrefs();syncOperation();
      syncLiveModelSelect();
      if(liveEnabled)scheduleLive();
    }
  });
  window.addEventListener('pageshow',event=>{
    if(event.persisted){settings=flow.modelPrefs();syncOperation();syncLiveModelSelect();if(liveEnabled)scheduleLive();}
  });
  window.addEventListener('pagehide',event => {
    live.cancel();
    hdBusy?.abort();
    running?.abort();
    for(const frame of liveFrames)URL.revokeObjectURL(frame.url);
    if (event.persisted) return;
    for (const promise of thumbnails.values()) promise.then(url => { if (url) URL.revokeObjectURL(url); });
  });
  void init();
})();
