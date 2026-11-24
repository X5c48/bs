// 本轮四项修复的浏览器端到端验收：
// 1) 描轮廓时画布上能看到正在描的线（.trace-line），松手后部件落库
// 2) 出图后轮廓线仍叠加在预览上（#liveOutline .live-contour）
// 3) Qwen 模型开实时辅助：走 Qwen 通道（renderQwen），不再把分体式模型塞进 SD 工作流
// 4) Qwen 实时帧把结构图当参考图、分辨率压在 640 以内
// 运行：node tools/e2e-render-fixes.cjs（需要 8881 服务）
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
const QWEN = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '✔ ' : '✘ ') + name + (detail ? ' · ' + detail : ''));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 1×1 PNG：伪造渲染输出
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function createProject(page, name) {
  return page.evaluate(async label => (await window.WuyingProjects.create(label)).id, name);
}
async function removeProject(page, projectId) {
  try { await page.evaluate(async id => { await fetch('/api/projects/' + id, { method: 'DELETE' }); }, projectId); }
  catch (error) { console.log('清理失败（可手动删除）:', projectId, error.message); }
}

async function seedAsset(page, projectId) {
  return page.evaluate(async pid => {
    const store = window.WuyingWorkspace.open(pid);
    const id = crypto.randomUUID(), now = Date.now();
    await store.change(doc => {
      doc.assets[id] = {
        id, name: '杯体部件', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now, layers: [],
        draft: {
          revision: 'r0',
          parts: [
            { id: 'body', shape: 'rectangle', name: '杯体', locked: false, x: 512, y: 420, width: 220, height: 300, angle: 0, depth: 60, z: 0 },
            { id: 'lid', shape: 'rectangle', name: '杯盖', locked: false, x: 512, y: 240, width: 240, height: 60, angle: 0, depth: 60, z: 60 }
          ]
        }
      };
    });
    return id;
  }, projectId);
}

/* ── 1) 描轮廓时能看到线 ── */
async function scenarioTraceVisible(page, projectId, assetId) {
  await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
  await page.click('#tracePart');
  await sleep(200);
  const before = await page.evaluate(() => document.querySelectorAll('#shapeCanvas polygon[data-part]').length);
  const box = await page.evaluate(() => {
    const rect = document.querySelector('#shapeCanvas').getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  const startX = box.x + box.w * 0.18, startY = box.y + box.h * 0.2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 描一个闭合方框（中途不松手，检查线是否已经画出来）
  const path = [[0.38, 0.2], [0.38, 0.42], [0.18, 0.42], [0.18, 0.2]];
  for (const [rx, ry] of path) {
    await page.mouse.move(box.x + box.w * rx, box.y + box.h * ry, { steps: 12 });
    await sleep(60);
  }
  const during = await page.evaluate(() => {
    const line = document.querySelector('#shapeCanvas polyline.trace-line');
    if (!line) return null;
    const style = getComputedStyle(line);
    return { points: line.getAttribute('points').trim().split(/\s+/).length, stroke: style.stroke, width: style.strokeWidth };
  });
  check('描轮廓过程中画布显示笔迹（polyline.trace-line）', during && during.points > 3, JSON.stringify(during));
  check('描线笔迹有可见描边', during && parseFloat(during.width) > 0 && during.stroke !== 'none', during && during.stroke + ' / ' + during.width);
  await page.mouse.up();
  await sleep(900);
  const after = await page.evaluate(() => document.querySelectorAll('#shapeCanvas polygon[data-part]').length);
  check('松手后新部件落库（画布多边形 +1）', after === before + 1, before + ' → ' + after);
  check('描完退出描线模式（笔迹已清理）', await page.evaluate(() => !document.querySelector('#shapeCanvas polyline.trace-line')));
}

/* ── 2) 实时辅助：Qwen 走 Qwen 通道 + 出图后轮廓仍在 ── */
async function scenarioQwenLive(page, projectId, assetId) {
  await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
  await page.evaluate(png => {
    window.__calls = { qwen: [], live: [] };
    const blob = () => fetch('data:image/png;base64,' + png).then(response => response.blob());
    window.WuyingComfy.renderLive = async options => {
      window.__calls.live.push(options);
      throw new Error('不该走 SD 实时通道：' + options.checkpoint);
    };
    window.WuyingComfy.renderQwen = async options => {
      window.__calls.qwen.push({ resolution: options.resolution, checkpoint: options.checkpoint,
        hasReference: options.sourceImage instanceof Blob });
      return { blob: await blob() };
    };
  }, TINY_PNG);
  await page.click('#liveToggle');
  await page.waitForFunction(() => !document.querySelector('#liveImage').hidden, null, { timeout: 20000 });
  await sleep(400);
  const state = await page.evaluate(() => ({
    calls: window.__calls,
    contours: document.querySelectorAll('#liveOutline .live-contour').length,
    contoursAll: document.querySelectorAll('#liveOutline polygon').length,
    imageShown: !document.querySelector('#liveImage').hidden,
    liveState: document.querySelector('#liveState').textContent
  }));
  check('Qwen 模型实时辅助走 Qwen 通道（renderQwen 被调用）', state.calls.qwen.length >= 1, JSON.stringify(state.calls.qwen));
  check('Qwen 模型不再被塞进 SD 实时通道', state.calls.live.length === 0, 'renderLive 调用 ' + state.calls.live.length + ' 次');
  check('实时帧把结构图作为参考图下发', state.calls.qwen.every(call => call.hasReference), 'hasReference');
  check('实时帧分辨率压在 640 以内（8G 显存）', state.calls.qwen.every(call => call.resolution <= 640),
    state.calls.qwen.map(call => call.resolution).join(','));
  check('出图后预览显示', state.imageShown, state.liveState);
  check('出图后轮廓线仍叠加在预览上（.live-contour）', state.contours >= 1, state.contours + ' 条轮廓');
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const created = [];
  try {
    await page.goto(origin + '/workbench.html');
    await page.addInitScript(model => {
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify(model));
    }, { endpoint: 'http://127.0.0.1:8188', checkpoint: QWEN, controlnet: '' });

    const projectId = await createProject(page, 'e2e-render-' + Date.now());
    created.push(projectId);
    const assetId = await seedAsset(page, projectId);
    await scenarioTraceVisible(page, projectId, assetId);
    await scenarioQwenLive(page, projectId, assetId);
  } catch (error) {
    console.error('E2E 异常：', error);
    results.push({ name: '执行异常', ok: false, detail: error.message });
  } finally {
    for (const id of created) await removeProject(page, id);
    await browser.close();
  }
  const passed = results.filter(item => item.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
