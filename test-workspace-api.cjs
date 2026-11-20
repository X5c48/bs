const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const shape = require('./dist/shape-model.js');

test('local projects open without login and retain assets, versions and backups after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wuying-workspace-'));
  let server;
  let origin;
  async function start() {
    const { createWorkspaceServer } = require('./server/workspace-api.cjs');
    server = createWorkspaceServer({ directory });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  async function stop() {
    if (!server) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  const call = (path, { method = 'GET', body, from } = {}) => {
    const headers = {};
    if (method !== 'GET') headers.Origin = from || origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  try {
    await start();
    assert.doesNotMatch(await (await call('/files.html')).text(), /id="account-form"/);
    assert.equal((await call('/api/projects')).status, 200);
    assert.equal((await call('/api/projects', { method: 'POST', from: 'https://external.example' })).status, 403);
    assert.equal((await call('/api/account')).status, 404);
    const write = (path, body, method = 'POST') => call(path, { method, body });

    const id = randomUUID();
    const asset = randomUUID();
    const blob = randomUUID();
    const parent = randomUUID();
    const layer = randomUUID();
    const size = { width: 640, height: 480 };
    const parts = [shape.createPart(layer, 'rectangle', '底座', { x: 320, y: 370, width: 235, height: 48, angle: 0, locked: true }, size)];
    const lineage = shape.snapshot({ id: parent, name: '原始台灯', draft: { revision: 'first', parts } });
    const mediaBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0uoAAAAASUVORK5CYII=', 'base64');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const media = { scope: 'workspace', key: blob, type: 'image/png', data: mediaBytes.toString('base64') };
    const backup = {
      format: 'wuying-project-v1',
      project: { id, name: '台灯', createdAt: 100, updatedAt: 101 },
      document: {
        assets: { [asset]: { id: asset, draft: { parts, lineage }, layers: [{ id: layer, blobId: blob }] } },
        blocks: {}, jobs: {}
      },
      media: [media, { ...media, scope: 'project', key: 'reference' }]
    };

    assert.equal((await write('/api/projects/import', backup)).status, 201);
    const duplicate = await write('/api/projects/import', backup);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).created, false);
    assert.equal((await (await call('/api/projects')).json()).projects.length, 1);
    const base = '/api/projects/' + id;
    const assetPath = base + '/media/workspace/' + blob;
    assert.equal((await call('/api/projects/' + randomUUID())).status, 404);
    const loaded = await (await call(base + '/document')).json();
    assert.deepEqual(loaded.document, backup.document);
    assert.equal(loaded.document.assets[asset].draft.lineage.parentId, parent);
    assert.equal(loaded.document.assets[asset].draft.parts[0].locked, true);
    const downloaded = await call(assetPath);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-type'), 'image/png');
    assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), digest(mediaBytes));
    assert.equal((await call(base + '/media/project/reference')).status, 200);

    const newBlob = randomUUID();
    const edited = structuredClone(loaded.document);
    edited.assets[asset].title = '方案甲';
    const edit = { revision: loaded.revision, document: edited, media: [{ ...media, key: newBlob }] };
    assert.equal((await write(base + '/document', edit , 'PUT')).status, 200);
    assert.equal((await write(base + '/document', edit , 'PUT')).status, 409);
    assert.equal((await write('/api/projects/import', backup)).status, 200);
    assert.equal((await (await call(base + '/document')).json()).document.assets[asset].title, '方案甲');
    assert.equal((await write(base, { name: '改名后的台灯' } , 'PATCH')).status, 200);
    const exported = await (await call(base + '/backup')).json();
    assert.deepEqual(exported.document, edited);
    assert.equal(exported.media.length, 3);
    assert.equal(exported.project.name, '改名后的台灯');

    await stop();
    await start();
    const reopened = await (await call(base + '/backup')).json();
    assert.deepEqual(reopened, exported);
    assert.equal((await write('/api/projects', { name: '新建文件' })).status, 201);
    assert.equal((await (await call('/api/projects')).json()).projects.length, 2);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('legacy account projects migrate once with independent documents even when they share an ID', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createWorkspaceServer } = require('./server/workspace-api.cjs');
  const directory = mkdtempSync(join(tmpdir(), 'wuying-local-upgrade-'));
  let server;
  const start=async()=>{
    server=createWorkspaceServer({directory});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    return 'http://127.0.0.1:'+server.address().port;
  };
  const stop=async()=>{
    if(!server)return;
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    server=null;
  };
  try{
    await start();
    await stop();
    const database=new DatabaseSync(join(directory,'workspace.sqlite'));
    const shared=randomUUID(), asset=randomUUID();
    for(const name of ['old-a','old-b']){
      database.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?)').run(name,name,'unused',Buffer.alloc(1));
      const metadata={id:shared,name,createdAt:123,updatedAt:124};
      const document={assets:{[asset]:{id:asset,name}},blocks:{},jobs:{}};
      database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(
        name,shared,JSON.stringify(metadata),JSON.stringify(document),3,124);
    }
    database.close();
    let origin=await start();
    const {projects}=await (await fetch(origin+'/api/projects')).json();
    assert.deepEqual(projects.map(project=>project.name).sort(),['old-a','old-b']);
    assert.equal(new Set(projects.map(project=>project.id)).size,2);
    for(const project of projects){
      const data=await (await fetch(origin+'/api/projects/'+project.id+'/document')).json();
      assert.equal(data.document.assets[asset].name,project.name);
      assert.equal(data.revision,3);
    }
    await stop();
    origin=await start();
    assert.equal((await (await fetch(origin+'/api/projects')).json()).projects.length,2);
  }finally{
    await stop();
    rmSync(directory,{recursive:true,force:true});
  }
});