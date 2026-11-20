(() => {
  'use strict';

  const workbench = window.WuyingWorkbench;
  const board = workbench?.board;
  const studio = window.WuyingStudioCore, rules = window.WuyingSketchRules, zip = window.WuyingOpenDrawing;
  if (!board || !studio || !zip) return;

  const mimetype = 'image/openraster';
  const maxArchive = 32 * 1024 * 1024;
  const maxUnderlay = 15 * 1024 * 1024;
  const menu = document.getElementById('kritaActions');
  const input = document.getElementById('oraFile');
  const importButton = document.getElementById('importOra');
  const exportButton = document.getElementById('exportOra');
  let busy = false;

  async function flattenedLayer(file) {
    if (file.size > maxArchive) throw new Error('请选择 32 MB 以内的 OpenRaster 文件');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const files = zip.unzipSync(bytes, { filter(entry) {
      if (entry.name === 'mimetype') return entry.originalSize === mimetype.length;
      if (entry.name !== 'mergedimage.png') return false;
      if (entry.originalSize > maxUnderlay) throw new Error('合成图超过 15 MB，请在 Krita 缩小画布后重新导出');
      return true;
    } });
    const merged = files['mergedimage.png'];
    if (!files.mimetype || zip.strFromU8(files.mimetype) !== mimetype || !merged || merged.length < 24) {
      throw new Error('这个 .ora 文件缺少可用的合成图');
    }
    const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
        !width || !height || width * height > 32_000_000) {
      throw new Error('请选择包含有效 PNG 合成图且小于 3200 万像素的 .ora');
    }
    return new Blob([merged], { type: 'image/png' });
  }

  function canvas(width, height) {
    const sheet = document.createElement('canvas');
    sheet.width = width;
    sheet.height = height;
    return sheet;
  }

  async function bitmap(svg, width, height) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const layer = canvas(width, height);
      layer.getContext('2d').drawImage(image, 0, 0, width, height);
      return layer;
    } finally { URL.revokeObjectURL(url); }
  }

  async function png(layer) {
    const blob = await new Promise(resolve => layer.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('画布无法导出 PNG');
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function archive(scene) {
    const ratio = 1.38, width = 1280, height = Math.round(width / ratio);
    const side = studio.depthMarkup(scene, rules, { id: 'ora-depth' });
    const frame = side ? board.captureComposition(scene, { width, height }) : studio.frameFor(scene, rules, ratio);
    const { tone, light } = workbench.currentTone();
    const svg = markup => '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
      '" height="' + height + '" viewBox="' + frame.join(' ') + '">' + markup + '</svg>';
    const withoutInk = { ...scene, ink: [], depth: null };
    const layers = [];
    if (scene.ink.length) layers.push({ name: '自由笔迹', opacity: 1, svg: svg(studio.inkMarkup(scene.ink)) });
    if (scene.curve) layers.push({ name: '轮廓线稿', opacity: 1,
      svg: svg(studio.lineMarkup({ ...withoutInk, underlay: null }, rules, { id: 'ora-line' })) });
    if (side) layers.push({ name: '厚度侧面', opacity: 1, svg: svg(side) });
    if (scene.underlay) layers.push({ name: '导入底稿', opacity: .64, svg: svg(studio.underlayMarkup(scene.underlay, { opacity: 1 })) });
    layers.push({ name: '本地上色', opacity: 1, svg: studio.renderSvg({
      ...withoutInk, frame, form: studio.closedOutline(scene, rules)
    }, rules, { id: 'ora-color', style: 'material', tone, light, ratio, underlayLines: false, outline: false }) });

    const images = await Promise.all(layers.map(layer => bitmap(layer.svg, width, height)));
    const merged = canvas(width, height), ctx = merged.getContext('2d');
    for (let index = images.length - 1; index >= 0; index--) {
      ctx.globalAlpha = layers[index].opacity;
      ctx.drawImage(images[index], 0, 0);
    }
    const thumbnail = canvas(256, Math.round(256 * height / width));
    thumbnail.getContext('2d').drawImage(merged, 0, 0, thumbnail.width, thumbnail.height);
    const pngs = await Promise.all([png(merged), png(thumbnail), ...images.map(png)]);
    const stack = '<image version="0.0.3" w="' + width + '" h="' + height + '" name="物映草稿"><stack>' +
      layers.map((layer, index) => '<layer name="' + layer.name + '" src="data/layer' + index +
        '.png" x="0" y="0" opacity="' + layer.opacity + '" visibility="visible" composite-op="svg:src-over"/>').join('') +
      '</stack></image>';
    const files = { mimetype: [zip.strToU8(mimetype), { level: 0 }], 'stack.xml': zip.strToU8(stack),
      'mergedimage.png': pngs[0], 'Thumbnails/thumbnail.png': pngs[1] };
    layers.forEach((_, i) => { files['data/layer' + i + '.png'] = pngs[i + 2]; });
    return new Blob([zip.zipSync(files, { level: 0 })], { type: mimetype });
  }

  function setBusy(value) {
    busy = value;
    importButton.disabled = exportButton.disabled = value;
  }

  importButton.onclick = () => { menu.open = false; input.click(); };
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
      const merged = await flattenedLayer(file);
      workbench.showBoard();
      const draft = board.addBlank();
      if (!draft) throw new Error('无法新建草稿，请检查画布项目数量');
      if (await board.importUnderlay(merged, draft.id)) {
        const following = workbench.graph.linkedDocumentId() === draft.id;
        workbench.toast(following ? '已导入新草图 · 右侧同步预览' : '已导入新草图 · 点「预览此稿」查看效果');
      }
    } catch (error) {
      workbench.toast(/^[\u3400-\u9fff]/.test(error.message) ? error.message : '无法读取这个 .ora 文件');
    } finally { setBusy(false); }
  };
  exportButton.onclick = async () => {
    if (busy) return;
    menu.open = false;
    const scene = board.sceneState({ drafts: false });
    if (!scene.curve && !scene.ink.length && !scene.underlay) { workbench.toast('先画几笔或导入底稿'); return; }
    setBusy(true);
    try {
      const result = await archive(structuredClone(scene));
      workbench.download(result, '物映-' + scene.title + '.ora');
      workbench.toast('已导出分层 .ora，可以在 Krita 打开');
    } catch { workbench.toast('暂时无法导出 .ora'); }
    finally { setBusy(false); }
  };
  document.addEventListener('click', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu.open = false; menu.querySelector('summary').focus(); }
  });
})();
