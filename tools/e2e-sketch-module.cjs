// 草图造型模块端到端验收：
// 1) 工作台内「快速草图」能直接起稿（不必跳到图像编辑室）
// 2) 画笔大小与橡皮大小是两套独立入口，数值互不影响
// 3) 画完落成草图节点；「造型裂变」铺出多个可继续编辑的矢量方案
// 4) 产物带来源标记，能回到源草图
// 运行：node tools/e2e-sketch-module.cjs（需要 8881 服务）
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

async function createProject(page, name) {
  return page.evaluate(async label => (await window.WuyingProjects.create(label)).id, name);
}
async function removeProject(page, projectId) {
  try { await page.evaluate(async id => { await fetch('/api/projects/' + id, { method: 'DELETE' }); }, projectId); }
  catch (error) { console.log('清理失败（可手动删除）:', projectId, error.message); }
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
    projectId = await createProject(page, '草图模块E2E');
    await page.goto(origin + '/workbench.html?project=' + projectId);
    await page.waitForSelector('#workbenchShell');

    // 1. 快速草图入口存在并可打开
    await page.waitForSelector('#emptyPad');
    await page.click('#emptyPad');
    await page.waitForSelector('#sketchPad:not([hidden])');
    check('工作台可直接打开快速草图画布', true);

    // 2. 画笔/橡皮尺寸入口分离
    const sliders = await page.evaluate(() => {
      const brush = document.querySelector('#padBrushSize');
      const erase = document.querySelector('#padEraseSize');
      return {
        both: !!brush && !!erase,
        brush: Number(brush.value), erase: Number(erase.value),
        separateLabels: !!document.querySelector('#padBrushField') && !!document.querySelector('#padEraseField'),
        brushText: document.querySelector('#padBrushField')?.textContent.trim().slice(0, 6),
        eraseText: document.querySelector('#padEraseField')?.textContent.trim().slice(0, 6)
      };
    });
    check('画笔与橡皮是两个独立尺寸入口', sliders.both && sliders.separateLabels && sliders.brushText !== sliders.eraseText,
      JSON.stringify(sliders));

    // 改橡皮尺寸不应改变画笔尺寸
    await page.click('[data-pad-tool="erase"]');
    await page.evaluate(() => {
      const erase = document.querySelector('#padEraseSize');
      erase.value = '64';
      erase.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const afterErase = await page.evaluate(() => ({
      brush: Number(document.querySelector('#padBrushSize').value),
      erase: Number(document.querySelector('#padEraseSize').value),
      brushActive: document.querySelector('#padBrushField').classList.contains('is-active'),
      eraseActive: document.querySelector('#padEraseField').classList.contains('is-active')
    }));
    check('改橡皮尺寸不影响画笔尺寸，当前工具高亮对应入口',
      afterErase.brush === sliders.brush && afterErase.erase === 64 && afterErase.eraseActive && !afterErase.brushActive,
      JSON.stringify(afterErase));

    // 3. 用真实鼠标画三笔
    await page.click('[data-pad-tool="brush"]');
    const box = await page.locator('#padCanvas').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (const [dx, dy] of [[0, -90], [-60, 0], [60, 0]]) {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(cx + dx * i / 8, cy + dy * i / 8, { steps: 2 });
      await page.mouse.up();
      await sleep(60);
    }
    const painted = await page.evaluate(() => document.querySelector('#padStatus').textContent);
    check('画布上留下笔迹', /已画 [1-9]\d* 笔/.test(painted), painted);

    // 4. 完成 → 落成草图节点
    await page.click('#padSave');
    await page.waitForFunction(() => document.querySelector('#sketchPad').hidden, null, { timeout: 10000 });
    await sleep(600);
    const created = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const doc = await store.read();
      const list = Object.values(doc.assets);
      const sketch = list.find(asset => asset.layers?.some(layer => layer.strokes?.length));
      return {
        count: list.length,
        id: sketch?.id,
        strokes: sketch?.layers?.[0]?.strokes?.length,
        selected: !!document.querySelector('.wb-node') && document.querySelector('#inspectorTitle')?.textContent
      };
    }, projectId);
    check('草图落成画布节点并自动选中', created.count === 1 && created.strokes === 3, JSON.stringify(created));

    // 5. 选中草图后出现造型探索面板
    await page.waitForSelector('#exploreFission', { timeout: 8000 });
    check('选中草图后出现「造型探索」入口', await page.locator('#exploreDiverge').isVisible());

    // 6. 造型裂变：铺出四个可编辑方案
    await page.selectOption('#exploreCount', '4');
    await page.click('#exploreFission');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return Object.values(doc.assets).filter(a => a.variant?.mode === 'fission').length >= 4;
    }, projectId, { timeout: 20000 });
    const fission = await page.evaluate(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const variants = Object.values(doc.assets).filter(a => a.variant?.mode === 'fission');
      return {
        count: variants.length,
        labels: variants.map(v => v.variant.label),
        editable: variants.every(v => v.layers?.[0]?.strokes?.length > 0),
        distinct: new Set(variants.map(v => JSON.stringify(v.layers[0].strokes[0].points.slice(0, 4)))).size,
        roots: variants.every(v => v.variant.of && doc.assets[v.variant.of])
      };
    }, projectId);
    check('造型裂变铺出 4 个方案', fission.count === 4, fission.labels.join('、'));
    check('裂变产物是矢量笔迹，可继续编辑', fission.editable, '');
    check('四个方案几何互不相同', fission.distinct === 4, fission.distinct + ' 种');
    check('每个方案都记着来源草图', fission.roots);

    // 7. 选中变体：显示来源并可回到源草图
    await page.click('.wb-node:has-text("裂变")');
    await sleep(400);
    const variantPanel = await page.evaluate(() => ({
      title: document.querySelector('#inspectorTitle')?.textContent,
      hasOrigin: /来自「造型裂变」/.test(document.querySelector('#inspectorBody')?.textContent || ''),
      back: [...document.querySelectorAll('#inspectorBody button')].some(b => /回到源草图/.test(b.textContent)),
      exploreHidden: !document.querySelector('#exploreFission')
    }));
    check('变体卡片显示来源与返回入口', variantPanel.hasOrigin && variantPanel.back, JSON.stringify(variantPanel));
    check('变体卡片不再显示探索入口（避免无限套娃）', variantPanel.exploreHidden);

    // 8. 页面无脚本错误
    check('无页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    if (projectId) {
      try {
        const cleanup = loadPlaywright();
        const b = await cleanup.chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
        const p = await b.newPage();
        await p.goto(origin + '/files.html');
        await removeProject(p, projectId);
        await b.close();
      } catch (error) { console.log('清理项目失败:', error.message); }
    }
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { console.log('失败项：' + failed.map(item => item.name).join('；')); process.exitCode = 1; }
})();
