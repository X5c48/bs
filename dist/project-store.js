(function (root, factory) {
  const projects = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = projects;
  else root.WuyingProjects = projects;
})(globalThis, function (root) {
  'use strict';

  const prefix = 'wuying-project-v1:';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const briefDefaults = { product: '', scenario: '', goal: '', constraints: '', referenceNotes: '' };
  const preferenceDefaults = { enabled: false, text: '' };
  const storeName = 'assets';
  let connection;

  const normalizeId = id => typeof id === 'string' && uuid.test(id) ? id.toLowerCase() : null;
  const nameOf = name => (typeof name === 'string' ? name.trim().slice(0, 80) : '') || '未命名项目';

  function idFromLocation(location = root.location) {
    const search = typeof location === 'string'
      ? new URL(location, 'https://wuying.invalid/').search
      : location?.search;
    return normalizeId(new URLSearchParams(search).get('project'));
  }

  function suffix(id) {
    const valid = normalizeId(id);
    return valid ? '-project-' + valid : '';
  }

  function read(storage, id) {
    try {
      const project = JSON.parse(storage.getItem(prefix + id));
      return project?.id === id ? project : null;
    } catch { return null; }
  }

  function get(id) {
    const valid = normalizeId(id);
    try { return valid ? read(root.localStorage, valid) : null; }
    catch { return null; }
  }

  function list() {
    try {
      const storage = root.localStorage;
      const records = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const id = normalizeId(key.slice(prefix.length));
        const project = id && read(storage, id);
        if (project) records.push(project);
      }
      return records.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    } catch { return []; }
  }

  function write(project) {
    try { root.localStorage.setItem(prefix + project.id, JSON.stringify(project)); }
    catch { throw new Error('无法保存项目，请检查浏览器存储空间和权限。'); }
    return project;
  }

  function create(name) {
    const now = Date.now();
    return write({
      id: root.crypto.randomUUID(), name: nameOf(name), createdAt: now, updatedAt: now,
      brief: { ...briefDefaults }, directions: [], adopted: [], notes: [],
      preferences: { ...preferenceDefaults }, desk: 'brief', editorPanel: 'derive', activeDraftId: null, presentation: null
    });
  }

  function update(id, patch) {
    const project = get(id);
    if (!project) return null;
    if (!patch || typeof patch !== 'object') return project;
    if (Object.hasOwn(patch, 'name')) project.name = nameOf(patch.name);
    for (const key of Object.keys(briefDefaults)) {
      if (typeof patch.brief?.[key] === 'string') project.brief[key] = patch.brief[key];
    }
    if (typeof patch.preferences?.enabled === 'boolean') project.preferences.enabled = patch.preferences.enabled;
    if (typeof patch.preferences?.text === 'string') project.preferences.text = patch.preferences.text;
    for (const key of ['directions', 'adopted', 'notes']) {
      if (Array.isArray(patch[key])) project[key] = patch[key];
    }
    if (patch.desk === 'brief' || patch.desk === 'editor') project.desk = patch.desk;
    if (['derive', 'generate', 'iterate'].includes(patch.editorPanel)) project.editorPanel = patch.editorPanel;
    if (patch.activeDraftId === null || typeof patch.activeDraftId === 'string') project.activeDraftId = patch.activeDraftId;
    if (patch.presentation === null || (patch.presentation && typeof patch.presentation === 'object' && !Array.isArray(patch.presentation))) {
      project.presentation = patch.presentation;
    }
    project.updatedAt = Math.max(Date.now(), project.updatedAt + 1);
    return write(project);
  }

  function rename(id, name) { return update(id, { name }); }

  function database() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('浏览器不支持保存项目图片。')); return; }
      const request = root.indexedDB.open('wuying-project-assets-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
      request.onerror = () => reject(new Error('无法打开项目图片存储。'));
    }).catch(error => { connection = null; throw error; });
    return connection;
  }

  async function assetOperation(mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(new Error('无法读写项目图片，请检查浏览器存储空间和权限。'));
    });
  }

  function assetKey(id, kind, slot) {
    const projectId = normalizeId(id);
    if (!projectId) return null;
    if (kind === 'reference') return projectId + '/reference';
    const name = slot === 'selected' ? slot : normalizeId(slot);
    return name ? projectId + '/' + kind + '/' + name : null;
  }

  async function saveAsset(id, blob, kind, slot) {
    const key = assetKey(id, kind, slot);
    if (!key || !get(id)) throw new Error('项目不存在，无法保存图片。');
    if (!(blob instanceof root.Blob) || !blob.size) throw new Error('无法保存空图片。');
    await assetOperation('readwrite', store => store.put(blob, key));
  }

  async function getAsset(id, kind, slot) {
    const key = assetKey(id, kind, slot);
    return key ? assetOperation('readonly', store => store.get(key)) : null;
  }

  async function deleteAsset(id, kind, slot) {
    const key = assetKey(id, kind, slot);
    if (key) await assetOperation('readwrite', store => store.delete(key));
  }

  function imagePrefix(id) {
    const projectId = normalizeId(id);
    return projectId ? projectId + '/image-card/' : null;
  }

  async function listImageCards(id) {
    const key = imagePrefix(id);
    if (!key) return [];
    return assetOperation('readonly', store => store.getAll(root.IDBKeyRange.bound(key,key+'\uffff')));
  }

  async function saveImageCard(id, record) {
    const key = imagePrefix(id), item = normalizeId(record?.id);
    if (!key || !item || !get(id) || !(record.blob instanceof root.Blob) || !record.blob.size) {
      throw new Error('图片或项目无效，无法保存到画布。');
    }
    await assetOperation('readwrite', store => store.put(record,key+item));
    return record;
  }

  async function exportLegacyMedia(id) {
    const projectId = normalizeId(id);
    if (!projectId) throw new Error('旧项目编号无效。');
    const db = await database();
    const prefix = projectId + '/';
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const range = root.IDBKeyRange.bound(prefix, prefix + '\uffff');
      const keys = store.getAllKeys(range);
      const values = store.getAll(range);
      transaction.oncomplete = () => {
        try {
          resolve(values.result.map((value, index) => {
            const key = keys.result[index].slice(prefix.length);
            if (value instanceof root.Blob) return { key, blob: value };
            if (value?.blob instanceof root.Blob) {
              const { blob, ...metadata } = value;
              return { key, blob, metadata };
            }
            throw new Error('旧项目素材无法读取。');
          }));
        } catch (error) { reject(error); }
      };
      transaction.onabort = () => reject(transaction.error || new Error('无法读取旧项目素材。'));
    });
  }

  return {
    exportLegacyMedia,
    list, get, create, rename, update, idFromLocation, suffix, listImageCards, saveImageCard,
    saveReference: (id, blob) => saveAsset(id, blob, 'reference'),
    getReference: id => getAsset(id, 'reference'),
    deleteReference: id => deleteAsset(id, 'reference'),
    savePresentation: (id, blob, slot = 'selected') => saveAsset(id, blob, 'presentation', slot),
    getPresentation: (id, slot = 'selected') => getAsset(id, 'presentation', slot),
    deletePresentation: (id, slot = 'selected') => deleteAsset(id, 'presentation', slot),
    saveVideo: (id, draftId, blob) => saveAsset(id, blob, 'video', draftId),
    getVideo: (id, draftId) => getAsset(id, 'video', draftId)
  };
});
