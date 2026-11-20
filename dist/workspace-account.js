(() => {
  'use strict';

  const projects = window.WuyingProjects;
  const workspace = window.WuyingWorkspace;
  const readBrowserProjects = projects.list;
  const legacyMedia = projects.exportLegacyMedia;
  const legacySnapshot = workspace.exportLegacy;
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
  const backupLimit = 256 * 1024 * 1024;
  const records = new Map();

  async function request(path, { method = 'GET', data, download } = {}) {
    const options = { method, cache: 'no-store', credentials: 'same-origin' };
    const headers = options.headers = {};
    if (data !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
      if (new Blob([options.body]).size > backupLimit) throw new Error('备份超过单次上传上限（256 MiB）。');
    }
    let response;
    try { response = await fetch(path, options); }
    catch { throw new Error('无法连接物映工作区，请重新打开「打开物映.cmd」。'); }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const error = new Error(payload?.error || '物映工作区返回 HTTP ' + response.status + '。');
      error.status = response.status;
      throw error;
    }
    return download ? response.blob() : response.json();
  }

  const url = id => '/api/projects/' + encodeURIComponent(id);
  const mediaUrl = (id, scope, key) => url(id) + '/media/' + scope + '/' + encodeURIComponent(key);

  async function refresh() {
    const { projects: list } = await request('/api/projects');
    records.clear();
    for (const project of list) records.set(project.id, project);
  }

  const ready = refresh();

  async function requireProject() {
    try {
      await ready;
      if (records.has(projects.idFromLocation())) return true;
    } catch { /* The files page displays connection errors. */ }
    location.replace('files.html');
    return false;
  }

  async function encodeBlob(scope, key, blob, metadata) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取项目素材。'));
      reader.readAsDataURL(blob);
    });
    return { scope, key, type: blob.type, metadata, data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }

  const legacyList = readBrowserProjects;
  async function importLegacy(project) { return importBackup(await fromLegacy(project)); }

  async function fromLegacy(project) {
    const snapshot = await legacySnapshot(project.id);
    const attachments = await legacyMedia(project.id);
    const media = [];
    for (const item of snapshot.images) media.push(await encodeBlob('workspace', item.key, item.blob));
    for (const item of attachments) media.push(await encodeBlob('project', item.key, item.blob, item.metadata));
    return { format: 'wuying-project-v1', project, document: snapshot.document, media };
  }

  function download(blob, name) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }

  function downloadBackup(blob, project) {
    const name = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-') || project.id;
    download(blob, name + '.wuying.json');
  }

  async function importBackup(backup) {
    const result = await request('/api/projects/import', { method: 'POST', data: backup });
    records.set(result.project.id, result.project);
    return result;
  }

  async function getMedia(id, scope, key) {
    try { return await request(mediaUrl(id, scope, key), { download: true }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  Object.assign(projects, {
    get: id => typeof id === 'string' && records.get(id.toLowerCase()) || null,
    list: () => [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
    create: async name => {
      const { project } = await request('/api/projects', { method: 'POST', data: { name } });
      records.set(project.id, project);
      return project;
    },
    rename: async (id, name) => {
      const { project } = await request(url(id), { method: 'PATCH', data: { name } });
      records.set(project.id, project);
      return project;
    },
    getReference: id => getMedia(id, 'project', 'reference'),
    getPresentation: (id, slot = 'selected') => getMedia(id, 'project', 'presentation/' + slot),
    getVideo: (id, slot) => getMedia(id, 'project', 'video/' + slot)
  });

  workspace.open = id => {
    if (!projects.get(id)) throw new Error('找不到这个物映文件。');
    const address = url(id) + '/document';
    const read = () => request(address);
    const blobsById = new Map();
    let writes = Promise.resolve();

    return {
      read: async () => (await read()).document,
      lastModified: async () => (await read()).activity,
      getBlob: key => {
        if (!uuid.test(key || '')) return Promise.resolve(null);
        const normalized = key.toLowerCase();
        if (blobsById.has(normalized)) return blobsById.get(normalized);
        const pending = getMedia(id, 'workspace', normalized);
        blobsById.set(normalized, pending);
        pending.then(blob => { if (!blob) blobsById.delete(normalized); }, () => blobsById.delete(normalized));
        return pending;
      },
      change(mutator, blobs = []) {
        const run = writes.then(async () => {
          if (typeof mutator !== 'function' || !Array.isArray(blobs)) throw new TypeError('工作台编辑操作无效。');
          const { document, revision } = await read();
          const returned = mutator(document);
          if (returned && typeof returned.then === 'function') {
            Promise.resolve(returned).catch(() => {});
            throw new TypeError('工作台编辑操作必须同步执行。');
          }
          const media = [];
          for (const image of blobs) media.push(await encodeBlob('workspace', image.id, image.blob));
          await request(address, { method: 'PUT', data: { document, revision, media } });
          return document;
        });
        writes = run.catch(() => {});
        return run;
      }
    };
  };

  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

  window.WuyingLocalWorkspace = {
    ready, requireProject, legacyList, importBackup,
    importLegacy,
    exportProject: async project => downloadBackup(await request(url(project.id) + '/backup', { download: true }), project),
    exportLegacy: async project => {
      const backup = await fromLegacy(project);
      downloadBackup(new Blob([JSON.stringify(backup)], { type: 'application/json' }), project);
    },
    readBackup: async file => {
      if (file.size > backupLimit) throw new Error('备份超过单次上传上限（256 MiB）。');
      try { return JSON.parse(await file.text()); }
      catch { throw new Error('无法读取备份，请选择物映导出的项目备份文件。'); }
    }
  };
})();
