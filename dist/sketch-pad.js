// 快速草图浮层：工作台内直接起稿，不必跳出到图像编辑室。
// 画笔与橡皮各有独立的尺寸滑杆（切换工具时高亮对应入口，两个数值互不影响）。
(() => {
  'use strict';

  const state = {
    open: false,
    width: 1024,
    height: 768,
    tool: 'brush',
    strokes: [],
    draft: null,
    onSave: null,
    resolve: null,
    brushSize: 6,
    eraseSize: 30,
    color: '#202020',
    undo: []
  };

  let root, canvas, ctx, statusNode, bar, lastPoint = null, drawing = false;

  const unit = value => Math.round(value * 10000) / 10000;

  function paint() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineJoin = ctx.lineCap = 'round';
    const all = state.draft ? [...state.strokes, state.draft] : state.strokes;
    for (const stroke of all) drawStroke(stroke);
  }

  function drawStroke(stroke) {
    const points = stroke.points || [];
    if (!points.length) return;
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.erase ? '#000' : stroke.color || '#202020';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(.5, Number(stroke.size) || 4);
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x * canvas.width, points[0].y * canvas.height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
    }
    ctx.stroke();
  }

  function activeSize() {
    return state.tool === 'erase' ? state.eraseSize : state.brushSize;
  }

  function pointOf(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: unit(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))),
      y: unit(Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)))
    };
  }

  function say(text, error = false) {
    if (!statusNode) return;
    statusNode.textContent = text || '';
    statusNode.dataset.error = String(error);
  }

  function syncTool() {
    for (const button of root.querySelectorAll('[data-pad-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.padTool === state.tool));
    }
    // 两个尺寸入口常驻显示，但当前工具对应的那个高亮，避免混用同一个数值
    root.querySelector('#padBrushField')?.classList.toggle('is-active', state.tool === 'brush');
    root.querySelector('#padEraseField')?.classList.toggle('is-active', state.tool === 'erase');
    canvas.dataset.tool = state.tool;
  }

  function pushUndo() {
    state.undo.push({ count: state.strokes.length });
    if (state.undo.length > 60) state.undo.shift();
  }

  function bind() {
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !state.open) return;
      canvas.setPointerCapture(event.pointerId);
      drawing = true;
      pushUndo();
      lastPoint = pointOf(event);
      state.draft = { points: [lastPoint], size: activeSize(), color: state.color, erase: state.tool === 'erase' };
      paint();
    });
    canvas.addEventListener('pointermove', event => {
      if (!drawing || !state.draft) return;
      const next = pointOf(event);
      if (lastPoint && Math.hypot(next.x - lastPoint.x, next.y - lastPoint.y) < .0012) return;
      state.draft.points.push(next);
      lastPoint = next;
      paint();
    });
    const finish = event => {
      if (!drawing) return;
      drawing = false;
      if (state.draft && state.draft.points.length) state.strokes.push(state.draft);
      state.draft = null;
      lastPoint = null;
      paint();
      say(state.strokes.length ? '已画 ' + state.strokes.length + ' 笔' : '');
      try { canvas.releasePointerCapture(event.pointerId); } catch {}
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    for (const button of root.querySelectorAll('[data-pad-tool]')) {
      button.addEventListener('click', () => { state.tool = button.dataset.padTool; syncTool(); });
    }
    const brush = root.querySelector('#padBrushSize');
    const erase = root.querySelector('#padEraseSize');
    brush.addEventListener('input', () => {
      state.brushSize = Number(brush.value);
      root.querySelector('#padBrushSizeValue').textContent = brush.value + ' px';
    });
    erase.addEventListener('input', () => {
      state.eraseSize = Number(erase.value);
      root.querySelector('#padEraseSizeValue').textContent = erase.value + ' px';
    });
    root.querySelector('#padColor').addEventListener('input', event => { state.color = event.target.value; });
    root.querySelector('#padUndo').addEventListener('click', () => {
      const snapshot = state.undo.pop();
      if (!snapshot) { say('没有可撤销的笔迹。', true); return; }
      state.strokes = state.strokes.slice(0, snapshot.count);
      paint();
      say(state.strokes.length ? '已撤销，剩 ' + state.strokes.length + ' 笔' : '画布已清空');
    });
    root.querySelector('#padCancel').addEventListener('click', () => close(null));
    root.querySelector('#padSave').addEventListener('click', () => {
      if (!state.strokes.length) { say('还没有笔迹，先画几笔。', true); return; }
      close(state.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => ({ ...point })) })));
    });
    document.addEventListener('keydown', event => {
      if (!state.open) return;
      if (event.key === 'Escape') { event.preventDefault(); close(null); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        root.querySelector('#padUndo').click();
      }
    });
  }

  function close(strokes) {
    if (!state.open) return;
    state.open = false;
    root.hidden = true;
    const resolve = state.resolve;
    const onSave = state.onSave;
    state.resolve = null;
    state.onSave = null;
    state.strokes = [];
    state.draft = null;
    state.undo = [];
    if (strokes && strokes.length) onSave?.(strokes);
    resolve?.(strokes);
  }

  // 返回 Promise：完成时给出笔迹数组，取消时为 null
  function open(options = {}) {
    root = root || document.getElementById('sketchPad');
    if (!root) return Promise.resolve(null);
    canvas = root.querySelector('#padCanvas');
    ctx = canvas.getContext('2d');
    statusNode = root.querySelector('#padStatus');
    bar = root.querySelector('.sketch-pad-bar');
    state.width = Math.round(options.width) || 1024;
    state.height = Math.round(options.height) || 768;
    canvas.width = state.width;
    canvas.height = state.height;
    canvas.style.aspectRatio = state.width + '/' + state.height;
    state.tool = 'brush';
    state.strokes = [];
    state.draft = null;
    state.undo = [];
    state.onSave = options.onSave || null;
    state.open = true;
    root.hidden = false;
    root.dataset.title = options.title || '';
    syncTool();
    paint();
    say('画笔 ' + state.brushSize + ' px · 橡皮 ' + state.eraseSize + ' px');
    if (!root.dataset.bound) { root.dataset.bound = '1'; bind(); }
    return new Promise(resolve => { state.resolve = resolve; });
  }

  window.WuyingSketchPad = { open, close, state };
})();
