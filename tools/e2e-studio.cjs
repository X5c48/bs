// 图像工作室浏览器端到端验收：新建临时项目 → 放一张程序生成的台灯线稿 → 打开图像工作室。
// 运行：node tools/e2e-studio.cjs <场景名…>；场景见文件末尾。结束时删除临时项目。
// 依赖：本机 8881 工作区、Playwright（npx 缓存）、可选 ComfyUI 8188。
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
const endpoint = process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? ' · ' + detail : ''));
}

// 台灯线稿笔触（归一化坐标）
const lampStrokes = [
  [[.35,.86],[.65,.86]], [[.5,.86],[.5,.5]], [[.5,.5],[.62,.36]],
  [[.40,.36],[.84,.36],[.74,.18],[.50,.18],[.40,.36]]
].map(points => ({ color: '#202020', size: 6, points: points.map(([x, y]) => ({ x, y })) }));

async function setup(page, { width = 1024, height = 768, strokes = lampStrokes, model } = {}) {
  await page.goto(origin + '/files.html');
  await page.waitForFunction(() => window.WuyingProjects && window.WuyingWorkspace);
  return page.evaluate(async ({ width, height, strokes, model, endpoint }) => {
    const project = await window.WuyingProjects.create('e2e-' + Date.now());
    const store = window.WuyingWorkspace.open(project.id);
    const id = crypto.randomUUID(), layer = crypto.randomUUID(), now = Date.now();
    await store.change(doc => {
      doc.assets[id] = { id, name: '台灯草图', x: 80, y: 80, width, height, createdAt: now, updatedAt: now,
        layers: [{ id: layer, name: '手绘 1', kind: 'ink', visible: true, opacity: 1, strokes }] };
    });
    const prefs = { provider: 'comfy', endpoint, checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
      controlnet: 'control_v11p_sd15_scribble_fp16.safetensors', ...(model || {}) };
    localStorage.setItem('wuying-workspace-model-v1', JSON.stringify(prefs));
    return { projectId: project.id, assetId: id };
  }, { width, height, strokes, model, endpoint });
}

async function openStudio(page, ids) {
  await page.goto(origin + '/image-studio.html?project=' + ids.projectId + '&asset=' + ids.assetId);
  await page.waitForSelector('#studioShell:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#studioSaved')?.textContent !== '载入中');
}

async function cleanup(page, ids) {
  if (!ids) return;
  await page.goto(origin + '/files.html');
  await page.waitForFunction(() => window.WuyingProjects?.remove);
  await page.evaluate(id => window.WuyingProjects.remove(id), ids.projectId).catch(() => {});
}

async function main(scenarios) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let ids;
  try {
    for (const name of scenarios) {
      const run = module.exports.scenarios[name];
      if (!run) throw new Error('未知场景 ' + name);
      console.log('== ' + name);
      ids = await setup(page, run.setup);
      await openStudio(page, ids);
      await run(page, { check, ids, endpoint, origin, context });
      await cleanup(page, ids);
      ids = undefined;
    }
  } catch (error) {
    check('场景执行未抛错', false, error.stack?.split('\n').slice(0, 3).join(' | '));
  } finally {
    await cleanup(page, ids).catch(() => {});
    check('页面无未捕获异常', !errors.length, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  const failed = results.filter(item => !item.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' 通过');
  process.exitCode = failed ? 1 : 0;
}

module.exports = { scenarios: {}, check, setup, openStudio, cleanup };
// 场景定义写在 tools/e2e-scenarios.cjs，按名字注册。
Object.assign(module.exports.scenarios, require('./e2e-scenarios.cjs'));
if (require.main === module) main(process.argv.slice(2));
