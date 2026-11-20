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

  const params = new URLSearchParams(location.search);
  const saved = project.presentation;
  const board = window.WuyingBoard;
  const draftId = params.get('draft') || saved?.draftId || project.activeDraftId;
  const scene = board.readSavedScene(projects.suffix(id),draftId);
  const effect = saved?.draftId === scene?.id && saved?.slot ? saved : null;
  const core = window.WuyingStudioCore;
  const rules = window.WuyingSketchRules;
  const graph = window.WuyingNodeGraphCore;
  const query = '?project=' + encodeURIComponent(id);
  const stage = $('presentStage'), art = $('presentImage'), comparison = $('presentComparison');
  const clip = $('presentVideo'), status = $('presentStatus'), thumbnails = $('presentThumbs');
  const motionButton = $('presentMotion'), exportButton = $('presentExport'), attach = $('presentAttach');
  const videoInput = $('presentVideoInput');
  const urls = new Map();
  const labels = {sketch:'草图', effect:effect?.label || '效果', compare:'并排对照', video:'产品视频'};
  let motion = null;
  let view = '';

  $('presentProject').textContent = project.name;
  $('presentName').textContent = scene?.title || '方案展示';
  document.title = $('presentName').textContent + ' · ' + project.name + ' · 物映';
  $('presentBack').href = 'index.html' + query + (scene ? '&draft=' + encodeURIComponent(scene.id) : '');
  $('presentReselect').href = $('presentBack').href + '&stage=generate';

  function setAsset(key, blob) {
    const previous = urls.get(key);
    urls.set(key,URL.createObjectURL(blob));
    if (previous) URL.revokeObjectURL(previous);
  }

  function stopMotion() {
    const running = motion;
    motion = null;
    running?.cancel();
    motionButton.setAttribute('aria-pressed','false');
    motionButton.textContent = '播放镜头';
  }

  function select(next) {
    stopMotion();
    clip.pause();
    view = next;
    stage.dataset.view = next;
    const imageKey = next === 'compare' ? 'effect' : next;
    const imageUrl = next !== 'video' && urls.get(imageKey);
    art.hidden = !imageUrl;
    comparison.hidden = next !== 'compare';
    clip.hidden = next !== 'video';
    if (imageUrl) {
      art.src = imageUrl;
      art.alt = labels[imageKey];
    }
    if (next === 'compare') comparison.src = urls.get('sketch');
    if (next === 'video' && clip.getAttribute('src') !== urls.get('video')) clip.src = urls.get('video');
    $('presentEmpty').hidden = Boolean(next);
    $('presentStale').hidden = !effect || !['effect','compare'].includes(next) || effect.sourceStamp === board.sceneStamp(scene);
    $('presentReselect').hidden = $('presentStale').hidden;
    motionButton.hidden = !['sketch','effect'].includes(next);
    exportButton.disabled = !imageUrl || next === 'compare';
    for (const button of thumbnails.children) button.setAttribute('aria-pressed',String(button.dataset.view === next));
  }

  function makeThumb(key) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'show-thumb';
    button.dataset.view = key;
    if (['sketch','effect'].includes(key)) {
      const thumb = new Image();
      thumb.src = urls.get(key);
      thumb.alt = '';
      button.append(thumb);
    }
    button.append(document.createTextNode(labels[key]));
    button.onclick = () => select(key);
    return button;
  }

  function refreshThumbs() {
    const available = ['sketch','effect','compare','video'].filter(key => key === 'compare'
      ? urls.has('sketch') && urls.has('effect') : urls.has(key));
    thumbnails.replaceChildren(...available.map(makeThumb));
  }

  motionButton.onclick = () => {
    if (motion) {stopMotion(); return;}
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    motion = art.animate(reduced ? [{opacity:.65},{opacity:1}] : [
      {transform:'translate(-.6%,.3%) scale(1.002)'}, {transform:'translate(.5%,-.4%) scale(1.10)'}
    ],{duration:reduced ? 600 : 3000,easing:'cubic-bezier(.2,.7,.3,1)'});
    motion.onfinish = stopMotion;
    motionButton.setAttribute('aria-pressed','true');
    motionButton.textContent = '停止镜头';
  };

  attach.onclick = () => videoInput.click();
  videoInput.onchange = async () => {
    const file = videoInput.files[0];
    videoInput.value = '';
    if (!file) return;
    if (file.size > 64*1024*1024 || !['video/mp4','video/webm'].includes(file.type) || !clip.canPlayType(file.type)) {
      status.textContent = '请选择 64 MB 以内、当前浏览器支持的 MP4 或 WebM 视频。';
      return;
    }
    attach.disabled = true;
    try {
      await projects.saveVideo(id,scene.id,file);
      setAsset('video',file);
      attach.textContent = '更换视频';
      refreshThumbs();
      select('video');
      status.textContent = '视频已保存在此稿件。';
    } catch (error) {status.textContent = error.message;}
    finally {attach.disabled = false;}
  };
  clip.addEventListener('error', () => {
    if (view === 'video') status.textContent = '视频无法播放，请换用浏览器支持的编码。';
  });

  exportButton.onclick = async () => {
    exportButton.disabled = true;
    const current = art.src;
    try {
      const image = new Image();
      image.src = current;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1600,image.naturalWidth);
      canvas.height = Math.max(1,Math.round(canvas.width * image.naturalHeight / image.naturalWidth));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f5f2e9';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const png = await new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('导出失败。')),'image/png'));
      const link = document.createElement('a');
      link.href = URL.createObjectURL(png);
      link.download = scene.title + '.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href),1000);
      status.textContent = 'PNG 已导出。';
    } catch (error) {status.textContent = error.message;}
    finally {exportButton.disabled = !['sketch','effect'].includes(view);}
  };

  async function load() {
    if (!scene) return;
    if (scene.curve || scene.ink.length || scene.underlay) {
      const sketch = graph.lineSvg(scene,rules,core,'presentation-sketch',1.25);
      setAsset('sketch',new Blob([sketch],{type:'image/svg+xml;charset=utf-8'}));
    }
    const [image,video] = await Promise.allSettled([
      effect ? projects.getPresentation(id,effect.slot) : null,
      projects.getVideo(id,scene.id)
    ]);
    if (image.status === 'fulfilled' && image.value) setAsset('effect',image.value);
    if (video.status === 'fulfilled' && video.value) {
      setAsset('video',video.value);
      attach.textContent = '更换视频';
    }
    attach.hidden = false;
    refreshThumbs();
    select(urls.has('effect') ? 'effect' : urls.has('sketch') ? 'sketch' : urls.has('video') ? 'video' : '');
  }

  load().catch(error => {status.textContent = error.message;});
  window.addEventListener('pagehide', event => {
    if (!event.persisted) for (const src of urls.values()) URL.revokeObjectURL(src);
  });
})();
