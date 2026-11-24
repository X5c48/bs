// 阶段轨道 P0 收口端到端验收：前进条件 + 过期标记（橙点）+ 冻结快照。
// 运行：node tools/e2e-stage-rail.cjs。依赖本机 8881 工作区、Playwright（npx 缓存）。
// 流程：新建临时项目（带草图图层的方案 + 空方案）→ 走完 sketch→refine→ortho 链路
//       → 回草图改画面验证橙点 → 空方案验证渲染前进条件 → 结束删除项目。
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

async function setup(page) {
  await page.goto(origin + '/files.html');
  await page.waitForFunction(() => window.WuyingProjects && window.WuyingWorkspace);
  return page.evaluate(async () => {
    const project = await window.WuyingProjects.create('e2e-rail-' + Date.now());
    const store = window.WuyingWorkspace.open(project.id);
    const now = Date.now();
    const mk = id => ({ id, name: '方案' + id.slice(0, 4), x: 80, y: 80, width: 1024, height: 768,
      createdAt: now, updatedAt: now, layers: [], flow: { stage: 'sketch' } });
    const id = crypto.randomUUID(), emptyId = crypto.randomUUID();
    // 给第一个方案造一张真实 PNG 图层（进入微调要合成快照）
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#7a86b8'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#f0eef7'; ctx.beginPath(); ctx.arc(32, 32, 18, 0, 7); ctx.fill();
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const blobId = crypto.randomUUID();
    await store.change(doc => {
      doc.assets[id] = mk(id);
      doc.assets[id].layers = [{ id: crypto.randomUUID(), name: '草图', kind: 'image', blobId, visible: true, opacity: 1 }];
      doc.assets[emptyId] = mk(emptyId);
    }, [{ id: blobId, blob }]);
    // 再造一张不同的真实 PNG，供「回草图导入图层」用
    const cv2 = document.createElement('canvas');
    cv2.width = 32; cv2.height = 32;
    const ctx2 = cv2.getContext('2d');
    ctx2.fillStyle = '#c9a24b'; ctx2.fillRect(0, 0, 32, 32);
    return { projectId: project.id, assetId: id, emptyId,
      extraPng: cv2.toDataURL('image/png') };
  });
}

async function readFlow(page, { projectId, assetId }) {
  return page.evaluate(async ({ projectId, assetId }) => {
    const doc = await window.WuyingWorkspace.open(projectId).read();
    const asset = doc.assets[assetId];
    return { flow: asset.flow, revision: asset.draft?.revision || null,
      layers: (asset.layers || []).length };
  }, { projectId, assetId });
}

const staleSteps = page => page.evaluate(() =>
  [...document.querySelectorAll('#studioFlowRail .flow-step')]
    .filter(s => s.classList.contains('is-stale')).map(s => s.dataset.stage));

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let ids;
  try {
    ids = await setup(page);

    console.log('== sketch → refine：冻结快照');
    await page.goto(origin + '/image-studio.html?project=' + ids.projectId + '&asset=' + ids.assetId);
    await page.waitForSelector('#studioFlowRail:not([hidden])', { timeout: 20000 });
    await sleep(500);
    check('初始无过期橙点', (await staleSteps(page)).length === 0);
    await page.locator('#studioFlowRail [data-stage="refine"]').click();
    await page.waitForURL(/shape-studio\.html/, { timeout: 15000 });
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
    await sleep(400);
    let state = await readFlow(page, ids);
    check('进入微调后 stage=refine', state.flow.stage === 'refine', state.flow.stage);
    check('sketch 快照已冻结（blobId + 图层摘要）',
      !!state.flow.stages?.sketch?.snapshot?.blobId && !!state.flow.stages?.sketch?.snapshot?.layersSig,
      JSON.stringify(Object.keys(state.flow.stages?.sketch?.snapshot || {})));
    check('sketch 快照的图层摘要与当前画布一致',
      state.flow.stages?.sketch?.snapshot?.layersSig === await page.evaluate(async ({ projectId, assetId }) => {
        const doc = await window.WuyingWorkspace.open(projectId).read();
        return window.WuyingFlowStages.layersSig(doc.assets[assetId].layers);
      }, { projectId: ids.projectId, assetId: ids.assetId }));

    console.log('== refine → 产品渲染：前进条件 + 结构修订号快照');
    await page.locator('#railRender').click();
    await sleep(500);
    check('空草稿不能去产品渲染（留在微调页）', page.url().includes('shape-studio.html'));
    const gateMsg = await page.locator('#shapeStatus').textContent();
    check('前进条件报原因', gateMsg.includes('还没有部件'), gateMsg.trim());
    await page.locator('#addRectangle').click();
    await sleep(400);
    await page.locator('#railRender').click();
    await page.waitForURL(/stage=render/, { timeout: 15000 });
    await page.waitForSelector('#studioFlowRail:not([hidden])', { timeout: 20000 });
    await sleep(500);
    state = await readFlow(page, ids);
    check('进入产品渲染后 stage=render', state.flow.stage === 'render', state.flow.stage);
    check('refine 快照冻结了结构修订号', state.flow.stages?.refine?.snapshot?.revision === state.revision,
      state.flow.stages?.refine?.snapshot?.revision + ' vs ' + state.revision);
    check('refine 条目无过期标记', !state.flow.stages?.refine?.stale);
    await page.locator('[data-view-mode="ortho"]').click();
    await sleep(500);
    state = await readFlow(page, ids);
    check('三视图作为产品展示模式，stage=ortho', state.flow.stage === 'ortho', state.flow.stage);

    console.log('== ortho → render：渲染条目快照');
    await page.locator('#studioFlowRail [data-stage="render"]').click();
    await sleep(600);
    state = await readFlow(page, ids);
    check('进入渲染后 stage=render', state.flow.stage === 'render', state.flow.stage);
    check('ortho 快照冻结（画布图层摘要）', !!state.flow.stages?.ortho?.snapshot?.layersSig);

    console.log('== 回草图改画面：已到达的下游阶段出现橙点');
    await page.locator('#studioFlowRail [data-stage="sketch"]').click();
    await sleep(600);
    check('回到草图 stage=sketch', (await readFlow(page, ids)).flow.stage === 'sketch');
    // 导入一张新图片图层（等价于在草图上继续画）
    await page.setInputFiles('#studioLayerFile', { name: 'extra.png', mimeType: 'image/png',
      buffer: Buffer.from(ids.extraPng.split(',')[1], 'base64') });
    await sleep(1200);
    const staleList = await staleSteps(page);
    check('草图改动后 refine 与产品渲染（含三视图）出现橙点',
      JSON.stringify(staleList) === JSON.stringify(['refine', 'render']), staleList.join(','));
    state = await readFlow(page, ids);
    check('过期标记落库（refine/ortho.stale）',
      state.flow.stages?.refine?.stale === true && state.flow.stages?.ortho?.stale === true);
    check('sketch 快照未被覆盖（仍是冻结的那份）', !!state.flow.stages?.sketch?.snapshot?.blobId);

    console.log('== 带过期标记进入三视图：提示上游已改');
    await page.locator('[data-view-mode="ortho"]').click();
    await sleep(700);
    const staleMsg = await page.locator('#studioRunStatus').textContent();
    check('进入过期阶段出现提示', staleMsg.includes('上游已修改'), staleMsg.trim());
    state = await readFlow(page, ids);
    check('进入三视图时刷新了 refine 快照并清除其过期标记',
      state.flow.stages?.refine?.stale === false && state.flow.stages?.refine?.snapshot?.revision === state.revision);

    console.log('== 前进条件：空方案不能直接去渲染');
    await page.goto(origin + '/image-studio.html?project=' + ids.projectId + '&asset=' + ids.emptyId);
    await page.waitForSelector('#studioFlowRail:not([hidden])', { timeout: 20000 });
    await sleep(400);
    await page.locator('#studioFlowRail [data-stage="render"]').click();
    await sleep(500);
    const renderGate = await page.locator('#studioRunStatus').textContent();
    check('空画布去渲染被拦截并报原因', renderGate.includes('还没有可渲染的画面'), renderGate.trim());
    check('阶段未切换', (await readFlow(page, { ...ids, assetId: ids.emptyId })).flow.stage === 'sketch');

    console.log('== 刷新保持阶段 + 回归');
    await page.goto(origin + '/image-studio.html?project=' + ids.projectId + '&asset=' + ids.assetId + '&stage=ortho');
    await page.waitForSelector('#studioFlowRail:not([hidden])', { timeout: 20000 });
    await sleep(500);
    check('刷新后阶段保持 ortho', await page.locator('[data-view-mode="ortho"][aria-pressed="true"]').count() === 1
      && await page.locator('#studioFlowRail [data-stage="render"].is-active').count() === 1);
    check('无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  } finally {
    if (ids) {
      await page.evaluate(async projectId => {
        await window.WuyingProjects.remove(projectId).catch(() => {});
      }, ids.projectId).catch(() => {});
    }
    await browser.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log('\n== 结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
}
main().catch(error => { console.error('E2E 异常：', error); process.exit(1); });
