(function () {
  'use strict';
  const workbench = window.WuyingWorkbench;
  const endpointKey='wuying.comfyEndpoint'+(workbench?.demo?'-demo':'');
  if (!workbench?.board) return;
  const board = workbench.board;
  const comfy = window.WuyingComfy;
  const byId = id => document.getElementById(id);
  const endpoint = byId('comfyEndpoint');
  const checkpoint = byId('comfyCheckpoint');
  const controlnet = byId('comfyControlnet');
  const models = byId('comfyModels');
  const config = byId('comfyConfig');
  const status = byId('comfyStatus');
  const connection = byId('connectionLabel');
  const connect = byId('testComfy');
  const generate = byId('generateRender');
  const stop = byId('stopRender');
  const preview = byId('controlPreview');
  const thumb = byId('controlThumb');
  const strength = byId('controlStrength');
  const prompt = byId('renderPrompt');
  let connectedEndpoint = '';
  let activeJob;
  let previewUrl;
  let sourceVersion = 0;

  endpoint.value = 'http://127.0.0.1:8188';
  try { endpoint.value = localStorage.getItem(endpointKey) || endpoint.value; } catch {}
  byId('comfyCorsOrigin').textContent = location.origin === 'null'
    ? '当前是本地文件，请优先从预览链接打开。'
    : '--enable-cors-header ' + location.origin;

  function message(value, error = false) {
    status.textContent = value;
    status.classList.toggle('ai-error', error);
  }

  function connectionState(label, ready = false) {
    connection.textContent = label;
    byId('connectionDot').classList.toggle('is-connected', ready);
  }

  function clearPreview() {
    thumb.hidden = true;
    thumb.removeAttribute('src');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }

  window.addEventListener('controlsourcechange', () => {
    sourceVersion++;
    clearPreview();
  });

  function linkedId() {
    if(!workbench.graph?.inBoard())return undefined;
    const id=workbench.graph.linkedDocumentId();
    if(!id)throw new Error('请先连入一个草图节点。');
    return id;
  }

  preview.onclick = async () => {
    const version = sourceVersion;
    preview.disabled = true;
    clearPreview();
    try {
      const blob = await board.captureControl(linkedId());
      if (version !== sourceVersion) return;
      previewUrl = URL.createObjectURL(blob);
      thumb.src = previewUrl;
      thumb.hidden = false;
    } catch (error) {
      if (version === sourceVersion) message(error.message, true);
    } finally {
      preview.disabled = false;
    }
  };

  function updateStrength() {
    byId('strengthReadout').value = Number(strength.value).toFixed(2);
    strength.style.setProperty('--percent', (100 * (strength.value - strength.min) / (strength.max - strength.min)) + '%');
  }
  strength.addEventListener('input', updateStrength);
  updateStrength();

  const presets = {
    ps: 'Industrial design line sketch, Photoshop marker rendering, preserve contour and panel seams, layered translucent color blocks, pencil edges, soft cast shadow and rim highlights, ivory presentation paper',
    metal: 'Industrial product photography, satin brushed aluminum, fine dark grille, softbox reflections, warm gray backdrop, soft shadows',
    fabric: 'Industrial product photography, woven fabric grille, matte polymer body, soft diffused daylight, neutral cream backdrop',
    clay: 'Industrial product form study, warm white clay finish, soft gray background, broad overhead light, clean silhouette and soft shadows'
  };
  document.querySelectorAll('[data-render-preset]').forEach(button => {
    button.onclick = () => { prompt.value = presets[button.dataset.renderPreset]; };
  });

  endpoint.oninput = () => {
    connectedEndpoint = '';
    models.hidden = true;
    connectionState('未连接');
  };

  function modelOptions(select, list, preferred) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '请选择兼容模型';
    select.replaceChildren(empty, ...list.map(name => new Option(name, name)));
    select.value = list.find(name => preferred.test(name)) || '';
  }

  connect.onclick = async () => {
    const address = endpoint.value.trim();
    connectedEndpoint = '';
    models.hidden = true;
    endpoint.disabled = connect.disabled = generate.disabled = true;
    connectionState('检测中');
    message('正在读取服务中的基础模型和控形模型…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const { checkpoints, controlnets } = await comfy.testConnection(address, { signal: controller.signal });
      connectedEndpoint = address;
      try { localStorage.setItem(endpointKey, address); } catch {}
      modelOptions(checkpoint, checkpoints, /sd.?1[._-]?5|v1[._-]?5/i);
      modelOptions(controlnet, controlnets, /scribble/i);
      models.hidden = false;
      connectionState('已连接', true);
      if (!checkpoints.length || !controlnets.length) {
        message('服务已连接。请在 ComfyUI 安装 SD 1.5 基础模型及兼容的 Scribble 控形模型后重新检测。', true);
      } else {
        message('请确认所选的是 SD 1.5 基础模型和同版本的 Scribble 控形模型。');
      }
    } catch (error) {
      connectionState('未连接');
      message(controller.signal.aborted ? '检测超时，请确认服务地址和网页访问权限。' : error.message, true);
    } finally {
      clearTimeout(timeout);
      endpoint.disabled = connect.disabled = generate.disabled = false;
    }
  };

  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取生成结果。'));
      reader.readAsDataURL(blob);
    });
  }

  generate.onclick = async () => {
    if (!connectedEndpoint || connectedEndpoint !== endpoint.value.trim()) {
      config.open = true;
      endpoint.focus();
      message('请先填写 ComfyUI 地址并检测连接。', true);
      return;
    }
    if (!checkpoint.value || !controlnet.value) {
      config.open = true;
      message('请选择兼容的 SD 1.5 基础模型和 Scribble 控形模型。', true);
      return;
    }
    const description = prompt.value.trim();
    if (!description) {
      prompt.focus();
      message('请填写画面描述。', true);
      return;
    }
    let source;
    try { source=board.controlSource(linkedId()); }
    catch(error){message(error.message,true);return;}
    const sourceTitle=board.sceneFor(source.id).title;
    const job = new AbortController();
    activeJob = job;
    const settings = {
      endpoint: connectedEndpoint, checkpoint: checkpoint.value, controlnet: controlnet.value,
      strength: Number(strength.value), prompt: description, signal: job.signal,
      negative: 'blur, distorted proportions, warped grille, clutter, text, watermark',
      onStatus: value => message(value)
    };
    endpoint.disabled = connect.disabled = generate.disabled = true;
    stop.hidden = false;
    message('正在整理选中的控形输入…');
    try {
      const sketch = await board.captureControl(source.id);
      if (job.signal.aborted) return;
      const { blob } = await comfy.generate({ ...settings, sketch });
      const image = await dataUrl(blob);
      if (job.signal.aborted) return;
      const id = board.addImage(image, 'AI 出图 · ' + sourceTitle, source);
      if (!id) throw new Error('已生成效果图，浏览器画布已达容量上限。原图可从 ComfyUI 输出中下载。');
      window.dispatchEvent(new CustomEvent('studiorender',{detail:{id,source}}));
      message('生成完成，可在关联的预览节点查看。');
    } catch (error) {
      if (!job.signal.aborted) message(error.message || '出图失败，请检查服务状态。', true);
    } finally {
      if (job.signal.aborted) message('已停止等待。已提交的任务可在 ComfyUI 队列中查看。');
      activeJob = undefined;
      stop.hidden = true;
      endpoint.disabled = connect.disabled = generate.disabled = false;
    }
  };
  stop.onclick = () => activeJob?.abort();
})();
