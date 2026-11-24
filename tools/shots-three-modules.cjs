// 三模块实景截图（造一份带草图与部件的样例项目，截三页后清理）
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
const outDir = path.join(__dirname, 'shots');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const playwright = loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({
        provider: 'comfy', endpoint: 'http://127.0.0.1:8188',
        checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
        controlnet: 'control_v11p_sd15_scribble_fp16.safetensors'
      }));
    } catch {}
  });
  let projectId = null;
  try {
    await page.goto(origin + '/files.html');
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('三模块界面')).id);
    const ids = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const sketchId = crypto.randomUUID(), partId = crypto.randomUUID(), now = Date.now();
      const left = [], right = [];
      for (let i = 0; i <= 22; i++) {
        const y = .18 + i / 22 * .64;
        const half = .15 - i / 22 * .04;
        left.push({ x: .5 - half, y: Math.round(y * 1000) / 1000 });
        right.push({ x: .5 + half, y: Math.round(y * 1000) / 1000 });
      }
      const wobble = Array.from({ length: 24 }, (_, i) => {
        const t = i / 24 * Math.PI * 2, r = .5 + (i % 4 === 0 ? .055 : i % 3 === 0 ? -.045 : 0);
        return { x: Math.round(r * Math.cos(t) * 1000) / 1000, y: Math.round(r * Math.sin(t) * 1000) / 1000 };
      });
      await store.change(doc => {
        doc.assets[sketchId] = {
          id: sketchId, name: '保温杯草图', x: 60, y: 60, width: 1024, height: 768, createdAt: now, updatedAt: now,
          layers: [{ id: 'ink', name: '草图', kind: 'ink', visible: true, opacity: 1,
            strokes: [{ points: left, size: 6, color: '#202020' }, { points: right, size: 6, color: '#202020' }] }]
        };
        doc.assets[partId] = {
          id: partId, name: '台灯（已确认造型）', x: 430, y: 60, width: 800, height: 600,
          createdAt: now, updatedAt: now, layers: [], flow: { stage: 'render' },
          draft: { revision: 'r0', parts: [
            { id: 'body', shape: 'polygon', name: '灯体', locked: true, x: 400, y: 350, width: 250, height: 290,
              angle: 0, depth: 90, z: 0, points: [{ x: -.5, y: -.5 }, { x: .5, y: -.5 }, { x: .36, y: .5 }, { x: -.36, y: .5 }] },
            { id: 'shade', shape: 'polygon', name: '灯罩', locked: false, x: 400, y: 150, width: 330, height: 150,
              angle: 0, depth: 120, z: 0, points: wobble }
          ] }
        };
      });
      return { sketchId, partId };
    }, projectId);

    // 1. 草图造型模块
    await page.goto(origin + '/workbench.html?project=' + projectId);
    await page.waitForSelector('.wb-node', { timeout: 15000 });
    await page.click('.wb-node');
    await page.waitForSelector('#exploreDiverge', { timeout: 10000 });
    await sleep(600);
    await page.screenshot({ path: path.join(outDir, '1-草图造型.png') });

    // 2. 精细微调模块（选中灯罩，显示规整化建议）
    await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + ids.partId);
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('#tidySuggest', { timeout: 10000 });
    const parts = await page.$$('#shapeParts button');
    if (parts[1]) await parts[1].click();
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, '2-精细微调.png') });

    // 3. 产品渲染模块
    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + ids.partId);
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await sleep(1200);
    await page.screenshot({ path: path.join(outDir, '3-产品渲染.png') });
    console.log('截图完成：' + outDir);
  } finally {
    await browser.close();
    if (projectId) {
      const b = await loadPlaywright().chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
      const p = await b.newPage();
      await p.goto(origin + '/files.html');
      await p.evaluate(async id => { await fetch('/api/projects/' + id, { method: 'DELETE' }); }, projectId);
      await b.close();
    }
  }
})();
