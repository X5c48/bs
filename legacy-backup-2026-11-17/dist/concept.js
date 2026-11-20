(() => {
  'use strict';

  const store = window.WuyingProjects;
  const geometry = window.WuyingConceptGeometry;
  const rules = window.WuyingSketchRules;
  const $ = id => document.getElementById(id);
  const projectId = store?.idFromLocation();
  const backend = 'http://127.0.0.1:8882/api/concept-suggestions';
  const briefLabels = {
    product: '设计什么',
    scenario: '使用者与场景',
    goal: '希望解决的问题',
    constraints: '必须满足的条件',
    referenceNotes: '参考说明'
  };
  const briefFields = Object.keys(briefLabels);
  const letters = ['A', 'B', 'C'];

  let project;
  try {
    project = projectId && store.get(projectId);
  } catch {
    // The missing-project view also provides a way back when storage is unavailable.
  }
  if (!project) {
    $('unavailable-project').hidden = false;
    return;
  }

  let saveTimer;
  let reviewed = null;
  let activeRequest;
  let generating = false;
  let compared = [];
  let referenceUrl = '';

  const projectQuery = '?project=' + encodeURIComponent(project.id);
  const editorUrl = 'index.html' + projectQuery;
  const form = $('brief-form');
  const generate = $('generate-concepts');

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function status(id, message, error = false) {
    const node = $(id);
    node.textContent = message;
    node.classList.toggle('is-error', error);
    node.hidden = !message;
  }

  function patch(fields) {
    const updated = store.update(project.id, fields);
    if (!updated) throw new Error('找不到这个项目。');
    project = updated;
  }

  function currentBrief() {
    return Object.fromEntries(briefFields.map(field => [field, $('brief-' + field).value.trim()]));
  }

  function saveBrief() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const brief = currentBrief();
    if (briefFields.every(field => brief[field] === project.brief[field])) return true;
    try {
      patch({ brief });
      $('brief-save-status').textContent = '已保存';
      return true;
    } catch {
      $('brief-save-status').textContent = '暂未保存';
      return false;
    }
  }

  function hideReview() {
    reviewed = null;
    $('request-review').hidden = true;
  }

  function sentBrief() {
    const brief = currentBrief();
    if (project.preferences.enabled && project.preferences.text.trim()) {
      const preference = '项目偏好\n' + project.preferences.text.trim();
      brief.referenceNotes = [brief.referenceNotes, preference].filter(Boolean).join('\n\n');
    }
    return brief;
  }

  function showReview(brief) {
    const descriptions = $('review-fields');
    descriptions.replaceChildren();
    for (const [field, label] of Object.entries(briefLabels)) {
      if (!brief[field]) continue;
      const row = element('div');
      row.append(element('dt', '', label), element('dd', '', brief[field]));
      descriptions.append(row);
    }
    reviewed = brief;
    $('request-review').hidden = false;
    $('review-title').focus();
  }

  function lineFigure(direction) {
    const figure = element('figure', 'shape-sheet');
    const pathData = direction.shape && rules?.pathData(direction.shape);
    if (!pathData) {
      figure.append(element('span', 'muted', '暂无线稿'));
      return figure;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 800 640');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', direction.name + '的轮廓线稿');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
    for (const [index, part] of (direction.parts || []).entries()) {
      const x = part.x * 800;
      const y = part.y * 640;
      const dot = document.createElementNS(svg.namespaceURI, 'circle');
      const number = document.createElementNS(svg.namespaceURI, 'text');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', '15');
      dot.setAttribute('class', 'part-pin');
      number.setAttribute('x', x);
      number.setAttribute('y', y);
      number.setAttribute('class', 'part-number');
      number.textContent = index + 1;
      svg.append(dot, number);
    }
    figure.append(svg);
    return figure;
  }

  function partLegend(parts) {
    const list = element('ol', 'part-legend');
    for (const part of parts || []) list.append(element('li', '', part.label));
    return list;
  }

  function adopt(direction) {
    if (!saveBrief()) {
      status('generation-status', '简报暂未保存，无法打开这条方向。', true);
      return;
    }
    location.assign(editorUrl + '&adopt=' + encodeURIComponent(direction.id) + '&take=' + crypto.randomUUID());
  }

  function directionCard(direction, index, forComparison = false) {
    const card = element('article', 'direction-card');
    card.dataset.direction = direction.id;
    const heading = element('div', 'direction-heading');
    heading.append(element('span', 'direction-letter', letters[index]), element('h3', '', direction.name));
    card.append(heading, lineFigure(direction), partLegend(direction.parts));

    const copy = element('dl', 'direction-copy');
    for (const [title, value] of [['设计思路', direction.reason], ['需要取舍', direction.tradeoff]]) {
      const row = element('div');
      row.append(element('dt', '', title), element('dd', '', value));
      copy.append(row);
    }
    const actions = element('div', 'direction-actions');
    if (!forComparison) {
      const compare = element('button', 'secondary-button', '加入对比');
      compare.type = 'button';
      compare.dataset.compare = direction.id;
      compare.setAttribute('aria-pressed', 'false');
      compare.setAttribute('aria-label', '加入对比 ' + direction.name);
      compare.onclick = () => selectCompare(direction.id);
      actions.append(compare);
    }
    const use = element('button', 'primary-button', '采用并继续画');
    use.type = 'button';
    use.dataset.adopt = direction.id;
    use.setAttribute('aria-label', '采用并继续画 ' + direction.name);
    use.onclick = () => adopt(direction);
    actions.append(use);
    card.append(copy, actions);
    return card;
  }

  function refreshComparison() {
    for (const button of $('directions-list').querySelectorAll('[data-compare]')) {
      const selected = compared.includes(button.dataset.compare);
      const direction = project.directions.find(item => item.id === button.dataset.compare);
      const action = selected ? '已加入对比' : '加入对比';
      button.textContent = action;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', action + ' ' + direction.name);
    }
    $('direction-count').textContent = compared.length
      ? '已选 ' + compared.length + ' / 2'
      : project.directions.length ? project.directions.length + ' 条方向' : '待探索';
    const selection = project.directions
      .map((direction, index) => ({ direction, index }))
      .filter(({ direction }) => compared.includes(direction.id));
    $('comparison').hidden = selection.length !== 2;
    $('comparison-list').replaceChildren(...(selection.length === 2
      ? selection.map(({ direction, index }) => directionCard(direction, index, true))
      : []));
  }

  function selectCompare(id) {
    if (compared.includes(id)) {
      compared = compared.filter(value => value !== id);
    } else {
      compared = [...compared.slice(-1), id];
    }
    refreshComparison();
  }

  function renderDirections() {
    const directions = project.directions;
    $('directions-empty').hidden = directions.length > 0 || generating;
    $('directions-list').replaceChildren(...directions.map((direction, index) => directionCard(direction, index)));
    refreshComparison();
  }

  async function generateDirections() {
    if (!reviewed || generating) return;
    if (!geometry || !rules) {
      status('generation-status', '草图工具未加载。刷新页面后重试，或手动进入画板。', true);
      return;
    }
    generating = true;
    const brief = reviewed;
    generate.disabled = true;
    $('review-summary').disabled = true;
    $('direction-loading').hidden = false;
    $('directions-empty').hidden = true;
    $('directions').setAttribute('aria-busy', 'true');
    status('generation-status', '正在根据简报整理三条方向。');
    const controller = new AbortController();
    activeRequest = controller;
    const deadline = setTimeout(() => controller.abort(), 65000);
    try {
      let response;
      try {
        response = await fetch(backend, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief }),
          signal: controller.signal,
          redirect: 'error'
        });
      } catch (error) {
        throw new Error(error.name === 'AbortError'
          ? '设计助手响应超时。可以重试，也可以手动进入画板。'
          : '连接不到本机出图后台。请启动后台，或手动进入画板。');
      }
      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof raw?.error === 'string' ? raw.error : '设计助手暂时无法生成，请稍后重试。');
      }
      let valid;
      try {
        valid = geometry.validate(raw, rules);
        if (valid.length !== 3) throw new Error('expected three directions');
      } catch {
        throw new Error('这次返回的线稿无法编辑。请重试，原方向已保留。');
      }
      const directions = valid.map(direction => ({ ...direction, id: crypto.randomUUID() }));
      try {
        patch({ directions });
      } catch {
        throw new Error('暂时无法保存这组方向。请检查浏览器是否允许本地存储。');
      }
      compared = [];
      hideReview();
      renderDirections();
      status('generation-status', '三条方向已保存。选两条可并排比较。');
    } catch (error) {
      status('generation-status', error.message, true);
    } finally {
      clearTimeout(deadline);
      if (activeRequest === controller) activeRequest = null;
      generating = false;
      generate.disabled = false;
      $('review-summary').disabled = false;
      $('direction-loading').hidden = true;
      $('directions-empty').hidden = project.directions.length > 0;
      $('directions').setAttribute('aria-busy', 'false');
    }
  }

  function showReference(file) {
    if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    referenceUrl = file ? URL.createObjectURL(file) : '';
    const img = $('reference-image');
    if (file) img.src = referenceUrl;
    else img.removeAttribute('src');
    $('reference-name').textContent = file?.name || '项目参考图';
    $('reference-preview').hidden = !file;
  }

  async function loadReference() {
    const input = $('reference-input');
    input.disabled = true;
    try {
      showReference(await store.getReference(project.id));
    } catch {
      status('reference-status', '暂时无法读取参考图。', true);
    } finally {
      input.disabled = false;
    }
  }

  async function changeReference(file) {
    const input = $('reference-input');
    const remove = $('reference-remove');
    input.disabled = remove.disabled = true;
    try {
      if (file) await store.saveReference(project.id, file);
      else await store.deleteReference(project.id);
      showReference(file);
      status('reference-status', file ? '参考图已保存在本机。' : '已移除参考图。');
    } catch {
      status('reference-status', '暂时无法保存参考图，请稍后重试。', true);
    } finally {
      input.value = '';
      input.disabled = remove.disabled = false;
    }
  }

  function renderNotes() {
    const notes = $('project-notes');
    notes.replaceChildren();
    for (const note of project.notes) {
      const row = element('li');
      const remove = element('button', 'text-button', '移除');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除笔记 ' + note.text.slice(0, 22));
      remove.onclick = () => {
        try {
          patch({ notes: project.notes.filter(item => item.id !== note.id) });
          renderNotes();
          status('notes-status', '已移除笔记。');
        } catch {
          status('notes-status', '暂时无法移除笔记。', true);
        }
      };
      row.append(element('p', '', note.text), remove);
      notes.append(row);
    }
  }

  $('concept-project-name').textContent = project.name;
  document.title = project.name + ' · 物映';
  $('concept-workspace').hidden = false;
  $('manual-editor').href = editorUrl;
  $('manual-editor').onclick = event => {
    if (saveBrief()) return;
    event.preventDefault();
    status('generation-status', '简报暂未保存，请检查浏览器的存储设置。', true);
  };
  $('image-board-link').href = 'image-board.html' + projectQuery;
  $('image-board-link').hidden = false;
  $('presentation-link').href = 'presentation.html' + projectQuery;
  $('presentation-link').hidden = false;

  for (const field of briefFields) $('brief-' + field).value = project.brief[field];
  form.oninput = () => {
    if (reviewed) hideReview();
    $('brief-save-status').textContent = '正在保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBrief, 400);
  };
  form.onsubmit = event => {
    event.preventDefault();
    const brief = currentBrief();
    const missing = ['product', 'scenario', 'goal'].find(field => !brief[field]);
    if (missing) {
      $('brief-' + missing).focus();
      status('generation-status', '请填写' + briefLabels[missing] + '。', true);
      return;
    }
    if (!saveBrief()) {
      status('generation-status', '简报暂未保存，请检查浏览器的存储设置。', true);
      return;
    }
    status('generation-status', '');
    showReview(sentBrief());
  };
  $('edit-summary').onclick = () => {
    hideReview();
    $('brief-product').focus();
  };
  generate.onclick = generateDirections;
  $('clear-comparison').onclick = () => {
    compared = [];
    refreshComparison();
    $('directions-list').querySelector('[data-compare]')?.focus();
  };
  $('reference-input').onchange = event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      event.target.value = '';
      status('reference-status', '请选择 8 MB 以内的 JPG、PNG 或 WebP 图片。', true);
      return;
    }
    changeReference(file);
  };
  $('reference-remove').onclick = () => changeReference(null);
  $('project-note-form').onsubmit = event => {
    event.preventDefault();
    const input = $('project-note');
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    try {
      patch({ notes: [...project.notes, { id: crypto.randomUUID(), text: value, createdAt: Date.now() }] });
      input.value = '';
      renderNotes();
      status('notes-status', '笔记已保存在本机。');
    } catch {
      status('notes-status', '暂时无法保存笔记。', true);
    }
  };
  $('preferences-text').value = project.preferences.text;
  $('preferences-enabled').checked = project.preferences.enabled;
  $('preferences-form').onsubmit = event => {
    event.preventDefault();
    try {
      patch({ preferences: { enabled: $('preferences-enabled').checked, text: $('preferences-text').value.trim() } });
      if (reviewed) hideReview();
      status('notes-status', '已保存项目偏好。');
    } catch {
      status('notes-status', '暂时无法保存偏好。', true);
    }
  };
  window.addEventListener('pagehide', event => {
    if (saveTimer) saveBrief();
    activeRequest?.abort();
    if (referenceUrl && !event.persisted) URL.revokeObjectURL(referenceUrl);
  });
  renderDirections();
  renderNotes();
  loadReference();
})();
