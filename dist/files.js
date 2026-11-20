(function () {
  'use strict';

  const store = window.WuyingProjects;
  const workspace = window.WuyingWorkspace;
  const local = window.WuyingLocalWorkspace;
  const grid = document.getElementById('file-grid');
  const search = document.getElementById('file-search');
  const sort = document.getElementById('file-sort');
  const empty = document.getElementById('files-empty');
  const emptyTitle = document.getElementById('empty-title');
  const emptyDescription = document.getElementById('empty-description');
  const emptyAction = document.getElementById('empty-action');
  const feedback = document.getElementById('file-feedback');
  const newFile = document.getElementById('new-file');
  const dialog = document.getElementById('file-dialog');
  const title = document.getElementById('file-dialog-title');
  const form = document.getElementById('file-form');
  const nameInput = document.getElementById('file-name');
  const confirm = document.getElementById('confirm-file');
  const formError = document.getElementById('file-error');
  const exportFile = document.getElementById('export-file');
  const accountStatus = document.getElementById('account-status');
  const backupFile = document.getElementById('project-backup-file');
  const importFile = document.getElementById('import-backup');
  const legacySection = document.getElementById('legacy-projects');
  const legacyList = document.getElementById('legacy-list');
  const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  const compareNames = new Intl.Collator('zh-CN', { numeric: true }).compare;
  const imageUrls = new Set();
  let editing = null;
  let previousFocus = null;
  let coverVersion = 0;

  const fileLink = projectId => 'workbench.html?project=' + encodeURIComponent(projectId);

  function showFeedback(message) {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function showForm(project, trigger) {
    editing = project;
    previousFocus = trigger;
    title.textContent = project ? '重命名文件' : '新建文件';
    confirm.textContent = project ? '保存名称' : '创建文件';
    exportFile.hidden = !project;
    nameInput.required = Boolean(project);
    nameInput.value = project?.name || '';
    formError.hidden = true;
    dialog.showModal();
    nameInput.select();
  }

  function releaseCovers() {
    for (const url of imageUrls) URL.revokeObjectURL(url);
    imageUrls.clear();
  }

  async function readCover(project) {
    const file = workspace.open(project.id);
    const doc = await file.read();
    const assets = Object.values(doc.assets).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    for (const asset of assets) {
      const layers = Array.isArray(asset.layers) ? asset.layers : [];
      const image = [...layers].reverse().find(layer => layer.kind === 'image' && layer.visible !== false && layer.blobId);
      if (layers.some(layer => layer.kind === 'ink' && layer.visible !== false && layer.strokes?.length)) {
        return window.WuyingWorkspaceComposite.toPng(asset,file);
      }
      const blobId = asset.coverBlobId || asset.thumbnailBlobId || image?.blobId;
      if (!blobId) continue;
      const blob = await file.getBlob(blobId);
      if (blob?.type.startsWith('image/')) return blob;
    }
    const preview = project.presentation;
    if (preview?.slot) {
      const blob = await store.getPresentation(project.id, preview.slot);
      if (blob?.type.startsWith('image/')) return blob;
    }
    return null;
  }

  async function loadCover(card, project, version) {
    try {
      const blob = await readCover(project);
      if (!blob || version !== coverVersion || !card.isConnected) return;
      const img = document.createElement('img');
      img.alt = '';
      const url = URL.createObjectURL(blob);
      imageUrls.add(url);
      img.src = url;
      try {
        await img.decode();
        if (card.isConnected && version === coverVersion) card.replaceChildren(img);
      } catch {
        URL.revokeObjectURL(url);
        imageUrls.delete(url);
      }
    } catch {
      // A missing preview does not prevent opening the file.
    }
  }

  function updateDate(time, timestamp) {
    const stamp = new Date(timestamp);
    if (!Number.isFinite(stamp.getTime())) return;
    time.dateTime = stamp.toISOString();
    time.textContent = date.format(stamp);
  }

  async function applyActivity(projects, cards, version) {
    const recent = await Promise.all(projects.map(async (project, index) => {
      let modified;
      try { modified = await workspace.open(project.id).lastModified(); }
      catch { /* Project metadata remains available. */ }
      return {
        card: cards[index],
        timestamp: Math.max(project.updatedAt || project.createdAt || 0, modified || 0)
      };
    }));
    if (version !== coverVersion) return;
    for (const { card, timestamp } of recent) updateDate(card.querySelector('time'), timestamp);
    if (sort.value !== 'recent') return;
    recent.sort((a, b) => b.timestamp - a.timestamp);
    const active = document.activeElement;
    recent.forEach(({ card }, index) => {
      if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index]);
    });
    if (grid.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  function makeCard(project, version) {
    const item = document.createElement('li');
    item.className = 'file-card';

    const link = document.createElement('a');
    link.className = 'file-link';
    link.href = fileLink(project.id);
    link.setAttribute('aria-label', project.name);
    link.dataset.projectId = project.id;
    const preview = document.createElement('div');
    preview.className = 'file-preview';
    preview.setAttribute('aria-hidden', 'true');
    const placeholder = document.createElement('span');
    placeholder.className = 'preview-document';
    preview.append(placeholder);
    link.append(preview);

    const detail = document.createElement('div');
    detail.className = 'file-detail';
    const heading = document.createElement('p');
    heading.className = 'file-name';
    heading.title = project.name;
    heading.textContent = project.name;
    const time = document.createElement('time');
    time.className = 'file-time';
    updateDate(time, project.updatedAt || project.createdAt);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'file-rename';
    rename.textContent = '⋯';
    rename.title = '重命名';
    rename.setAttribute('aria-label', '重命名 ' + project.name);
    rename.addEventListener('click', () => showForm(project, rename));

    detail.append(heading, time);
    link.append(detail);
    item.append(link, rename);
    loadCover(preview, project, version);
    return item;
  }

  function render() {
    const projects = store.list();
    const query = search.value.trim().toLocaleLowerCase('zh-CN');
    const matches = projects.filter(project => project.name.toLocaleLowerCase('zh-CN').includes(query));
    if (sort.value === 'name') matches.sort((a, b) => compareNames(a.name, b.name));

    const version = ++coverVersion;
    releaseCovers();
    const cards = matches.map(project => makeCard(project, version));
    grid.replaceChildren(...cards);
    applyActivity(matches, cards, version);
    grid.hidden = !matches.length;
    empty.hidden = Boolean(matches.length);
    emptyTitle.textContent = query ? '找不到匹配的文件' : '还没有文件';
    emptyDescription.textContent = query ? '试试其他关键词。' : '新建文件后，可以在工作台里画图或导入图片。';
    emptyAction.textContent = query ? '清除搜索' : '新建文件';
  }

  newFile.addEventListener('click', () => showForm(null, newFile));
  emptyAction.addEventListener('click', () => {
    if (!search.value.trim()) {
      showForm(null, emptyAction);
      return;
    }
    search.value = '';
    render();
    search.focus();
  });
  search.addEventListener('input', render);
  sort.addEventListener('change', render);
  document.getElementById('cancel-file').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (previousFocus?.isConnected) previousFocus.focus();
    else if (editing) {
      const next = [...grid.querySelectorAll('[data-project-id]')].find(link => link.dataset.projectId === editing.id);
      (next || search).focus();
    }
    previousFocus = null;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name && editing) {
      formError.textContent = '请输入文件名称。';
      formError.hidden = false;
      nameInput.focus();
      return;
    }

    confirm.disabled = true;
    try {
      if (!editing) {
        const project = await store.create(name || '未命名文件');
        window.location.assign(fileLink(project.id));
        return;
      }
      if (!await store.rename(editing.id, name)) throw new Error('这个文件已不存在。');
      showFeedback('已重命名为「' + name + '」。');
      render();
      dialog.close();
    } catch (error) {
      formError.textContent = error.message || '无法保存文件名称。';
      formError.hidden = false;
    } finally {
      confirm.disabled = false;
    }
  });
  window.addEventListener('pagehide', () => {
    ++coverVersion;
    releaseCovers();
  });
  exportFile.addEventListener('click', async () => {
    if (!editing) return;
    exportFile.disabled = true;
    try { await local.exportProject(editing); }
    catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
    } finally { exportFile.disabled = false; }
  });

  function renderLegacy() {
    const missing = local.legacyList().filter(project => !store.get(project.id));
    legacySection.hidden = !missing.length;
    legacyList.replaceChildren(...missing.map(project => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = project.name;
      const actions = document.createElement('div');
      actions.className = 'legacy-item-actions';
      const save = document.createElement('button');
      save.className = 'button button-secondary';
      save.type = 'button';
      save.textContent = '下载备份';
      const migrate = save.cloneNode();
      migrate.textContent = '迁入工作区';
      save.setAttribute('aria-label', '下载「' + project.name + '」的备份');
      migrate.setAttribute('aria-label', '迁入「' + project.name + '」');
      save.addEventListener('click', () => legacyAction(async () => {
        await local.exportLegacy(project);
        showFeedback('已生成「' + project.name + '」的备份。');
      }, [save, migrate]));
      migrate.addEventListener('click', () => legacyAction(async () => {
        const result = await local.importLegacy(project);
        showFeedback(result.created ? '已迁入「' + result.project.name + '」。' : '此文件已在工作区。');
        renderLegacy();
        render();
      }, [save, migrate]));
      actions.append(save, migrate);
      row.append(label, actions);
      return row;
    }));
  }

  async function legacyAction(action, controls) {
    controls.forEach(button => button.disabled = true);
    try { await action(); }
    catch (error) { showFeedback(error.message); }
    finally { controls.forEach(button => button.disabled = false); }
  }

  importFile.addEventListener('click', () => backupFile.click());
  backupFile.addEventListener('change', () => {
    const file = backupFile.files[0];
    backupFile.value = '';
    if (!file) return;
    void legacyAction(async () => {
      const result = await local.importBackup(await local.readBackup(file));
      showFeedback(result.created ? '已导入「' + result.project.name + '」。' : '此文件已存在，已保留当前版本。');
      renderLegacy();
      render();
    }, [importFile]);
  });

  local.ready.then(() => {
    accountStatus.hidden = true;
    document.getElementById('local-files').hidden = false;
    renderLegacy();
    render();
  }).catch(error => { accountStatus.textContent = error.message; });
})();
