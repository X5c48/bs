(function (root) {
  'use strict';

  const databaseName = 'wuying-workspace-v1';
  const documents = 'documents';
  const images = 'images';
  const collections = ['assets', 'blocks', 'jobs'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isId = value => typeof value === 'string' && uuid.test(value);
  const emptyDocument = () => ({ assets: {}, blocks: {}, jobs: {} });
  let connection;

  function isRecord(value) {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function getDatabase() {
    if (connection) return connection;
    const pending = new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        reject(new Error('此浏览器无法保存工作台文件。'));
        return;
      }

      const request = root.indexedDB.open(databaseName, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(documents);
        db.createObjectStore(images);
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error('工作台存储正在更新，请关闭旧的物映页面后重试。'));
      };
      request.onerror = () => reject(request.error || new Error('无法打开工作台存储。'));
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          if (connection === pending) connection = undefined;
        };
        resolve(db);
      };
    });
    connection = pending;
    pending.catch(() => {
      if (connection === pending) connection = undefined;
    });
    return pending;
  }

  function jsonDocument(doc) {
    for (const key of collections) {
      const records = doc[key];
      if (!isRecord(records) || !Object.keys(records).every(isId)) {
        throw new TypeError('工作台数据无效：' + key);
      }
    }

    const active = new Set();
    function verify(value) {
      const type = typeof value;
      if (type === 'function' || type === 'symbol' || type === 'bigint' ||
          (type === 'number' && !Number.isFinite(value))) {
        throw new TypeError('工作台文档只能保存 JSON 数据。');
      }
      if (type !== 'object' || value === null) return;
      if ((!isRecord(value) && !Array.isArray(value)) || active.has(value)) {
        throw new TypeError('工作台文档只能保存 JSON 数据。');
      }
      active.add(value);
      for (const entry of Object.values(value)) verify(entry);
      active.delete(value);
    }

    verify(doc);
    return JSON.parse(JSON.stringify(doc));
  }

  function validateImages(blobs) {
    if (!Array.isArray(blobs)) throw new TypeError('图片记录必须是数组。');
    const ids = new Set();
    return blobs.map(item => {
      if (!item || !isId(item.id) || !(item.blob instanceof root.Blob) || !item.blob.size) {
        throw new TypeError('无法保存无效的图片记录。');
      }
      const id = item.id.toLowerCase();
      if (ids.has(id)) throw new TypeError('一次保存不能使用重复的图片编号。');
      ids.add(id);
      return { id, blob: item.blob };
    });
  }

  async function readKey(store, key) {
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, 'readonly');
      const request = transaction.objectStore(store).get(key);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(transaction.error || new Error('无法读取工作台数据。'));
    });
  }

  async function update(projectId, mutator, blobs) {
    if (typeof mutator !== 'function') throw new TypeError('需要提供工作台编辑操作。');
    const pendingImages = validateImages(blobs);
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const names = pendingImages.length ? [documents, images] : [documents];
      const transaction = db.transaction(names, 'readwrite');
      const documentStore = transaction.objectStore(documents);
      let committedDoc, failure;
      transaction.oncomplete = () => resolve(committedDoc);
      transaction.onabort = () => reject(failure || transaction.error || new Error('无法保存工作台数据。'));
      const read = documentStore.get(projectId);
      read.onsuccess = () => {
        try {
          const doc = read.result || emptyDocument();
          const returned = mutator(doc);
          if (returned && typeof returned.then === 'function') {
            Promise.resolve(returned).catch(() => {});
            throw new TypeError('工作台编辑操作必须同步执行。');
          }
          committedDoc = jsonDocument(doc);
          documentStore.put(committedDoc, projectId);
          documentStore.put(Date.now(), [projectId, 'activity']);
          if (pendingImages.length) {
            const imageStore = transaction.objectStore(images);
            for (const image of pendingImages) imageStore.add(image.blob, [projectId, image.id]);
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    });
  }

  function open(projectId) {
    const project = root.WuyingProjects?.get(projectId);
    if (!project || !isId(project.id)) throw new Error('找不到这个物映文件。');
    const id = project.id;
    return {
      read: async () => await readKey(documents, id) || emptyDocument(),
      change: (mutator, blobs = []) => update(id, mutator, blobs),
      lastModified: () => readKey(documents, [id, 'activity']),
      getBlob: async blobId => isId(blobId) ? readKey(images, [id, blobId.toLowerCase()]) : null
    };
  }

  async function exportLegacy(id) {
    if (!isId(id)) throw new Error('旧项目编号无效。');
    const db = await getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([documents, images], 'readonly');
      const doc = transaction.objectStore(documents).get(id);
      const imageStore = transaction.objectStore(images);
      const range = root.IDBKeyRange.bound([id], [id, []]);
      const keys = imageStore.getAllKeys(range);
      const blobs = imageStore.getAll(range);
      transaction.oncomplete = () => resolve({
        document: doc.result || emptyDocument(),
        images: blobs.result.map((blob, index) => ({ key: keys.result[index][1], blob }))
      });
      transaction.onabort = () => reject(transaction.error || new Error('无法读取旧工作台文件。'));
    });
  }

  root.WuyingWorkspace = { open, exportLegacy };
})(globalThis);
