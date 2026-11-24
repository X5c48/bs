// 四项修复的浏览器端到端验收：
// 1) 秒针（细长部件）轮廓线在精细调整画布可见
// 2) 草图修改后进入微调自动同步底图并作废旧渲染基准
// 3) 实时辅助：拖动采样在渲染进行中也不丢，最终按最新几何出帧
// 4) 生成视角：带部件数据时按视角投影结构线稿并几何锁定
// 运行：node tools/e2e-fixes.cjs。依赖本机 8881 工作区、Playwright（npx 缓存）。
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

// 1×1 PNG（页面里伪造渲染输出用）
const TINY_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

async function createProject(page, name) {
  return page.evaluate(async label => {
    const project = await window.WuyingProjects.create(label);
    return project.id;
  }, name);
}

async function removeProject(page, projectId) {
  try {
    await page.evaluate(async id => {
      await fetch('/api/projects/' + id, { method: 'DELETE' });
    }, projectId);
  } catch (error) { console.log('清理失败（可手动删除）:', projectId, error.message); }
}

/* ── 1) 秒针轮廓显示 ── */
async function scenarioSecondHand(page) {
  const projectId = await createProject(page, 'e2e-fixes-hand-' + Date.now());
  const assetId = await page.evaluate(async pid => {
    const store = window.WuyingWorkspace.open(pid);
    const id = crypto.randomUUID(), now = Date.now();
    const parts = [
      { id: 'face', shape: 'ellipse', name: '表盘', locked: false, x: 512, y: 384, width: 420, height: 420, angle: 0, depth: 60, z: 0 },
      // 细长秒针：4×80，旧版本 validate（≥8px）会拒绝；轮廓为矩形 4 点
      { id: 'second', shape: 'polygon', name: '秒针', locked: false, x: 700, y: 300, width: 4, height: 80, angle: 15, depth: 4, z: 4,
        points: [{ x: -.5, y: -.5 }, { x: .5, y: -.5 }, { x: .5, y: .5 }, { x: -.5, y: .5 }] }
    ];
    await store.change(doc => {
      doc.assets[id] = { id, name: '挂钟部件', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now,
        layers: [], draft: { revision: 'r0', parts } };
    });
    return id;
  }, projectId);
  await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
  await sleep(300);
  // 画布上存在秒针的 polygon 且有 ≥3 个点（SVG polygon 少于 3 点不渲染）
  const outline = await page.evaluate(() => {
    const node = document.querySelector('#shapeCanvas polygon[data-part="second"]');
    if (!node) return null;
    const points = node.getAttribute('points').trim().split(/\s+/).map(pair => pair.split(',').map(Number));
    const style = getComputedStyle(node);
    const bbox = node.getBoundingClientRect();
    return { count: points.length, stroke: style.strokeColor || style.stroke, width: style.strokeWidth,
      bbox: node.getBBox().width + 'x' + node.getBBox().height,
      center: { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 } };
  });
  check('秒针轮廓 polygon 存在且 ≥3 点', outline && outline.count >= 3, JSON.stringify(outline));
  check('秒针轮廓有可见描边', outline && outline.width && parseFloat(outline.width) > 0, outline && outline.width);
  // 选中后节点手柄出现（可拖调整）：真实鼠标点击
  await page.mouse.click(outline.center.x, outline.center.y);
  await sleep(250);
  const handles = await page.evaluate(() =>
    document.querySelectorAll('#shapeCanvas circle[data-part="second"][data-node]').length);
  check('选中秒针后显示节点手柄（可拖）', handles >= 3, handles + ' 个手柄');
  await removeProject(page, projectId);
  return projectId;
}

/* ── 2) 草图修改后自动同步 ── */
async function scenarioSketchSync(page) {
  const projectId = await createProject(page, 'e2e-fixes-sync-' + Date.now());
  const info = await page.evaluate(async pid => {
    const store = window.WuyingWorkspace.open(pid);
    const id = crypto.randomUUID(), now = Date.now();
    const blobId = 'old-ref-' + crypto.randomUUID();
    // 一层 ink 笔迹：快照里是旧坐标，当前图层改一笔 → refine 过期
    const layer = { id: 'ink1', kind: 'ink', name: '线稿', visible: true, opacity: 1,
      strokes: [{ points: [{ x: 100, y: 100 }, { x: 200, y: 120 }], size: 3 }] };
    const snapshotSig = JSON.stringify([[layer.id, 'ink', null, true, 1, 1]]); // 旧格式快照
    const changedLayer = { ...layer, strokes: [{ points: [{ x: 100, y: 100 }, { x: 260, y: 190 }], size: 3 }] };
    await store.change(doc => {
      doc.assets[id] = { id, name: '待同步草图', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now,
        layers: [changedLayer],
        draft: { revision: 'r0', parts: [], reference: { blobId, assetId: id, label: '旧底图' } },
        flow: { stage: 'refine', stages: { sketch: { snapshot: { blobId, layersSig: snapshotSig }, at: now, stale: false },
          refine: { snapshot: { revision: 'r0' }, at: now, stale: true } } } };
    }, []);
    return { id, oldRef: blobId };
  }, projectId);
  await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + info.id);
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#shapeStatus').textContent.length > 0, { timeout: 15000 });
  const after = await page.evaluate(async () => {
    const params = new URLSearchParams(location.search);
    const store = window.WuyingWorkspace.open(params.get('project'));
    const doc = await store.read();
    const asset = doc.assets[new URLSearchParams(location.search).get('asset')];
    return { status: document.querySelector('#shapeStatus').textContent,
      ref: asset.draft.reference.blobId, stale: asset.flow.stages.refine.stale,
      renderBase: !!(asset.design?.views?.front?.renderBase) };
  });
  check('同步状态提示出现', /底图已同步/.test(after.status), after.status);
  check('底图已换成最新画面', after.ref !== info.oldRef, after.ref.slice(0, 20));
  check('refine 过期标记已清除', after.stale === false, String(after.stale));
  check('旧底图的渲染基准已作废', after.renderBase === false, String(after.renderBase));
  await removeProject(page, projectId);
}

/* ── 3) 实时辅助：拖动采样不丢 + 最新几何出帧 ── */
async function scenarioLiveAssist(page) {
  const projectId = await createProject(page, 'e2e-fixes-live-' + Date.now());
  const assetId = await page.evaluate(async pid => {
    const store = window.WuyingWorkspace.open(pid);
    const id = crypto.randomUUID(), now = Date.now();
    const parts = [
      { id: 'face', shape: 'ellipse', name: '表盘', locked: true, x: 512, y: 384, width: 420, height: 420, angle: 0, depth: 60, z: 0 },
      { id: 'second', shape: 'polygon', name: '秒针', locked: false, x: 700, y: 300, width: 4, height: 80, angle: 0, depth: 4, z: 4,
        points: [{ x: -.5, y: -.5 }, { x: .5, y: -.5 }, { x: .5, y: .5 }, { x: -.5, y: .5 }] }
    ];
    await store.change(doc => {
      doc.assets[id] = { id, name: '挂钟实时', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now,
        layers: [], draft: { revision: 'r0', parts } };
    });
    return id;
  }, projectId);
  await page.addInitScript(prefs => {
    localStorage.setItem('wuying-region-model-v1', JSON.stringify(prefs));
  }, { endpoint: 'http://127.0.0.1:8188', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', provider: 'comfy' });
  await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
  // 选中秒针：真实鼠标点击（合成事件的 pointerId 无活动指针会报 setPointerCapture 错）
  const hit = await page.evaluate(() => {
    const node = document.querySelector('#shapeCanvas polygon[data-part="second"]');
    const bbox = node.getBoundingClientRect();
    return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
  });
  await page.mouse.click(hit.x, hit.y);
  await sleep(250);
  const selected = await page.evaluate(() => document.querySelector('#shapeCanvas polygon[data-part="second"]')?.dataset.selected);
  check('点击选中秒针', selected === 'true', String(selected));
  await page.evaluate(() => {
    window.__liveCalls = [];
    window.WuyingComfy.renderLive = async options => {
      window.__liveCalls.push({ input: options.input, tier: options.tier,
        long: options.latentWidth, slot: options.slot, prompt: options.prompt });
      await new Promise(resolve => setTimeout(resolve, 250));
      return { blob: new Blob([window.__tinyPng], { type: 'image/png' }) };
    };
    window.__tinyPng = new Uint8Array('BASE64_PLACEHOLDER');
  }).catch(async () => {
    // Uint8Array 构造兜底：用 atob 写入
    await page.evaluate(() => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      window.__tinyPng = bytes;
    });
  });
  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    window.__tinyPng = bytes;
  });
  await page.click('#liveToggle');
  await sleep(600); // 初始帧进入 mock（250ms）
  // 拖动秒针：连续 pointermove 期间 mock 正忙，采样必须被记录而不是丢弃
  const box = await page.evaluate(() => {
    const node = document.querySelector('#shapeCanvas polygon[data-part="second"]');
    const bbox = node.getBoundingClientRect();
    return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(box.x + i * 14, box.y - i * 6); await sleep(70); }
  const dragState = await page.evaluate(() => ({
    status: document.querySelector('#shapeStatus').textContent,
    live: document.querySelector('#liveState').textContent,
    calls: window.__liveCalls.length }));
  await page.mouse.up();
  await page.waitForFunction(() => (window.__liveCalls || []).length >= 2, null, { timeout: 15000 })
    .catch(() => {});
  // 等最后一次渲染完成（liveState 出现完成态），避免读到“正在渲染”的中间态
  await page.waitForFunction(() => /已按当前结构渲染|渲染失败/.test(document.querySelector('#liveState').textContent),
    null, { timeout: 15000 }).catch(() => {});
  await sleep(200);
  const live = await page.evaluate(() => ({ calls: window.__liveCalls, state: document.querySelector('#liveState').textContent,
    imageShown: !document.querySelector('#liveImage').hidden }));
  check('拖动命中部件（画布状态含拖动反馈）', /已更新|轮廓已更新|正在/.test(dragState.live + dragState.status),
    JSON.stringify(dragState));
  check('实时辅助渲染完成', /已按当前结构渲染|渲染失败/.test(live.state), live.state);
  check('渲染中的拖动采样被保留（≥2 次渲染请求）', live.calls.length >= 2, live.calls.length + ' 次');
  check('拖动预览用更小的长边（速度优先）', live.calls.some(call => call.tier === 'speed'), JSON.stringify(live.calls.map(c => c.tier)));
  check('预览图已显示', live.imageShown, String(live.imageShown));
  await removeProject(page, projectId);
}

/* ── 4) 生成视角：结构锁定 ── */
async function scenarioViewStructure(page) {
  const projectId = await createProject(page, 'e2e-fixes-view-' + Date.now());
  const assetId = await page.evaluate(async pid => {
    const store = window.WuyingWorkspace.open(pid);
    const id = crypto.randomUUID(), now = Date.now();
    const parts = [
      { id: 'face', shape: 'ellipse', name: '表盘', locked: false, x: 512, y: 384, width: 420, height: 420, angle: 0, depth: 60, z: 0 },
      { id: 'second', shape: 'polygon', name: '秒针', locked: false, x: 700, y: 300, width: 4, height: 80, angle: 15, depth: 4, z: 4,
        points: [{ x: -.5, y: -.5 }, { x: .5, y: -.5 }, { x: .5, y: .5 }, { x: -.5, y: .5 }] }
    ];
    await store.change(doc => {
      doc.assets[id] = { id, name: '挂钟视角', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now,
        layers: [], draft: { revision: 'r0', parts },
        flow: { stage: 'render', stages: {} } };
    });
    return id;
  }, projectId);
  await page.addInitScript(prefs => {
    localStorage.setItem('wuying-region-model-v1', JSON.stringify(prefs));
  }, { endpoint: 'http://127.0.0.1:8188', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', provider: 'comfy' });
  await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId + '&stage=render');
  await page.waitForSelector('#studioFlowRail', { timeout: 15000 });
  await sleep(400);
  await page.evaluate(bytes => {
    window.__viewCalls = [];
    window.WuyingComfy.renderLive = async options => {
      window.__viewCalls.push({ input: options.input, controlnet: options.controlnet,
        strength: options.strength, endPercent: options.endPercent, prompt: options.prompt,
        hasStructure: options.sourceImage instanceof Blob && options.sourceImage.size > 0 });
      return { blob: new Blob([bytes], { type: 'image/png' }) };
    };
  }, Array.from(TINY_PNG));
  // 角度球拖动 → 松手触发生成（auto 开关默认状态确认）
  const auto = await page.evaluate(() => {
    const box = document.querySelector('#studioAngleAuto');
    if (box && !box.checked) box.click();
    return box ? box.checked : null;
  });
  check('角度球自动生成开关可用', auto === true, String(auto));
  const sphere = await page.evaluate(() => {
    const svg = document.querySelector('#studioAngleSphere .angle-sphere');
    if (!svg) return null;
    const bbox = svg.getBoundingClientRect();
    return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
  });
  check('角度球已渲染', !!sphere, JSON.stringify(sphere));
  await page.mouse.move(sphere.x, sphere.y);
  await page.mouse.down();
  await page.mouse.move(sphere.x - 120, sphere.y, { steps: 8 }); // 拖向右侧视角
  await page.mouse.up();
  await page.waitForFunction(() => (window.__viewCalls || []).length > 0, { timeout: 30000 });
  await sleep(600);
  const view = await page.evaluate(() => window.__viewCalls[0]);
  check('视角生成走了结构锁定通道（input=sketch）', view && view.input === 'sketch', view && view.input);
  check('结构线稿作为条件图下发', view && view.hasStructure, String(view && view.hasStructure));
  check('ControlNet 全程控形（endPercent=1）', view && view.endPercent === 1, String(view && view.endPercent));
  check('控形强度 ≥ .82', view && view.strength >= .82, String(view && view.strength));
  check('几何锁定指令在提示词里', view && /exactly as drawn/.test(view.prompt || ''), view && (view.prompt || '').slice(-80));
  check('自动解析到 scribble ControlNet', view && !!view.controlnet, view && view.controlnet);
  await removeProject(page, projectId);
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin + '/files.html');
    await page.waitForFunction(() => window.WuyingProjects && window.WuyingWorkspace, { timeout: 15000 });
    await scenarioSecondHand(page);
    await scenarioSketchSync(page);
    await scenarioLiveAssist(page);
    await scenarioViewStructure(page);
  } catch (error) {
    check('E2E 流程完成', false, error.message);
  } finally {
    await browser.close();
  }
  check('页面无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  const failed = results.filter(item => !item.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  process.exit(failed.length ? 1 : 0);
}

main();
