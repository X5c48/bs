(() => {
  'use strict';

  const workbench = window.WuyingWorkbench;
  const board = workbench?.board, rules = window.WuyingSketchRules;
  if (!board || !rules) return;
  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  const stage = $('stage'), shell = document.querySelector('.app-shell');
  const history = $('sketchHistory'), anchorChoice = $('anchorChoice');
  const tray = $('candidateTray'), candidateGrid = $('candidateGrid');
  const normalStatus = '最多给出 3 份通过轮廓检查的候选。';
  const handHelp = '从高亮曲线的任一端点画到另一端，松开后预览。端点会自动吸附。';
  const problems = {
    open: '请先选中一份闭合草稿。钢笔起稿后可点回起点闭合。',
    locked: '所有锚点都已固定。解除一部分固定后再试。',
    crossing: '轮廓有交叉或折回。调整笔迹或锚点后再试。',
    degenerate: '轮廓太窄或局部重叠。拉开锚点后再试。',
    complex: '轮廓锚点过多。可先另起一份更简单的草稿。',
    unchanged: '这次改动与原轮廓太接近。可以加大幅度或选另一段。',
    candidate: '这组幅度没有得到合格的轮廓。缩小幅度后再试。',
    pinned: '这段已固定。请选择另一段或解除固定。',
    endpoint: '笔迹没有接到另一端。请从高亮段的一端画到另一端。',
    short: '笔迹太短。请按住画笔，从一端连续画到另一端。',
    invalid: '这份草稿暂时无法处理。可尝试从新的轮廓起稿。'
  };

  let activeBatch = null, drawnPreview = null, historyKey = '', anchorKey = '';
  const label = i => 'P' + String(i + 1).padStart(2, '0');
  const svgEl = (tag, attributes) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = value;
    if (className) el.className = className;
    return el;
  };

  function viewBox(boxes) {
    const left = Math.min(...boxes.map(box => box.x));
    const top = Math.min(...boxes.map(box => box.y));
    const width = Math.max(...boxes.map(box => box.x + box.width)) - left;
    const height = Math.max(...boxes.map(box => box.y + box.height)) - top;
    const pad = Math.max(width, height, 20) * .075;
    return [left - pad, top - pad, width + 2 * pad, height + 2 * pad].join(' ');
  }

  function thumbnail(box, paths) {
    const image = svgEl('svg', { viewBox: box, 'aria-hidden': 'true', focusable: 'false' });
    for (const [path, style] of paths) image.append(svgEl('path', { d: path, class: style }));
    return image;
  }

  function renderHistory(state) {
    const key = JSON.stringify(state.sketches);
    if (key !== historyKey) {
      historyKey = key;
      const titles = new Map(state.sketches.map(sketch => [sketch.id, sketch.title]));
      history.replaceChildren();
      for (const sketch of state.sketches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sketch-file';
        button.dataset.sketchId = sketch.id;
        if (sketch.kind) button.classList.add('is-revision');
        const thumb = document.createElement('span');
        thumb.className = 'sketch-file-thumb';
        thumb.append(thumbnail(viewBox([sketch.bounds]), [[sketch.path+' '+sketch.inkPath, 'mini-outline']]));
        const meta = document.createElement('span');
        const type = sketch.kind === 'hand' ? '手绘改线' : sketch.kind === 'rules' ? '规则推演' :
          sketch.closed ? '基础稿' : sketch.blank ? '自由草稿' : '开放曲线';
        const parent = titles.get(sketch.parentId);
        meta.append(text('strong', sketch.title), text('small', sketch.edited ? type + ' · 已手改' : type));
        if (parent) meta.append(text('small', '来自 ' + parent, 'parent-name'));
        button.append(thumb, meta);
        history.append(button);
      }
      if (!state.sketches.length) history.append(text('p', '新建一份草稿后，可以在这里切换修改稿。', 'history-empty'));
    }
    for (const button of history.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.sketchId === state.curve?.id));
    }
  }

  function renderAnchor(state) {
    const { curve, anchor } = state;
    $('pinControls').disabled = !curve?.nodes.length || state.tool === 'pen';
    if (!curve?.nodes.length) {
      if (anchorKey) anchorChoice.replaceChildren();
      anchorKey = '';
      $('pinAnchor').setAttribute('aria-pressed', 'false');
      $('pinSegment').setAttribute('aria-pressed', 'false');
      $('pinAnchor').querySelector('span').textContent = '固定此点';
      $('pinSegment').querySelector('span').textContent = '固定下一段';
      $('pinNote').textContent = '选中草稿的锚点后可以固定点或曲线段。';
      return false;
    }
    const pins = rules.pinSpec(curve), locked = rules.lockedIndices(curve);
    const key = [curve.id, curve.nodes.length, [...locked].join(',')].join('|');
    if (key !== anchorKey) {
      anchorKey = key;
      anchorChoice.replaceChildren(...curve.nodes.map((_, i) =>
        new Option(label(i) + (locked.has(i) ? ' · 已固定' : ''), String(i))));
    }
    anchorChoice.value = String(anchor);
    const hasNext = curve.closed || anchor < curve.nodes.length - 1;
    const isPin = pins.anchors.includes(anchor), isEdge = pins.segments.includes(anchor);
    $('pinAnchor').setAttribute('aria-pressed', String(isPin));
    $('pinSegment').setAttribute('aria-pressed', String(isEdge));
    $('pinAnchor').querySelector('span').textContent = isPin ? '解除此点' : '固定此点';
    $('pinSegment').querySelector('span').textContent = isEdge ? '解除此段' : '固定下一段';
    $('pinSegment').disabled = !hasNext;
    $('pinNote').textContent = locked.size
      ? locked.size + ' 个锚点受保护 · ' + pins.segments.length + ' 段固定'
      : '固定一段会保留两端和曲线手柄。';
    return isEdge;
  }

  function setOverlay(candidate) {
    if (drawnPreview === candidate) return;
    drawnPreview = candidate;
    board.setPreview(candidate);
  }

  function clearBatch(message) {
    activeBatch = null;
    setOverlay(null);
    tray.hidden = true;
    if (message) $('ruleStatus').textContent = message;
  }

  function render() {
    const state = board.sketchState();
    const { curve, anchor, tool, hand } = state;
    const handMode = tool === 'redraw';
    if(handMode)$('vectorTools').open=true;
    const isBoard = stage.dataset.view === 'board';
    if (handMode && shell.dataset.panel !== 'derive' && isBoard) {
      workbench.setPanel('derive');
      return;
    }
    renderHistory(state);
    const fixedSegment = renderAnchor(state);
    const closed = !!curve?.closed;
    const curveStatus = closed ? curve.nodes.length + ' 个锚点 · 闭合轮廓' :
      curve?.blank ? (curve.ink?.length||0)+' 笔 · 自由画板' :
      curve ? '开放曲线 · 可以调整锚点' : '新建基础稿，或用钢笔画一个闭合轮廓';
    $('sourceTitle').textContent = curve?.title || '请选择一份草稿';
    $('sourceDetail').textContent = curveStatus;
    $('sheetLabel').hidden = !isBoard || !curve;
    if (curve) {
      $('sheetTitle').textContent = curve.title;
      $('sheetTag').textContent = closed ? '矢量草稿' : curve.blank ? '自由画板' : '开放曲线';
    }
    if (isBoard) {
      $('linkState').textContent = handMode ? '手绘改线 · 笔迹转成曲线' : '节点连线 · 实时预览';
      $('dimensionReadout').textContent = curve ? curveStatus : '';
    }
    $('ruleMode').setAttribute('aria-pressed', String(!handMode));
    $('handMode').setAttribute('aria-pressed', String(handMode));
    $('handMode').disabled = !closed;
    $('ruleOptions').hidden = handMode;
    $('handOptions').hidden = !handMode;
    $('generateSketch').disabled = !closed;
    $('renderFromSketch').disabled = !curve || !(curve.nodes.length || curve.ink?.length || curve.underlay);
    if (handMode) {
      $('handTarget').textContent = closed
        ? '重画 ' + label(anchor) + ' → ' + label((anchor + 1) % curve.nodes.length)
        : '请选择闭合草稿';
      $('handStatus').textContent = hand?.ready ? '笔迹已转成可编辑曲线。确认后会另存为修改稿。' :
        problems[hand?.reason] || (fixedSegment ? problems.pinned : handHelp);
      $('saveHand').disabled = !hand?.ready;
      $('clearHand').disabled = !hand;
    }
    if (activeBatch && (!curve || ['redraw','pen','depth'].includes(tool) || rules.sketchKey(curve) !== activeBatch.key)) {
      clearBatch('草稿或编辑方式已调整，可以重新生成。');
    }
    if (activeBatch) {
      const show = isBoard && (shell.dataset.panel === 'derive' ||
        (shell.dataset.panel === 'iterate' && shell.dataset.iteration === 'form'));
      tray.hidden = !show;
      setOverlay(show ? activeBatch.candidates[activeBatch.selected] : null);
    }
    stage.classList.toggle('is-comparing', !tray.hidden || !!hand?.ready);
  }

  function renderCards(batch, source) {
    const path = rules.pathData(source);
    const box = viewBox([rules.controlBounds(source), ...batch.candidates.map(rules.controlBounds)]);
    candidateGrid.replaceChildren();
    batch.candidates.forEach((candidate, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.dataset.candidate = String(i);
      const caption = document.createElement('span');
      caption.append(text('strong', '候选 ' + String(i + 1).padStart(2, '0')));
      const value = candidate.widthChange;
      caption.append(text('small', Math.abs(value) < .05 ? '宽度基本不变' :
        '宽度 ' + (value > 0 ? '+' : '−') + Math.abs(value).toFixed(1) + '%'));
      card.append(thumbnail(box, [[path, 'mini-source'], [rules.pathData(candidate), 'mini-candidate']]), caption);
      candidateGrid.append(card);
    });
    $('candidateCount').textContent = batch.candidates.length + ' 份';
  }

  function selectCandidate(index) {
    if (!activeBatch?.candidates[index]) return;
    activeBatch.selected = index;
    for (const card of candidateGrid.querySelectorAll('button')) {
      card.setAttribute('aria-pressed', String(Number(card.dataset.candidate) === index));
    }
    render();
  }

  function generate() {
    const { curve } = board.sketchState();
    if (!curve) return;
    const result = rules.generate(curve, {
      direction: document.querySelector('input[name="sketchDirection"]:checked').value,
      width: $('sketchWidth').value, bend: $('sketchBend').value
    });
    if (!result.candidates.length) {
      clearBatch(problems[result.reason] || problems.invalid);
      render();
      return;
    }
    activeBatch = { key: rules.sketchKey(curve), candidates: result.candidates, selected: 0 };
    $('ruleStatus').textContent = result.candidates.length + ' 份候选通过检查，已保留固定部分。';
    renderCards(activeBatch, curve);
    selectCandidate(0);
    if (matchMedia('(max-width: 760px)').matches) tray.scrollIntoView({ block: 'nearest' });
  }

  history.addEventListener('click', event => {
    const button = event.target.closest('[data-sketch-id]');
    if (!button) return;
    workbench.setPanel('derive');
    board.openCurve(button.dataset.sketchId);
    history.querySelector('[aria-pressed="true"]')?.focus();
  });
  $('baseLaunch').addEventListener('click', event => {
    const button = event.target.closest('[data-base-profile], #startPen, #startBlank');
    if (!button) return;
    workbench.setPanel('derive');
    if (button.dataset.baseProfile) board.addBase(button.dataset.baseProfile);
    else if(button.id==='startBlank'){board.addBlank();$('freeBoard').focus({preventScroll:true});}
    else {
      board.setTool('pen');
      $('freeBoard').focus();
    }
    $('baseLaunch').open = false;
  });
  anchorChoice.addEventListener('change', () => board.pickAnchor(Number(anchorChoice.value)));
  $('pinAnchor').addEventListener('click', () => board.togglePin('anchors'));
  $('pinSegment').addEventListener('click', () => board.togglePin('segments'));
  $('ruleMode').addEventListener('click', () => board.setTool('select'));
  $('handMode').addEventListener('click', () => {
    board.setTool('redraw');
    if (matchMedia('(max-width: 760px)').matches) stage.scrollIntoView({ block: 'nearest' });
  });
  $('saveHand').addEventListener('click', () => {
    if (board.acceptHand()) $('ruleStatus').textContent = '已另存手绘修改稿。可以继续拖点或生成候选。';
  });
  $('clearHand').addEventListener('click', board.clearHand);
  $('renderFromSketch').addEventListener('click', () => workbench.setPanel('generate'));
  $('ruleOptions').addEventListener('input', () => {
    $('widthValue').textContent = $('sketchWidth').value + '%';
    $('bendValue').textContent = $('sketchBend').value + '%';
    if (activeBatch) clearBatch('已改动幅度或方向，请重新生成。');
    else $('ruleStatus').textContent = normalStatus;
    render();
  });
  $('generateSketch').addEventListener('click', generate);
  candidateGrid.addEventListener('click', event => {
    const button = event.target.closest('[data-candidate]');
    if (button) selectCandidate(Number(button.dataset.candidate));
  });
  $('keepCandidate').addEventListener('click', () => {
    if (!activeBatch) return;
    const { candidates, selected, key } = activeBatch;
    if (board.saveVersion(candidates[selected], key, 'rules')) {
      clearBatch('已另存修改稿。可以继续调整或用于出图。');
      render();
    }
  });
  $('closeCandidates').addEventListener('click', () => { clearBatch(normalStatus); render(); });
  if (workbench.demo) {
    $('demoGuide').hidden = false;
    $('demoLink').textContent = '回到工作台';
    $('demoLink').href = location.pathname;
  }
  window.addEventListener('sketchstatechange', render);
  render();
})();
