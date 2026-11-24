// P8 场景板界面验收：
// 1) 场景板只在产品渲染阶段出现，草图阶段自动收起
// 2) 打开场景板后主画布让位，产品可放入、可点选场景/光照/材质
// 3) 所有选择写进 asset.render.scene，刷新后保持
// 运行：node tools/e2e-scene-board.cjs（需要 8881 服务）
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

(async () => {
  const playwright = loadPlaywright();
  const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let projectId = null;

  try {
    await page.goto(origin + '/files.html');
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('场景板E2E')).id);

    const assetId = await page.evaluate(async pid => {
      const id = crypto.randomUUID(), now = Date.now();
      const store = window.WuyingWorkspace.open(pid);
      // 造一张白底灰块当白模，避免 E2E 真的去跑模型。
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 320;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, 320, 320);
      context.fillStyle = '#b8b8b8'; context.fillRect(96, 70, 128, 190);
      context.fillStyle = '#9a9a9a'; context.fillRect(150, 40, 20, 40);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const blobId = crypto.randomUUID();
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '场景板测试', x: 60, y: 60, width: 640, height: 480,
          createdAt: now, updatedAt: now, layers: [], flow: { stage: 'render' },
          render: { mold: { assetId: 'mold-1', blobId, view: 'front', geometry: null, angles: { azimuth: 0, elevation: 0 }, confirmedAt: now, material: '' } }
        };
      }, [{ id: blobId, blob }]);
      return id;
    }, projectId);

    const url = origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId;
    await page.goto(url);
    await page.waitForSelector('#studioStage', { timeout: 20000 });
    await page.waitForFunction(() => window.WuyingSceneBoard && window.WuyingWorkflow, { timeout: 15000 });

    const panel = await page.evaluate(() => ({
      groupHidden: document.querySelector('#sceneGroup')?.hidden,
      presets: document.querySelectorAll('#scenePresets [data-preset]').length,
      lightings: document.querySelectorAll('#sceneLightings [data-lighting]').length,
      materials: document.querySelectorAll('#sceneMaterials [data-material]').length,
      boardHidden: document.querySelector('#studioSceneBoard')?.hidden
    }));
    check('渲染阶段出现场景板分组', panel.groupHidden === false);
    check('场景/光照/材质三组按钮就位', panel.presets === 4 && panel.lightings === 4 && panel.materials === 6,
      JSON.stringify(panel));
    check('场景板默认收起', panel.boardHidden === true);

    await page.click('#sceneToggle');
    const opened = await page.evaluate(() => ({
      boardHidden: document.querySelector('#studioSceneBoard')?.hidden,
      canvasHidden: document.querySelector('#studioCanvasBox')?.hidden,
      toggle: document.querySelector('#sceneToggle')?.textContent
    }));
    check('打开场景板后主画布让位', opened.boardHidden === false && opened.canvasHidden === true, JSON.stringify(opened));

    await page.click('#sceneUseMoldInPanel');
    await page.waitForFunction(() => !!document.querySelector('#sceneProduct'), { timeout: 8000 });
    const placed = await page.evaluate(() => {
      const img = document.querySelector('#sceneProduct');
      const rect = img.getBoundingClientRect();
      const board = document.querySelector('#studioSceneBoard');
      const box = document.querySelector('#studioCanvasBox');
      return {
        width: Math.round(rect.width), height: Math.round(rect.height),
        empty: document.querySelector('#sceneEmpty').hidden,
        natural: [img.naturalWidth, img.naturalHeight],
        inline: [img.style.width, img.style.height],
        board: [board.style.width, board.style.height],
        canvasBox: [box.style.width, box.style.height]
      };
    });
    check('白模放入场景并显示为可拖动对象', placed.width > 40 && placed.height > 40 && placed.empty === true, JSON.stringify(placed));

    await page.click('#scenePresets [data-preset="desk"]');
    await page.click('#sceneLightings [data-lighting="night"]');
    await page.click('#sceneMaterials [data-material="glass"]');
    await page.waitForTimeout(700);

    const stored = await page.evaluate(async ({ pid, id }) => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return doc.assets[id]?.render?.scene || null;
    }, { pid: projectId, id: assetId });
    check('场景选择写进 render.scene', stored?.scene === 'desk' && stored?.blocks?.length === 2,
      JSON.stringify({ scene: stored?.scene, blocks: stored?.blocks?.length }));
    check('光照与材质写进 render.scene', stored?.lighting === 'night' && stored?.material === 'glass',
      JSON.stringify({ lighting: stored?.lighting, material: stored?.material }));
    check('产品记录来源为白模', stored?.product?.source === 'mold' && !!stored?.product?.blobId);

    // 再点一次材质即取消。
    await page.click('#sceneMaterials [data-material="glass"]');
    await page.waitForTimeout(500);
    const cleared = await page.evaluate(async ({ pid, id }) => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return doc.assets[id]?.render?.scene?.material;
    }, { pid: projectId, id: assetId });
    check('再点同一材质可取消', cleared === '', 'material=' + JSON.stringify(cleared));

    await page.screenshot({ path: path.join(__dirname, 'p8-ui-board.png'), clip: { x: 0, y: 60, width: 1440, height: 840 } });

    // 刷新后状态保持。
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 20000 });
    await page.waitForFunction(() => window.WuyingSceneBoard, { timeout: 15000 });
    const afterReload = await page.evaluate(() => ({
      pressed: document.querySelector('#scenePresets [data-preset="desk"]')?.getAttribute('aria-pressed'),
      lighting: document.querySelector('#sceneLightings [data-lighting="night"]')?.getAttribute('aria-pressed'),
      boardHidden: document.querySelector('#studioSceneBoard')?.hidden
    }));
    check('刷新后场景选择保持', afterReload.pressed === 'true' && afterReload.lighting === 'true', JSON.stringify(afterReload));

    // 回到草图阶段，场景板要收起。
    await page.evaluate(async ({ pid, id }) => {
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => { doc.assets[id].flow = { ...(doc.assets[id].flow || {}), stage: 'sketch' }; });
    }, { pid: projectId, id: assetId });
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 20000 });
    await page.waitForTimeout(900);
    const inSketch = await page.evaluate(() => ({
      groupHidden: document.querySelector('#sceneGroup')?.hidden,
      boardHidden: document.querySelector('#studioSceneBoard')?.hidden
    }));
    check('草图阶段收起场景板', inSketch.groupHidden === true && inSketch.boardHidden === true, JSON.stringify(inSketch));

    check('页面无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    if (projectId) {
      await page.goto(origin + '/files.html').catch(() => {});
      await page.evaluate(async id => { await window.WuyingProjects.remove(id); }, projectId).catch(() => {});
    }
    await browser.close();
    const failed = results.filter(item => !item.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    process.exit(failed.length ? 1 : 0);
  }
})();
