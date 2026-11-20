'use strict';

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { extname, join, resolve, sep } = require('node:path');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const emptyDocument = () => ({ assets: {}, blocks: {}, jobs: {} });
const format = 'wuying-project-v1';
const owner = 'local-workspace';
const backupLimit = 256 * 1024 * 1024;
const mediaLimit = 128 * 1024 * 1024;
const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.avif': 'image/avif', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.otf': 'font/otf'
};

class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message) {
  if (!condition) throw new WorkspaceError(400, message);
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function nameOf(value) { return typeof value === 'string' && value.trim().slice(0, 80) || '未命名文件'; }

function validateDocument(value) {
  requireValue(object(value) && ['assets', 'blocks', 'jobs'].every(key =>
    object(value[key]) && Object.keys(value[key]).every(id => idPattern.test(id))),'工作台数据无效。');
  return JSON.stringify(value);
}

function validateProject(value) {
  requireValue(object(value) && idPattern.test(value.id) &&
    Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt),
    '项目编号或时间无效。');
  return { ...value, id: value.id.toLowerCase(), name: nameOf(value.name) };
}

function validMediaKey(scope, key) {
  if (scope === 'workspace') return typeof key === 'string' && idPattern.test(key);
  if (scope !== 'project' || typeof key !== 'string') return false;
  const [kind, slot, extra] = key.split('/');
  if (extra !== undefined) return false;
  if (kind === 'reference') return slot === undefined;
  if (kind === 'presentation') return slot === 'selected' || idPattern.test(slot || '');
  return (kind === 'video' || kind === 'image-card') && idPattern.test(slot || '');
}

function validateMedia(items = [], workspaceOnly = false) {
  requireValue(Array.isArray(items) && items.length <= 20000, '素材清单无效。');
  const keys = new Set();
  return items.map(item => {
    requireValue(object(item) && validMediaKey(item.scope, item.key) && (!workspaceOnly || item.scope === 'workspace'),
      '素材编号无效。');
    const { scope } = item;
    const key = item.key.toLowerCase();
    const label = scope + ':' + key;
    requireValue(!keys.has(label), '素材清单中存在重复编号。');
    keys.add(label);
    requireValue(typeof item.data === 'string' && item.data.length <= Math.ceil(mediaLimit / 3) * 4,
      '单个素材超过 128 MiB 或缺少文件内容。');
    const bytes = Buffer.from(item.data, 'base64');
    requireValue(bytes.length > 0 && bytes.length <= mediaLimit && bytes.toString('base64') === item.data,
      '素材文件内容无效。');
    const type = typeof item.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(item.type) && item.type.length <= 120
      ? item.type : 'application/octet-stream';
    const metadata = item.metadata === undefined ? null : item.metadata;
    requireValue(metadata === null || (object(metadata) && !Object.hasOwn(metadata, 'blob')), '素材附加信息无效。');
    return { scope, key, bytes, type, metadata: metadata === null ? null : JSON.stringify(metadata), hash: sha256(bytes) };
  });
}

async function readJson(req, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new WorkspaceError(415, '请提交 JSON 数据。');
  }
  if (Number(req.headers['content-length']) > maximum) {
    req.resume();
    throw new WorkspaceError(413, '文件超过单次上传上限。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maximum) chunks.push(chunk);
  }
  if (size > maximum) throw new WorkspaceError(413, '文件超过单次上传上限。');
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WorkspaceError(400, 'JSON 文件无法读取。'); }
  requireValue(object(data), '请求需要 JSON 对象。');
  return data;
}

function send(res, status, content) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(content));
}

function servePage(req, res, path, dist) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let relative;
  try { relative = decodeURIComponent(path === '/' ? '/files.html' : path); }
  catch { return false; }
  if (!relative.split('/').slice(1).every(part => part && !/^[.]|[:\\\x00-\x1f]/.test(part))) return false;
  const type = staticTypes[extname(relative).toLowerCase()];
  if (!type) return false;
  let file, size;
  try {
    file = realpathSync(join(dist, relative));
    if (!file.startsWith(dist + sep)) return false;
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return false;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
  if (req.method === 'HEAD') res.end();
  else {
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  }
  return true;
}

function createWorkspaceServer({ directory, staticDirectory = join(__dirname, '..', 'dist') } = {}) {
  const dataDirectory = resolve(directory || join(__dirname, '..', '.wuying-local', 'workspace'));
  const dist = realpathSync(staticDirectory);
  mkdirSync(dataDirectory, { recursive: true });
  const mediaRoot = join(dataDirectory, 'media');
  mkdirSync(mediaRoot, { recursive: true });

  const db = new DatabaseSync(join(dataDirectory, 'workspace.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      owner TEXT NOT NULL REFERENCES accounts (id), id TEXT NOT NULL, metadata TEXT NOT NULL,
      document TEXT NOT NULL, revision INTEGER NOT NULL, activity INTEGER NOT NULL, PRIMARY KEY (owner, id)
    );
    CREATE TABLE IF NOT EXISTS media (
      owner TEXT NOT NULL, project TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
      digest TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, metadata TEXT,
      PRIMARY KEY (owner, project, scope, key),
      FOREIGN KEY (owner, project) REFERENCES projects (owner, id)
    );
  `);

  const sql = Object.fromEntries(Object.entries({
    list: 'SELECT metadata FROM projects WHERE owner = ? ORDER BY activity DESC, id',
    project: 'SELECT * FROM projects WHERE owner = ? AND id = ?',
    newProject: 'INSERT INTO projects VALUES (?, ?, ?, ?, 1, ?)',
    rename: 'UPDATE projects SET metadata = ?, activity = ? WHERE owner = ? AND id = ?',
    updateDocument: 'UPDATE projects SET document = ?, revision = revision + 1, activity = ? WHERE owner = ? AND id = ? AND revision = ?',
    listMedia: 'SELECT scope, key, digest, type, size, metadata FROM media WHERE owner = ? AND project = ? ORDER BY scope, key',
    media: 'SELECT digest, type, size FROM media WHERE owner = ? AND project = ? AND scope = ? AND key = ?',
    newMedia: 'INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    putMedia: `INSERT INTO media VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner, project, scope, key) DO UPDATE
      SET digest = excluded.digest, type = excluded.type, size = excluded.size, metadata = excluded.metadata`,
    dropMedia: 'DELETE FROM media WHERE owner = ? AND project = ? AND scope = ? AND key = ?'
  }).map(([key, value]) => [key, db.prepare(value)]));

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function mediaPath(digest) { return join(mediaRoot, digest.slice(0, 2), digest); }

  function saveMedia(owner, project, items, replace = false) {
    for (const item of items) {
      const path = mediaPath(item.hash);
      if (!existsSync(path)) {
        mkdirSync(join(mediaRoot, item.hash.slice(0, 2)), { recursive: true });
        const temporary = path + '.' + randomUUID() + '.tmp';
        writeFileSync(temporary, item.bytes, { flag: 'wx' });
        renameSync(temporary, path);
      }
      (replace ? sql.putMedia : sql.newMedia).run(
        owner, project, item.scope, item.key, item.hash, item.type, item.bytes.length, item.metadata
      );
    }
  }

  transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS local_migrations (origin TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (origin, id))');
    db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, ?, ?, ?)').run(owner, ':local-workspace', '', Buffer.alloc(0));
    const oldProjects = db.prepare(`
      SELECT p.* FROM projects p LEFT JOIN local_migrations m ON m.origin = p.owner AND m.id = p.id
      WHERE p.owner != ? AND m.id IS NULL ORDER BY p.activity, p.owner, p.id
    `).all(owner);
    const migrated = db.prepare('INSERT INTO local_migrations VALUES (?, ?)');
    for (const project of oldProjects) {
      const id = sql.project.get(owner, project.id) ? randomUUID() : project.id;
      const metadata = { ...JSON.parse(project.metadata), id };
      db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)')
        .run(owner, id, JSON.stringify(metadata), project.document, project.revision, project.activity);
      for (const item of sql.listMedia.all(project.owner, project.id)) {
        sql.newMedia.run(owner, id, item.scope, item.key, item.digest, item.type, item.size, item.metadata);
      }
      migrated.run(project.owner, project.id);
    }
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const port = server.address().port;
    const host = req.headers.host;
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) {
      return send(res, 403, { error: '物映工作台仅允许本机访问。' });
    }
    const origin = 'http://' + host;
    const { method } = req;
    try {
      const path = new URL(req.url, origin).pathname;
      if (!path.startsWith('/api/')) {
        if (!servePage(req, res, path, dist)) send(res, 404, { error: '页面不存在。' });
        return;
      }
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          ((method !== 'GET' || req.headers.origin) && req.headers.origin !== origin)) {
        throw new WorkspaceError(403, '当前页面来源无法访问项目。');
      }
      if (method === 'GET' && path === '/api/workspace/health') return send(res, 200, { workspace: 2 });
      if (path === '/api/projects' && method === 'GET') {
        return send(res, 200, { projects: sql.list.all(owner).map(row => JSON.parse(row.metadata)) });
      }
      if (path === '/api/projects' && method === 'POST') {
        const data = await readJson(req, 4096);
        const now = Date.now();
        const project = {
          id: randomUUID(), name: nameOf(data.name), createdAt: now, updatedAt: now, brief: {
            product: '', scenario: '', goal: '', constraints: '', referenceNotes: ''
          }, directions: [], adopted: [], notes: [], preferences: { enabled: false, text: '' },
          desk: 'brief', editorPanel: 'derive', activeDraftId: null, presentation: null
        };
        sql.newProject.run(owner, project.id, JSON.stringify(project), JSON.stringify(emptyDocument()), now);
        return send(res, 201, { project });
      }
      if (path === '/api/projects/import' && method === 'POST') {
        const data = await readJson(req, backupLimit);
        requireValue(data.format === format && Array.isArray(data.media), '请选择物映项目备份。');
        const project = validateProject(data.project);
        const document = validateDocument(data.document);
        const items = validateMedia(data.media);
        const created = transaction(() => {
          if (sql.project.get(owner, project.id)) return false;
          sql.newProject.run(owner, project.id, JSON.stringify(project), document, project.updatedAt);
          saveMedia(owner, project.id, items);
          return true;
        });
        return send(res, created ? 201 : 200, { created, project: created ? project :
          JSON.parse(sql.project.get(owner, project.id).metadata) });
      }
      const [, prefix, id, section, scope, encodedKey, ...extra] = path.slice(1).split('/');
      if (prefix !== 'projects' || !id || !idPattern.test(id) || extra.length) {
        throw new WorkspaceError(404, '接口不存在。');
      }
      const projectId = id.toLowerCase();
      const row = sql.project.get(owner, projectId);
      if (!row) throw new WorkspaceError(404, '找不到这个物映文件。');
      if (!section && method === 'GET') return send(res, 200, { project: JSON.parse(row.metadata) });
      if (!section && method === 'PATCH') {
        const data = await readJson(req, 4096);
        const current = sql.project.get(owner, projectId);
        const project = { ...JSON.parse(current.metadata), name: nameOf(data.name),
          updatedAt: Math.max(Date.now(), current.activity + 1) };
        sql.rename.run(JSON.stringify(project), project.updatedAt, owner, projectId);
        return send(res, 200, { project });
      }
      if (section === 'document' && !scope && method === 'GET') {
        return send(res, 200, { document: JSON.parse(row.document), revision: row.revision, activity: row.activity });
      }
      if (section === 'document' && !scope && method === 'PUT') {
        const data = await readJson(req, backupLimit);
        requireValue(Number.isSafeInteger(data.revision) && data.revision > 0, '工作台版本无效。');
        const document = validateDocument(data.document);
        const items = validateMedia(data.media, true);
        const activity = Date.now();
        transaction(() => {
          const changed = sql.updateDocument.run(document, activity, owner, projectId, data.revision);
          if (!changed.changes) throw new WorkspaceError(409, '工作台已在另一页面修改，请刷新后重试。');
          if (items.some(item => sql.media.get(owner, projectId, item.scope, item.key))) {
            throw new WorkspaceError(409, '工作台素材编号已经使用。');
          }
          saveMedia(owner, projectId, items);
        });
        return send(res, 200, { revision: data.revision + 1, activity });
      }
      if (section === 'backup' && !scope && method === 'GET') {
        const records = sql.listMedia.all(owner, projectId);
        if (records.reduce((total, item) => total + Math.ceil(item.size / 3) * 4, 0) > backupLimit - 1024 * 1024) {
          throw new WorkspaceError(413, '项目素材超出单次备份上限。');
        }
        const media = records.map(item => ({
          scope: item.scope, key: item.key, type: item.type, metadata: item.metadata === null ? null : JSON.parse(item.metadata),
          data: readFileSync(mediaPath(item.digest)).toString('base64')
        }));
        const payload = JSON.stringify({ format, project: JSON.parse(row.metadata), document: JSON.parse(row.document), media });
        if (Buffer.byteLength(payload) > backupLimit) throw new WorkspaceError(413, '项目超出单次备份上限。');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="' + projectId + '.wuying.json"');
        return res.end(payload);
      }
      if (section === 'media' && encodedKey && ['workspace', 'project'].includes(scope)) {
        let key;
        try { key = decodeURIComponent(encodedKey).toLowerCase(); } catch { key = ''; }
        requireValue(validMediaKey(scope, key), '素材编号无效。');
        if (method === 'GET') {
          const item = sql.media.get(owner, projectId, scope, key);
          if (!item) throw new WorkspaceError(404, '找不到这份素材。');
          const stream = createReadStream(mediaPath(item.digest));
          stream.once('open', () => {
            res.writeHead(200, {
              'Content-Type': item.type, 'Content-Length': item.size, 'Content-Disposition': 'attachment',
              'Content-Security-Policy': "default-src 'none'; sandbox"
            });
            stream.pipe(res);
          });
          stream.on('error', () => res.headersSent ? res.destroy() : send(res, 500, { error: '素材文件不可读。' }));
          res.once('close', () => stream.destroy());
          return;
        }
        if (scope === 'project' && method === 'PUT') {
          const data = await readJson(req, backupLimit);
          const items = validateMedia([{ ...data, scope, key }]);
          transaction(() => saveMedia(owner, projectId, items, true));
          return send(res, 200, { saved: true });
        }
        if (scope === 'project' && method === 'DELETE') {
          sql.dropMedia.run(owner, projectId, scope, key);
          return send(res, 200, { removed: true });
        }
      }
      throw new WorkspaceError(404, '接口不存在。');
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof WorkspaceError) return send(res, error.status, { error: error.message });
      console.error('物映项目服务请求失败', error);
      return send(res, 500, { error: '无法读取或保存项目，请检查工作区服务和磁盘空间。' });
    }
  });
  server.once('close', () => db.close());
  return server;
}

if (require.main === module) {
  const server = createWorkspaceServer();
  server.on('error', error => { console.error('物映工作区启动失败 · ' + error.code); process.exitCode = 1; });
  server.listen(8881, '127.0.0.1', () => console.log('物映工作区  http://127.0.0.1:8881/files.html'));
}
module.exports = { createWorkspaceServer };

