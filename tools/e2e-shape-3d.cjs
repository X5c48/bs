// 部件推敲页「三视图 + 体块预览」浏览器端到端验收。
// 运行：node tools/e2e-shape-3d.cjs。依赖本机 8881 工作区、Playwright（npx 缓存）。
// 流程：新建临时项目 → 造带旧格式部件（无 depth/z）的草稿 → 打开部件推敲页 → 结束删除项目。
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
    const project = await window.WuyingProjects.create('e2e-shape3d-' + Date.now());
    const store = window.WuyingWorkspace.open(project.id);
    const id = crypto.randomUUID(), now = Date.now();
    // 旧格式部件：故意不带 depth/z，验证读取时迁移
    const parts = [
      { id: 'shade', shape: 'ellipse', name: '灯罩', locked: false, x: 512, y: 216, width: 340, height: 190, angle: 0 },
      { id: 'stem', shape: 'rectangle', name: '支架', locked: false, x: 512, y: 390, width: 48, height: 260, angle: 0 },
      { id: 'base', shape: 'rectangle', name: '底座', locked: true, x: 512, y: 590, width: 380, height: 76, angle: 0 }
    ];
    await store.change(doc => {
      doc.assets[id] = { id, name: '台灯部件', x: 80, y: 80, width: 1024, height: 768, createdAt: now, updatedAt: now,
        layers: [], draft: { revision: 'r0', parts } };
    });
    return { projectId: project.id, assetId: id };
  });
}

async function readParts(page, ids) {
  return page.evaluate(async ({ projectId, assetId }) => {
    const store = window.WuyingWorkspace.open(projectId);
    const doc = await store.read();
    return doc.assets[assetId].draft.parts;
  }, ids);
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let ids;
  try {
    ids = await setup(page);
    await page.goto(origin + '/shape-studio.html?project=' + ids.projectId + '&asset=' + ids.assetId);
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
    await sleep(400);

    console.log('== 迁移与初始状态');
    let parts = await readParts(page, ids);
    check('旧草稿读取时补全 depth/z', parts.every(p => Number.isFinite(p.depth) && Number.isFinite(p.z)),
      parts.map(p => p.name + ':' + p.depth).join(','));

    console.log('== P1 数据模型：draft → design 迁移 + 方案级锁定');
    const designState = await page.evaluate(async ({ projectId, assetId }) => {
      const doc = await window.WuyingWorkspace.open(projectId).read();
      const asset = doc.assets[assetId];
      const front = asset.design?.views?.front || {};
      return {
        hasDesign: !!asset.design,
        keepsDraft: !!asset.draft,
        revision: asset.design?.revision,
        outlines: Object.keys(front.outlines || {}),
        locks: asset.design?.locks,
        lockCount: (asset.design?.locks && Object.keys(asset.design.locks).length) || 0,
        boundsDepth: asset.design?.bounds?.depth,
        referenceKept: !!front.reference
      };
    }, ids);
    check('打开页面即生成 design 结构', designState.hasDesign && designState.keepsDraft);
    check('三个部件都迁出闭合轮廓', JSON.stringify(designState.outlines) === JSON.stringify(['shade', 'stem', 'base']),
      designState.outlines.join(','));
    check('锁定迁到方案级 design.locks（base）', designState.locks && designState.locks.base === true && designState.lockCount === 1,
      JSON.stringify(designState.locks));
    check('bounds 深度从部件深度区间推导', designState.boundsDepth > 0, String(designState.boundsDepth));

    // UI 切锁 → design.locks 与 draft 部件双写一致
    await page.locator('#shapeParts li', { hasText: '灯罩' }).locator('button').click();
    await page.locator('#toggleLock').click();
    await sleep(400);
    const lockAfter = await page.evaluate(async ({ projectId, assetId }) => {
      const doc = await window.WuyingWorkspace.open(projectId).read();
      const asset = doc.assets[assetId];
      return { locks: asset.design.locks,
        partLocked: asset.draft.parts.find(p => p.id === 'shade').locked };
    }, ids);
    check('界面锁部件 → design.locks 落库', lockAfter.locks.shade === true, JSON.stringify(lockAfter.locks));
    check('过渡期双写 draft 部件 locked', lockAfter.partLocked === true);
    await page.locator('#toggleLock').click();
    await sleep(400);
    const unlockAfter = await page.evaluate(async ({ projectId, assetId }) => {
      const doc = await window.WuyingWorkspace.open(projectId).read();
      const asset = doc.assets[assetId];
      return { locks: asset.design.locks,
        partLocked: asset.draft.parts.find(p => p.id === 'shade').locked };
    }, ids);
    check('解锁 → design.locks 移除且部件同步', !unlockAfter.locks.shade && unlockAfter.partLocked === false,
      JSON.stringify(unlockAfter.locks));
    // 刷新后不重复迁移（幂等）
    await page.reload();
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
    await sleep(400);
    const designStill = await page.evaluate(async ({ projectId, assetId }) => {
      const doc = await window.WuyingWorkspace.open(projectId).read();
      return { revision: doc.assets[assetId].design.revision, hasDraft: !!doc.assets[assetId].draft };
    }, ids);
    check('刷新后 design 保留、不重复迁移', designStill.hasDraft && designStill.revision === designState.revision,
      designStill.revision);

    check('体块预览窗可见', await page.locator('#shapePeek').isVisible());
    const peekFaces = await page.locator('#peekSvg polygon').count();
    check('体块预览有面片 (' + peekFaces + ')', peekFaces > 4);
    check('厚度字段出现在表单', await page.locator('#partDepth').count() === 1);

    console.log('== 三视图布局');
    await page.locator('#triToggle').check();
    await sleep(300);
    const tri = await page.evaluate(() => {
      const canvas = document.getElementById('shapeCanvas');
      return {
        labels: [...canvas.querySelectorAll('text.view-label')].map(t => t.textContent),
        seps: canvas.querySelectorAll('line.view-sep').length,
        rects: canvas.querySelectorAll('rect.shape-stroke').length,
        vb: canvas.getAttribute('viewBox'),
        ratio: document.getElementById('shapeSheet').style.getPropertyValue('--sheet-ratio')
      };
    });
    const spanNow = await page.evaluate(async ids => {
      const store = window.WuyingWorkspace.open(ids.projectId);
      const doc = await store.read();
      const parts = doc.assets[ids.assetId].draft.parts;
      const span = window.WuyingShapeModel.depthSpan(parts);
      return Math.round(span.max - span.min);
    }, ids);
    check('三个视图标签（含实时深度区间）',
      tri.labels[0] === '正视 1024×768' && tri.labels[1] === '侧视 厚 ' + spanNow
      && tri.labels[2] === '俯视 1024×' + spanNow, tri.labels.join(' | '));
    check('两条对齐分隔线', tri.seps === 2, String(tri.seps));
    const alignLines = await page.locator('#shapeCanvas line.view-align').count();
    check('视图对齐参考线（正视高度↔侧视、正视宽度↔俯视）', alignLines === 4, String(alignLines));
    check('侧视/俯视矩形 (4)', tri.rects === 6, String(tri.rects)); // 每部件侧+俯 2 个 × 3 部件
    check('画布比例随三视图扩展', tri.ratio !== '1024/768', tri.ratio);

    console.log('== 选中与厚度拖拽');
    await page.locator('polygon[data-part="stem"]').first().click();
    await sleep(300);
    let handles = await page.locator('[data-handle]').count();
    check('选中未锁定部件出现 2 个厚度手柄', handles === 2, String(handles));
    const before = parts = await readParts(page, ids);
    const stemBefore = before.find(p => p.id === 'stem');
    const handle = page.locator('[data-handle="depth-side"]');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await sleep(600);
    parts = await readParts(page, ids);
    const stemAfter = parts.find(p => p.id === 'stem');
    check('拖侧视手柄增大厚度', stemAfter.depth > stemBefore.depth,
      stemBefore.depth + ' → ' + stemAfter.depth);
    // 标签随 depthSpan 联动更新
    const spanAfter = await page.evaluate(async ids => {
      const store = window.WuyingWorkspace.open(ids.projectId);
      const doc = await store.read();
      const span = window.WuyingShapeModel.depthSpan(doc.assets[ids.assetId].draft.parts);
      return Math.round(span.max - span.min);
    }, ids);
    const spanText = await page.evaluate(() =>
      [...document.querySelectorAll('#shapeCanvas text.view-label')].map(t => t.textContent).join(' | '));
    check('侧视标签厚度随拖拽更新', spanText.includes('侧视 厚 ' + spanAfter), spanText);
    check('体块预览随厚度变化', await page.evaluate(() => {
      const faces = document.getElementById('peekSvg').querySelectorAll('polygon').length;
      return faces > 4;
    }));

    console.log('== 深度位置拖拽（俯视格）');
    // 俯视格 DOM 顺序侧视在前；后渲染部件会覆盖先渲染部件，点 stem 俯视矩形上部未遮挡条带
    const topRect = page.locator('rect[data-part="stem"]').nth(1);
    const topBox = await topRect.boundingBox();
    const zBefore = (await readParts(page, ids)).find(p => p.id === 'stem').z;
    await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(topBox.x + topBox.width / 2, topBox.y + topBox.height * 0.15 + 60, { steps: 8 });
    await page.mouse.up();
    await sleep(600);
    const zAfter = (await readParts(page, ids)).find(p => p.id === 'stem').z;
    check('俯视格拖拽调整深度位置', zAfter > zBefore, zBefore + ' → ' + zAfter);

    console.log('== 锁定部件约束');
    await page.locator('polygon[data-part="base"]').first().click();
    await sleep(300);
    handles = await page.locator('[data-handle]').count();
    check('锁定部件无厚度手柄', handles === 0, String(handles));

    console.log('== 表单厚度 + 厚度变体');
    await page.locator('polygon[data-part="stem"]').first().click();
    await sleep(300);
    const depthField = await page.locator('#partDepth').inputValue();
    check('表单回填当前厚度', Number(depthField) === stemAfter.depth, depthField);
    await page.locator('#partDepth').fill('120');
    await page.locator('#partForm button[type="submit"]').click();
    await sleep(600);
    const formDepth = (await readParts(page, ids)).find(p => p.id === 'stem').depth;
    check('表单提交厚度生效', formDepth === 120, String(formDepth));
    check('变体维度含厚度', await page.locator('#variantField option[value="depth"]').count() === 1);
    await page.locator('#variantField').selectOption('depth');
    await page.locator('#variantAmount').fill('20');
    await page.locator('#generateVariants').click();
    await sleep(800);
    const storeAssetCount = await page.evaluate(async ids => {
      const store = window.WuyingWorkspace.open(ids.projectId);
      return Object.keys((await store.read()).assets).length;
    }, ids);
    check('厚度变体生成 3 个候选', storeAssetCount === 4, String(storeAssetCount));

    console.log('== 体块预览旋转');
    const peekBefore = await page.locator('#peekSvg').innerHTML();
    const peekBox = await page.locator('#peekSvg').boundingBox();
    // 小窗可能超出视口下缘，取其可视区内偏上的点
    const peekY = Math.min(peekBox.y + peekBox.height / 2, 880);
    await page.mouse.move(peekBox.x + peekBox.width / 2, peekY);
    await page.mouse.down();
    await page.mouse.move(peekBox.x + peekBox.width / 2 + 90, peekY, { steps: 10 });
    await page.mouse.up();
    await sleep(200);
    const peekAfter = await page.locator('#peekSvg').innerHTML();
    check('拖拽预览窗旋转更新体块', peekBefore !== peekAfter);

    console.log('== 回正视与刷新持久化');
    await page.locator('#triToggle').uncheck();
    await sleep(200);
    check('回正视后侧/俯矩形消失', await page.locator('#shapeCanvas rect.shape-stroke').count() === 0);
    await page.reload();
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
    await sleep(400);
    const persisted = (await readParts(page, ids)).find(p => p.id === 'stem');
    check('刷新后厚度持久化', persisted.depth === 120, String(persisted.depth));

    check('无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (error) {
    check('脚本执行', false, String(error));
  } finally {
    if (ids) {
      await page.goto(origin + '/files.html');
      await page.waitForFunction(() => window.WuyingProjects?.remove);
      await page.evaluate(id => window.WuyingProjects.remove(id), ids.projectId).catch(() => {});
    }
    await browser.close();
  }
  const failed = results.filter(r => !r.ok).length;
  console.log('\n结果: ' + (results.length - failed) + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main();
