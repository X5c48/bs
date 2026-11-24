// P7 草图阶段实时辅助（造型探索）界面验收：
// 1) 草图阶段把「AI 强度」换成探索幅度三档 + 造型倾向，非草图阶段还原
// 2) 档位与倾向写入 asset.sketchExplore，刷新后保持
// 3) 候选条与「描回画布」入口就位
// 运行：node tools/e2e-sketch-explore.cjs（需要 8881 服务）
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let projectId = null;

  try {
    await page.goto(origin + '/files.html');
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('造型探索E2E')).id);

    const assetId = await page.evaluate(async pid => {
      const id = crypto.randomUUID(), now = Date.now();
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '探索测试', x: 60, y: 60, width: 640, height: 480,
          createdAt: now, updatedAt: now, layers: [], flow: { stage: 'sketch' }
        };
      });
      return id;
    }, projectId);

    const url = origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId;
    await page.goto(url);
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    // 让「实时辅助」按钮认为模型已配置，但不落笔就不会真的出图。要在这个页面写，
    // 因为模型偏好由 workspace-workflow 管理，files 页不加载它。
    await page.evaluate(() => window.WuyingWorkflow.saveModel({
      endpoint: 'http://127.0.0.1:8188',
      checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
      controlnet: 'control_v11p_sd15_scribble_fp16.safetensors'
    }));
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.click('#studioLive');
    await page.waitForSelector('#studioLiveBar:not([hidden])', { timeout: 10000 });

    const before = await page.evaluate(() => ({
      tierHidden: document.querySelector('#studioExploreTier').hidden,
      tiers: [...document.querySelectorAll('[data-explore-tier]')].map(b => b.textContent.trim()),
      strengthHidden: document.querySelector('#studioLiveStrengthField').hidden,
      tendencyHidden: document.querySelector('#studioTendency').hidden,
      candidatesExists: !!document.querySelector('#studioLiveCandidates'),
      traceExists: !!document.querySelector('#studioLiveTrace')
    }));
    check('草图阶段出现探索幅度三档', !before.tierHidden && before.tiers.join('/') === '贴线/推敲/发散', before.tiers.join('/'));
    check('草图阶段收起裸 AI 强度滑块', before.strengthHidden === true);
    check('草图阶段出现造型倾向入口', before.tendencyHidden === false);
    check('候选条与描回画布入口就位', before.candidatesExists && before.traceExists);
    await page.screenshot({ path: path.join(__dirname, 'p7-ui-bar.png'), clip: { x: 0, y: 60, width: 1440, height: 840 } });

    await page.click('[data-explore-tier="loose"]');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return Object.values(doc.assets).some(a => a.sketchExplore?.tier === 'loose');
    }, projectId, { timeout: 8000 });
    check('「发散」写入 asset.sketchExplore.tier', true);

    await page.click('#studioTendency');
    const groups = await page.evaluate(() => [...document.querySelectorAll('#studioTendencyGroups .tendency-row')]
      .map(row => ({ label: row.querySelector('strong').textContent.trim(), options: [...row.querySelectorAll('button')].map(b => b.textContent.trim()) })));
    check('倾向浮层三组对偶', groups.map(g => g.label + ':' + g.options.join('')).join('|') === '繁简:简繁|曲直:几何有机|厚薄:厚重轻薄',
      JSON.stringify(groups));
    await page.screenshot({ path: path.join(__dirname, 'p7-ui-tendency.png'), clip: { x: 0, y: 60, width: 1440, height: 840 } });
    await page.click('[data-tendency-group="form"][data-tendency-option="organic"]');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return Object.values(doc.assets).some(a => a.sketchExplore?.tendency?.form === 'organic');
    }, projectId, { timeout: 8000 });
    check('「有机」写入 asset.sketchExplore.tendency.form', true);

    // 刷新保持
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.click('#studioLive');
    await page.waitForSelector('#studioLiveBar:not([hidden])', { timeout: 10000 });
    const after = await page.evaluate(() => ({
      loose: document.querySelector('[data-explore-tier="loose"]')?.getAttribute('aria-pressed'),
      organic: document.querySelector('[data-tendency-group="form"][data-tendency-option="organic"]')?.getAttribute('aria-pressed'),
      label: document.querySelector('#studioTendency')?.textContent.trim()
    }));
    check('刷新后档位仍在「发散」', after.loose === 'true');
    check('刷新后倾向仍选中「有机」', after.organic === 'true', after.label);

    // 再点一次取消（浮层刷新后是收起的，先打开）
    await page.click('#studioTendency');
    await page.waitForSelector('#studioTendencyPop:not([hidden])', { timeout: 5000 });
    await page.click('[data-tendency-group="form"][data-tendency-option="organic"]');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const saved = Object.values(doc.assets)[0]?.sketchExplore;
      return !saved?.tendency?.form;
    }, projectId, { timeout: 8000 });
    check('再点一次取消该组倾向', true);

    // 非草图阶段：还原 AI 强度
    await page.evaluate(async ({ pid, id }) => {
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => { if (doc.assets[id]) doc.assets[id].flow = { ...(doc.assets[id].flow || {}), stage: 'refine' }; });
    }, { pid: projectId, id: assetId });
    await page.goto(url);
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.click('#studioLive');
    await page.waitForSelector('#studioLiveBar:not([hidden])', { timeout: 10000 });
    const refine = await page.evaluate(() => ({
      tierHidden: document.querySelector('#studioExploreTier').hidden,
      strengthHidden: document.querySelector('#studioLiveStrengthField').hidden,
      tendencyHidden: document.querySelector('#studioTendency').hidden
    }));
    check('微调阶段收起探索控件', refine.tierHidden && refine.tendencyHidden);
    check('微调阶段恢复 AI 强度滑块', refine.strengthHidden === false);

    // 档位切回后仍可写：确认「贴线」也能落盘
    await page.evaluate(async ({ pid, id }) => {
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => { if (doc.assets[id]) doc.assets[id].flow = { ...(doc.assets[id].flow || {}), stage: 'sketch' }; });
    }, { pid: projectId, id: assetId });
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await page.click('#studioLive');
    await page.waitForSelector('#studioLiveBar:not([hidden])', { timeout: 10000 });
    await page.click('[data-explore-tier="tight"]');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      return Object.values(doc.assets).some(a => a.sketchExplore?.tier === 'tight');
    }, projectId, { timeout: 8000 });
    check('回到草图阶段可切到「贴线」并落盘', true);

    check('页面无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (error) {
    check('执行过程无异常', false, error.message);
  } finally {
    if (projectId) {
      try { await page.evaluate(async pid => { await fetch('/api/projects/' + pid, { method: 'DELETE' }); }, projectId); }
      catch { console.log('测试项目未自动清理：' + projectId); }
    }
    await browser.close();
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n通过 ' + (results.length - failed.length) + '/' + results.length);
  process.exitCode = failed.length ? 1 : 0;
})();
