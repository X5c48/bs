// 0.4 功能主次分层整理验收：
// 1) 三格阶段轨道：草图造型 → 精细微调 → 产品渲染
// 2) 草图阶段：产品方向、主题描述、一键转线稿一级露出；概念探索与更多工具默认折叠，展开可用
// 3) 渲染阶段：3D 角度 → 白模/精细渲染 → 产品展示主线连续；场景板与更多工具位于主线之后默认折叠，点「打开场景板」自动展开
// 4) 精细微调：规则推敲默认折叠，展开可用
// 5) 工作台：无视频生成入口（备选功能入口隐藏）
// 运行：node tools/e2e-tier-layout.cjs（需要 8881 服务）
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
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('分层整理E2E')).id);
    const assetId = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const id = crypto.randomUUID(), now = Date.now();
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '台灯测试', x: 60, y: 60, width: 640, height: 480,
          createdAt: now, updatedAt: now, layers: [], flow: { stage: 'sketch' },
          draft: { revision: 'r0', parts: [{
            id: 'shade', shape: 'rectangle', name: '灯罩', locked: false,
            x: 320, y: 200, width: 180, height: 110, angle: 0, depth: 60, z: 0
          }] }
        };
      });
      return id;
    }, projectId);

    // 1. 草图造型阶段
    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId + '&stage=sketch');
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.waitForTimeout(600);

    const sketch = await page.evaluate(() => {
      const steps = [...document.querySelectorAll('#studioFlowRail .flow-step b')].map(n => n.textContent.trim());
      const vis = sel => {
        const el = document.querySelector(sel);
        if (!el || el.hidden) return false;
        const rect = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      return {
        steps,
        briefVis: vis('#studioFlowBrief'),
        themeVis: vis('#studioThemeBrief'),
        lineartVis: vis('#studioToLineart'),
        conceptOpen: document.querySelector('#conceptMore')?.open,
        moreOpen: document.querySelector('#studioMoreTools')?.open,
        moreSummary: document.querySelector('#studioMoreSummary')?.textContent?.trim(),
        sceneHidden: document.querySelector('#sceneGroup')?.hidden
      };
    });
    check('图像工作室轨道为三格', sketch.steps.join('→') === '草图造型→精细微调→产品渲染', sketch.steps.join('→'));
    check('草图阶段产品方向与主题描述直接露出', sketch.briefVis && sketch.themeVis);
    check('草图阶段「一键转线稿」直接露出', sketch.lineartVis);
    check('草图阶段概念探索与更多工具默认折叠', sketch.conceptOpen === false && sketch.moreOpen === false);
    check('草图阶段更多工具文案准确', /改图/.test(sketch.moreSummary || ''), sketch.moreSummary);
    check('草图阶段场景板隐藏', sketch.sceneHidden === true);

    // 展开更多工具后，#studioKind 可见可用
    await page.click('#studioMoreSummary');
    const kindVisAfterOpen = await page.locator('#studioKind').isVisible();
    check('展开「更多工具」后生成表单可见', kindVisAfterOpen);

    // 2. 产品渲染阶段
    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId + '&stage=render');
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.waitForTimeout(600);

    const render = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.operations > .inspector-group')];
      const order = groups.map(g => g.id || (g.classList.contains('showcase') ? 'showcase' : 'other'));
      return {
        order,
        sceneOpen: document.querySelector('#sceneMore')?.open,
        moreOpen: document.querySelector('#studioMoreTools')?.open,
        moreSummary: document.querySelector('#studioMoreSummary')?.textContent?.trim()
      };
    });
    const angleIdx = render.order.indexOf('angleGroup');
    const flowIdx = render.order.indexOf('renderFlow');
    const showIdx = render.order.indexOf('showcase');
    const sceneIdx = render.order.indexOf('sceneGroup');
    check('渲染主线顺序为 角度 → 白模/精修 → 展示，场景板不截断主线',
      angleIdx >= 0 && angleIdx < flowIdx && flowIdx < showIdx && showIdx < sceneIdx,
      render.order.join(' → '));
    check('渲染阶段场景板设置与更多工具默认折叠', render.sceneOpen === false && render.moreOpen === false);
    check('渲染阶段更多工具文案准确', /高品质呈现/.test(render.moreSummary || ''), render.moreSummary);

    await page.click('#sceneToggle');
    const sceneOpened = await page.evaluate(() => ({
      moreOpen: document.querySelector('#sceneMore')?.open,
      boardHidden: document.querySelector('#studioSceneBoard')?.hidden
    }));
    check('点击「打开场景板」自动展开场景设置', sceneOpened.moreOpen === true && sceneOpened.boardHidden === false);

    // 3. 精细微调阶段
    await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
    const shape = await page.evaluate(() => ({
      steps: [...document.querySelectorAll('#shapeFlowRail .flow-step b')].map(n => n.textContent.trim()),
      moreOpen: document.querySelector('#shapeMoreTools')?.open
    }));
    const variantVisibleBefore = await page.locator('#variantForm').isVisible();
    check('精细微调轨道为三格', shape.steps.join('→') === '草图造型→精细微调→产品渲染', shape.steps.join('→'));
    check('精细微调「规则推敲」默认折叠在更多工具里', shape.moreOpen === false && variantVisibleBefore === false,
      `open=${shape.moreOpen}, visible=${variantVisibleBefore}`);

    await page.click('#shapeMoreTools > summary');
    const variantVisible = await page.locator('#variantForm').isVisible();
    check('展开精细微调更多工具后规则推敲可见', variantVisible);

    // 4. 工作台视频入口隐藏
    await page.goto(origin + '/workbench.html?project=' + projectId);
    await page.waitForSelector('#workbenchShell', { timeout: 15000 });
    const hasVideoBtn = await page.evaluate(() => !!document.querySelector('#openVideo'));
    check('工作台无视频生成入口（备选隐藏）', hasVideoBtn === false);

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
