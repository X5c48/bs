// 三模块真实链路验收（会真的出图，需 8881 + 8188）
// A. 草图模块：造型发散 → 真的生成多个方向概念图
// B. 渲染模块：白模 → 确认 → 精细渲染，且精修以白模为源、机位与白模一致
// 运行：node tools/verify-three-modules.cjs
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function loadPlaywright() {
  const cache = path.join(os.homedir(), 'AppData/Local/npm-cache/_npx');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const candidate = path.join(cache, dir, 'node_modules/playwright');
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require('playwright');
}

const origin = process.env.WUYING_ORIGIN || 'http://127.0.0.1:8881';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? ' · ' + detail : ''));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({
        provider: 'comfy', endpoint: 'http://127.0.0.1:8188',
        checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
        controlnet: 'control_v11p_sd15_scribble_fp16.safetensors'
      }));
    } catch {}
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let projectId = null;

  try {
    await page.goto(origin + '/files.html');
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('三模块真实链路')).id);

    // 造一条「上宽下窄的杯身」草图
    const sketchId = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const id = crypto.randomUUID(), now = Date.now();
      const left = [], right = [];
      for (let i = 0; i <= 20; i++) {
        const y = .2 + i / 20 * .6;
        const half = .16 - i / 20 * .05;
        left.push({ x: .5 - half, y });
        right.push({ x: .5 + half, y });
      }
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '杯身草图', x: 60, y: 60, width: 1024, height: 768, createdAt: now, updatedAt: now,
          layers: [{ id: 'ink', name: '草图', kind: 'ink', visible: true, opacity: 1,
            strokes: [{ points: left, size: 6, color: '#202020' }, { points: right, size: 6, color: '#202020' }] }]
        };
      });
      return id;
    }, projectId);

    // ── A. 造型发散（真实出图，2 个方向）──
    await page.goto(origin + '/workbench.html?project=' + projectId);
    await page.waitForSelector('#workbenchShell');
    await page.waitForSelector('.wb-node', { timeout: 15000 });
    await page.click('.wb-node');
    await page.waitForSelector('#exploreDiverge', { timeout: 10000 });
    await page.selectOption('#exploreCount', '4');
    const t0 = Date.now();
    await page.click('#exploreDiverge');
    // 显式轮询：发散是串行出图，按张数等
    for (let i = 0; i < 120; i++) {
      const count = await page.evaluate(async pid => {
        const doc = await window.WuyingWorkspace.open(pid).read();
        return Object.values(doc.assets).filter(a => a.variant?.mode === 'diverge').length;
      }, projectId);
      if (count >= 2) break;
      await sleep(2000);
    }
    const diverged = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const doc = await store.read();
      const variants = Object.values(doc.assets).filter(a => a.variant?.mode === 'diverge');
      let readable = 0;
      for (const variant of variants) {
        const blobId = variant.layers?.[0]?.blobId;
        const blob = blobId ? await store.getBlob(blobId) : null;
        if (blob && blob.size > 2000) readable++;
      }
      return { count: variants.length, readable, labels: variants.map(v => v.variant.label),
        status: document.querySelector('#workbenchStatus')?.textContent };
    }, projectId);
    const divergeSeconds = ((Date.now() - t0) / 1000).toFixed(0);
    check('造型发散真实产出多个方向', diverged.count >= 2,
      diverged.count + ' 张 · ' + divergeSeconds + 's · ' + (diverged.labels.join('、') || '状态：' + (diverged.status || '空')));
    check('发散结果是可用图片（非空 blob）', diverged.readable === diverged.count,
      diverged.readable + '/' + diverged.count);

    // ── B. 白模 + 精细渲染（真实出图）──
    const partAssetId = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const id = crypto.randomUUID(), now = Date.now();
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '台灯（已确认造型）', x: 420, y: 60, width: 800, height: 600, createdAt: now, updatedAt: now,
          layers: [], flow: { stage: 'render' },
          draft: { revision: 'r0', parts: [
            { id: 'body', shape: 'polygon', name: '灯体', locked: true, x: 400, y: 340, width: 260, height: 300,
              angle: 0, depth: 90, z: 0,
              points: [{ x: -.5, y: -.5 }, { x: .5, y: -.5 }, { x: .38, y: .5 }, { x: -.38, y: .5 }] },
            { id: 'shade', shape: 'polygon', name: '灯罩', locked: true, x: 400, y: 150, width: 320, height: 150,
              angle: 0, depth: 120, z: 0,
              points: [{ x: -.5, y: -.42 }, { x: .5, y: -.42 }, { x: .28, y: .5 }, { x: -.28, y: .5 }] }
          ] }
        };
      });
      return id;
    }, projectId);

    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + partAssetId);
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.waitForSelector('#runMold:not([disabled])', { timeout: 15000 });
    await sleep(800);

    const t1 = Date.now();
    await page.click('#runMold');
    await page.waitForFunction(() => document.querySelector('#stepFinal')?.dataset.state === 'ready', null, { timeout: 240000 })
      .catch(() => {});
    const moldState = await page.evaluate(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const target = Object.values(doc.assets).find(a => a.render?.mold);
      const mold = target?.render?.mold;
      const store = window.WuyingWorkspace.open(pid);
      let blobSize = 0;
      const blobId = mold?.blobId;
      const blob = blobId ? await store.getBlob(blobId) : null;
      blobSize = blob?.size || 0;
      return { ready: document.querySelector('#stepFinal')?.dataset.state,
        status: document.querySelector('#flowStatus')?.textContent,
        mold: mold || null, blobSize };
    }, projectId);
    const moldSeconds = ((Date.now() - t1) / 1000).toFixed(0);
    check('白模真实生成并解锁精修', moldState.ready === 'ready' && !!moldState.mold,
      moldSeconds + 's · ' + (moldState.status || ''));
    check('白模图可用', moldState.blobSize > 2000, moldState.blobSize + ' bytes');
    check('白模记录了机位', !!moldState.mold?.angles, JSON.stringify(moldState.mold?.angles));

    // 精细渲染
    await page.fill('#finalPrompt', '哑光白陶瓷机身，拉丝铝环，柔和影棚光');
    const t2 = Date.now();
    await page.click('#runFinal');
    for (let i = 0; i < 120; i++) {
      const done = await page.evaluate(async pid => {
        const doc = await window.WuyingWorkspace.open(pid).read();
        const target = Object.values(doc.assets).find(a => a.render?.mold && a.render?.final);
        return !!target;
      }, projectId);
      if (done) break;
      await sleep(2000);
    }
    const finalState = await page.evaluate(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const target = Object.values(doc.assets).find(a => a.render?.mold);
      const final = target?.render?.final;
      const store = window.WuyingWorkspace.open(pid);
      let size = 0, job = null;
      if (final?.blobId) {
        const blob = await store.getBlob(final.blobId);
        size = blob?.size || 0;
        job = Object.values(doc.jobs).find(j => j.outputs?.some(o => o.id === final.assetId));
      }
      return { hasFinal: !!final, size, sourceId: job?.sourceId,
        moldId: target?.render?.mold?.assetId, status: document.querySelector('#flowStatus')?.textContent };
    }, projectId);
    const finalSeconds = ((Date.now() - t2) / 1000).toFixed(0);
    check('精细渲染真实产出成品图', finalState.hasFinal && finalState.size > 2000,
      finalSeconds + 's · ' + finalState.size + ' bytes');
    check('精修以白模为源（造型与机位一致）', finalState.sourceId === finalState.moldId,
      '源 ' + String(finalState.sourceId).slice(0, 8) + ' / 白模 ' + String(finalState.moldId).slice(0, 8));

    check('无页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    if (projectId) {
      try {
        const cleanup = loadPlaywright();
        const b = await cleanup.chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
        const p = await b.newPage();
        await p.goto(origin + '/files.html');
        await p.evaluate(async id => { await fetch('/api/projects/' + id, { method: 'DELETE' }); }, projectId);
        await b.close();
      } catch (error) { console.log('清理项目失败:', error.message); }
    }
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { console.log('失败项：' + failed.map(item => item.name).join('；')); process.exitCode = 1; }
})();
