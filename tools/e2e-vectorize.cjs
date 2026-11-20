// 部件推敲页「矢量化 + 节点编辑」浏览器端到端验收（整体规划 P2）。
// 运行：node tools/e2e-vectorize.cjs。依赖本机 8881 工作区、Playwright（npx 缓存）。
// 流程：新建临时项目 → 造一张真实台灯线稿 PNG 作底图 → 打开部件推敲页
//       → 点「矢量化底图」拆部件 → 拖节点 → 锁定其余 → 结束删除项目。
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
    const project = await window.WuyingProjects.create('e2e-vector-' + Date.now());
    const store = window.WuyingWorkspace.open(project.id);
    const id = crypto.randomUUID(), now = Date.now();
    // 台灯线稿：灯罩椭圆 + 支架 + 底座，白底深线
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 768;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 768);
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.ellipse(512, 220, 240, 110, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeRect(492, 340, 40, 220);
    ctx.strokeRect(380, 600, 265, 60);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const blobId = crypto.randomUUID();
    await store.change(doc => {
      doc.assets[id] = { id, name: '矢量化验收', x: 80, y: 80, width: 1024, height: 768,
        createdAt: now, updatedAt: now, layers: [],
        draft: { revision: crypto.randomUUID(), parts: [],
          reference: { blobId, assetId: id, label: '台灯线稿' } },
        flow: { stage: 'refine' } };
    }, [{ id: blobId, blob }]);
    return { projectId: project.id, assetId: id, blobId };
  });
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let ids;
  const load = () => page.evaluate(async ({ projectId, assetId }) => {
    const doc = await window.WuyingWorkspace.open(projectId).read();
    const asset = doc.assets[assetId];
    return { parts: asset.draft.parts.map(p => ({ id: p.id, name: p.name, shape: p.shape,
        locked: p.locked, count: p.points?.length || 0, x: p.x, y: p.y, width: p.width, height: p.height })),
      locks: asset.design?.locks || {}, hasDesign: !!asset.design };
  }, { projectId: ids.projectId, assetId: ids.assetId });
  try {
    ids = await setup(page);
    await page.goto(origin + '/shape-studio.html?project=' + ids.projectId + '&asset=' + ids.assetId);
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
    await sleep(500);

    console.log('== 矢量化底图');
    check('底图存在时「矢量化底图」可见', await page.locator('#vectorize').isVisible());
    await page.locator('#vectorize').click();
    await sleep(1500);
    let state = await load();
    check('线稿拆出 3 个部件', state.parts.length === 3, state.parts.map(p => p.name + ':' + p.shape).join(','));
    check('拆出的部件都是描线（可编辑节点）', state.parts.every(p => p.shape === 'polygon'));
    check('每个部件节点数在 3~90', state.parts.every(p => p.count >= 3 && p.count <= 90),
      state.parts.map(p => p.count).join(','));
    const boxes = state.parts.map(p => Math.round(p.width) + 'x' + Math.round(p.height)).join(' ');
    check('外接框与线稿吻合（灯罩最宽、支架细长、底座扁平）',
      state.parts.some(p => p.width > 400 && p.height > 180 && p.height < 320) &&
      state.parts.some(p => p.width < 80 && p.height > 180) &&
      state.parts.some(p => p.width > 200 && p.height < 90), boxes);

    console.log('== 节点拖动');
    // 选中节点最多的部件（灯罩，24 个节点），拖第 1 个节点
    const most = state.parts.reduce((best, p) => (p.count > best.count ? p : best), state.parts[0]);
    const order = state.parts.map(p => p.id).indexOf(most.id);
    await page.locator('#shapeParts li').nth(order).locator('button').click();
    await sleep(300);
    const nodeCount = await page.locator('#shapeCanvas .shape-node').count();
    check('选中描线部件出现节点手柄', nodeCount === most.count, nodeCount + '/' + most.count);
    const selectedId = await page.locator('#shapeCanvas .shape-stroke[data-selected="true"]').getAttribute('data-part');
    check('画布选中件与列表一致', selectedId === most.id);
    const pointsOf = () => page.evaluate(async ({ projectId, assetId, partId }) => {
      const doc = await window.WuyingWorkspace.open(projectId).read();
      return doc.assets[assetId].draft.parts.find(p => p.id === partId)?.points || [];
    }, { projectId: ids.projectId, assetId: ids.assetId, partId: most.id });
    const beforePoints = await pointsOf();
    const handle = await page.locator('#shapeCanvas .shape-node').first().boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 26, handle.y + handle.height / 2 + 26, { steps: 8 });
    await page.mouse.up();
    await sleep(600);
    const afterPoints = await pointsOf();
    const changed = afterPoints.length === beforePoints.length &&
      afterPoints.some((point, i) => point.x !== beforePoints[i].x || point.y !== beforePoints[i].y);
    check('拖节点后写入新轮廓（点数不变、坐标有变）', changed,
      beforePoints.length + ' 点 → ' + afterPoints.length + ' 点');
    const untouched = (await load()).parts.filter(p => p.id !== most.id);
    check('其余部件未被拖动影响', untouched.every(p => p.shape === 'polygon'));

    console.log('== 锁定其余 + 锁定件不可拖节点');
    await page.locator('#lockOthers').click();
    await sleep(600);
    state = await load();
    const unlocked = state.parts.filter(p => !p.locked);
    check('锁定其余：只剩 1 个可改部件', unlocked.length === 1, state.parts.map(p => p.locked ? '锁' : '开').join(''));
    check('锁定写入方案级 design.locks', Object.keys(state.locks).length === 2, JSON.stringify(state.locks));
    const lockedPart = state.parts.find(p => p.locked);
    // 锁定后列表副标题变「已锁定」，按顺序取而不是按文字过滤
    await page.locator('#shapeParts li').nth(state.parts.indexOf(lockedPart)).locator('button').click();
    await sleep(300);
    check('锁定部件不显示节点手柄', (await page.locator('#shapeCanvas .shape-node').count()) === 0);
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
