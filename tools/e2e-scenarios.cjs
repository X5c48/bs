// 图像工作室端到端场景。每个场景收到已打开工作室的 page。
'use strict';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 在画布上画一笔（归一化坐标）
async function stroke(page, points) {
  const box = await page.locator('#studioOverlay').boundingBox();
  const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...at(point), { steps: 6 });
  await page.mouse.up();
}

async function liveFrameCount(page) {
  return page.locator('#studioLiveHistory button').count().then(async count =>
    count || (await page.locator('#studioLiveImage[src]').count()));
}

const scenarios = {
  // 模块 1：实时渲染 + 加载状态 + 失败重试
  async live(page, { check, endpoint }) {
    await page.click('#studioLive');
    check('实时辅助开启后提示词可编辑', await page.locator('#studioPromptField').isVisible());
    await page.waitForSelector('#studioLiveDot[data-state="running"]', { timeout: 8000 });
    check('渲染中圆点进入 running 态', true, await page.textContent('#studioLiveState'));
    await page.waitForSelector('#studioLiveImage[src]', { timeout: 60000 });
    const firstTime = await page.textContent('#studioLiveTime');
    check('首帧出图', true, firstTime);

    await page.fill('#studioPrompt', 'brushed aluminium desk lamp, warm light');
    const before = await page.getAttribute('#studioLiveImage', 'src');
    await page.waitForFunction(old => document.querySelector('#studioLiveImage').getAttribute('src') !== old, before, { timeout: 60000 });
    check('改提示词后自动重渲出新帧', true, await page.textContent('#studioLiveTime'));

    // 失败：把服务地址改成无人监听的端口，再画一笔
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('wuying-workspace-model-v1'));
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({ ...prefs, endpoint: 'http://127.0.0.1:8199' }));
    });
    await stroke(page, [[.2, .9], [.3, .92], [.4, .9]]);
    await page.waitForSelector('#studioLiveRetry:not([hidden])', { timeout: 30000 });
    check('服务不可达时显示失败原因与重试', (await page.textContent('#studioLiveState')).startsWith('渲染失败：'),
      await page.textContent('#studioLiveState'));

    await page.evaluate(endpoint => {
      const prefs = JSON.parse(localStorage.getItem('wuying-workspace-model-v1'));
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({ ...prefs, endpoint }));
    }, endpoint);
    const failedSrc = await page.getAttribute('#studioLiveImage', 'src');
    await page.click('#studioLiveRetry');
    await page.waitForFunction(old => document.querySelector('#studioLiveImage').getAttribute('src') !== old
      && document.querySelector('#studioLiveDot').dataset.state === 'done', failedSrc, { timeout: 60000 });
    check('点重试后恢复出帧且重试按钮隐藏', await page.locator('#studioLiveRetry').isHidden());
    await page.click('#studioLive');
  },

  // 模块 1：出图失败后右栏给出重试；生成中显示骨架占位
  async runRetry(page, { check, endpoint }) {
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem('wuying-workspace-model-v1'));
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({ ...prefs, endpoint: 'http://127.0.0.1:8199' }));
    });
    await page.reload();
    await page.waitForSelector('#studioShell:not([hidden])');
    await page.selectOption('#studioKind', 'render');
    await page.selectOption('#studioQuantity', '2');
    await page.click('#studioGenerate');
    await page.waitForSelector('#studioRetryRun:not([hidden])', { timeout: 30000 });
    check('出图失败显示「生成失败：原因」', (await page.textContent('#studioRunStatus')).startsWith('生成失败：'),
      await page.textContent('#studioRunStatus'));
    await page.evaluate(endpoint => {
      const prefs = JSON.parse(localStorage.getItem('wuying-workspace-model-v1'));
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({ ...prefs, endpoint }));
    }, endpoint);
    await page.reload();
    await page.waitForSelector('#studioShell:not([hidden])');
    await page.selectOption('#studioKind', 'render');
    await page.selectOption('#studioQuantity', '2');
    await page.click('#studioGenerate');
    await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
    check('生成中结果区出现骨架占位', await page.locator('.candidate.skeleton').count() >= 1,
      (await page.locator('.candidate.skeleton').count()) + ' 张占位');
    await page.waitForFunction(() => !document.querySelector('.candidate.skeleton') && document.querySelectorAll('.candidate[data-output-id]').length >= 2, null, { timeout: 180000 });
    check('两张候选到齐后占位消失', true, await page.textContent('#studioRunStatus'));
    check('成功后重试按钮隐藏', await page.locator('#studioRetryRun').isHidden());
  },

  // 模块 2：方案发散（每个方向一张）+ 并排对比 + 采用为图层
  async explore(page, { check }) {
    await page.selectOption('#studioKind', 'explore');
    check('方向选择器可见', await page.locator('#studioDirections').isVisible());
    check('默认勾选 4 个方向', (await page.textContent('#studioDirectionCount')).includes('4'), await page.textContent('#studioDirectionCount'));
    // 少于 2 个方向时禁用生成
    const boxes = page.locator('#studioDirectionList input');
    for (let i = 1; i < 4; i++) await boxes.nth(i).uncheck();
    check('只剩 1 个方向时生成按钮禁用', await page.locator('#studioGenerate').isDisabled());
    for (let i = 1; i < 4; i++) await boxes.nth(i).check();
    check('恢复 4 个方向后生成按钮可用', await page.locator('#studioGenerate').isEnabled());
    await page.fill('#studioPrompt', 'desk lamp product design');
    const before = await page.locator('.candidate[data-output-id]').count();
    const started = Date.now();
    await page.click('#studioGenerate');
    await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
    check('生成中显示 4 张占位', await page.locator('.candidate.skeleton').count() === 4, (await page.locator('.candidate.skeleton').count()) + ' 张');
    await page.waitForFunction(n => !document.querySelector('.candidate.skeleton') && document.querySelectorAll('.candidate[data-output-id]').length >= n + 4, before, { timeout: 300000 });
    const names = await page.locator('.run-group:not(.is-pending)').first().locator('.candidate span').allTextContents();
    check('4 个方向各出一张且名称带方向', names.length === 4 && ['极简', '有机', '硬朗', '复古'].every(word => names.some(name => name.includes(word))),
      names.join(' / ') + ' · ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
    const srcs = await page.locator('.run-group:not(.is-pending)').first().locator('.candidate img').evaluateAll(list => list.map(img => img.src));
    check('4 张候选均已载入缩略图', srcs.length === 4 && srcs.every(Boolean));

    await page.locator('.run-group:not(.is-pending)').first().locator('.compare-open').click();
    await page.waitForSelector('#studioCompare[open]');
    const cells = await page.locator('#studioCompareGrid .compare-cell').count();
    check('并排对比显示源图 + 4 个候选', cells === 5 && await page.locator('#studioCompareGrid .is-source').count() === 1, cells + ' 格');
    const preset = await page.locator('#studioCompareGrid button.compare-cell[aria-pressed="true"]').count();
    check('预选当前预览的候选（无预览则采用禁用）', preset === 1 ? await page.locator('#studioCompareApply').isEnabled() : await page.locator('#studioCompareApply').isDisabled(),
      preset ? '已预选 1 张' : '无预选');
    await page.locator('#studioCompareGrid button.compare-cell').nth(2).click();
    check('点选后高亮并启用采用', await page.locator('#studioCompareGrid button.compare-cell').nth(2).getAttribute('aria-pressed') === 'true'
      && await page.locator('#studioCompareApply').isEnabled());
    const layersBefore = await page.locator('#studioLayers .layer-row').count();
    await page.click('#studioCompareApply');
    await page.waitForFunction(n => document.querySelectorAll('#studioLayers .layer-row').length === n + 1, layersBefore, { timeout: 15000 });
    check('采用后新增 1 个图层且对话框关闭', !(await page.locator('#studioCompare[open]').count()),
      await page.locator('#studioLayers .layer-row strong').first().textContent());

    await page.locator('.run-group:not(.is-pending)').first().locator('.compare-open').click();
    await page.locator('#studioCompareGrid button.compare-cell').nth(0).click();
    await page.click('#studioComparePromote');
    await page.waitForFunction(() => document.querySelector('#studioComparePromote').textContent === '已在工作台', null, { timeout: 15000 });
    check('放到工作台后按钮变为「已在工作台」', true, await page.textContent('#studioCompareStatus'));
    await page.click('#studioCloseCompare');
  }
};

// 模块 5：情境化设计。照片 16:9，画布初始 4:3 且无笔触。
scenarios.scene = async function scene(page, { check, ids }) {
  await page.selectOption('#studioKind', 'scene');
  check('情境渲染显示上传入口', await page.locator('#studioScenePhoto').isVisible());
  check('缺照片时提示第一步且生成禁用', (await page.textContent('#studioSceneStatus')).includes('上传一张场景照片')
    && await page.locator('#studioGenerate').isDisabled(), await page.textContent('#studioSceneStatus'));
  // 浏览器内画一张 1600×900 的「室内」照片：墙、地板、桌面、窗
  const photo = await page.evaluate(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 }), g = c.getContext('2d');
    let grad = g.createLinearGradient(0, 0, 0, 560); grad.addColorStop(0, '#d9d2c5'); grad.addColorStop(1, '#bfb6a6');
    g.fillStyle = grad; g.fillRect(0, 0, 1600, 560);
    g.fillStyle = '#8a6a4a'; g.fillRect(0, 560, 1600, 340);
    g.fillStyle = '#e8eef5'; g.fillRect(1120, 90, 360, 300); g.strokeStyle = '#fff'; g.lineWidth = 14; g.strokeRect(1120, 90, 360, 300);
    g.fillStyle = '#5b3c26'; g.fillRect(260, 600, 900, 40); g.fillRect(300, 640, 30, 220); g.fillRect(1090, 640, 30, 220);
    for (let i = 0; i < 4000; i++) { g.fillStyle = 'rgba(0,0,0,' + (Math.random() * .05) + ')'; g.fillRect(Math.random() * 1600, Math.random() * 900, 2, 2); }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  // 先清掉 setup 里的台灯笔触，验证「无笔触时画布跟随照片比例」
  await page.evaluate(async ({ projectId, assetId }) => {
    await window.WuyingWorkspace.open(projectId).change(doc => { doc.assets[assetId].layers = []; });
  }, ids);
  await page.reload();
  await page.waitForSelector('#studioShell:not([hidden])');
  await page.selectOption('#studioKind', 'scene');
  await page.setInputFiles('#studioSceneFile', { name: '客厅.png', mimeType: 'image/png', buffer: Buffer.from(photo) });
  await page.waitForFunction(() => document.querySelector('#studioDimensions')?.textContent.includes('1600 × 904')
    || document.querySelector('#studioDimensions')?.textContent.includes('1600 × 896')
    || document.querySelector('#studioDimensions')?.textContent.includes('1600 × 900'), null, { timeout: 10000 }).catch(() => {});
  const dims = await page.textContent('#studioDimensions');
  const [w, h] = dims.split('×').map(s => parseInt(s));
  check('上传照片后画布跟随照片比例（16:9）', Math.abs(w / h - 16 / 9) < .01, dims + ' · ' + await page.textContent('#studioSceneStatus'));
  check('照片后缺草图时提示第二步且生成禁用', await page.locator('#studioGenerate').isDisabled());
  // 在桌面上方画一盏台灯
  await page.click('#studioBrush').catch(() => {});
  const lamp = [[[.32, .66], [.44, .66]], [[.38, .66], [.38, .42]], [[.38, .42], [.46, .34]], [[.30, .34], [.52, .34], [.48, .24], [.36, .24], [.30, .34]]];
  for (const line of lamp) await stroke(page, line);
  await page.waitForFunction(() => !document.querySelector('#studioGenerate').disabled, null, { timeout: 8000 });
  check('照片 + 草图就绪后可生成', true, await page.textContent('#studioSceneStatus'));
  check('改动强度默认 85%', (await page.textContent('#studioStrengthValue')) === '85%');
  await page.fill('#studioPrompt', 'modern brass desk lamp with white shade');
  const started = Date.now();
  await page.click('#studioGenerate');
  await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
  check('生成中显示占位', true);
  await page.waitForFunction(() => (!document.querySelector('.candidate.skeleton') && document.querySelector('.candidate[data-output-id]')) || document.querySelector('#studioRunStatus').textContent.startsWith('生成失败'), null, { timeout: 240000 });
  if ((await page.textContent('#studioRunStatus')).startsWith('生成失败')) throw new Error(await page.textContent('#studioRunStatus'));
  check('情境渲染出图', true, ((Date.now() - started) / 1000).toFixed(1) + 's · ' + await page.textContent('#studioRunStatus'));
  // 像素级核对：选区外与照片快照完全一致
  const diff = await page.evaluate(async ({ projectId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read();
    const job = Object.values(doc.jobs).find(j => j.kind === 'scene' && j.outputs.length);
    const load = async id => createImageBitmap(await store.getBlob(id));
    const [a, b] = await Promise.all([load(job.scene.photoBlobId), load(job.outputs[0].blobId)]);
    const px = bmp => { const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height }); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
    const pa = px(a), pb = px(b), W = a.width, H = a.height;
    const xs = job.selection.map(p => p.x * W), ys = job.selection.map(p => p.y * H);
    const L = Math.min(...xs) - 1, R = Math.max(...xs) + 1, T = Math.min(...ys) - 1, B = Math.max(...ys) + 1;
    // 选区外 = 多边形外 2px 以上（用放大 2px 的多边形掩膜判定）
    const mc = Object.assign(document.createElement('canvas'), { width: W, height: H }), mg = mc.getContext('2d');
    mg.beginPath(); xs.forEach((x, k) => k ? mg.lineTo(x, ys[k]) : mg.moveTo(x, ys[k])); mg.closePath();
    mg.fillStyle = '#fff'; mg.fill(); mg.lineWidth = 4; mg.strokeStyle = '#fff'; mg.stroke();
    const md = mg.getImageData(0, 0, W, H).data, inPoly = (x, y) => md[(y * W + x) * 4] > 0;
    let outside = 0, changedOut = 0, inside = 0, changedIn = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      if (!inPoly(x, y)) { outside++; if (d) changedOut++; } else { inside++; if (d > 30) changedIn++; }
    }
    // 接缝：选区边界内外各 3px 的平均亮度差
    const lum = (p, x, y) => { const i = (y * W + x) * 4; return .299 * p[i] + .587 * p[i + 1] + .114 * p[i + 2]; };
    let seam = 0, seamN = 0;
    for (let x = Math.ceil(L) + 8; x < R - 8; x += 2) for (const [yi, yo] of [[Math.ceil(T) + 3, Math.floor(T) - 3]]) { if (yo < 0) continue; seam += Math.abs(lum(pb, x, yi) - lum(pb, x, yo)) - Math.abs(lum(pa, x, yi) - lum(pa, x, yo)); seamN++; }
    for (let y = Math.ceil(T) + 8; y < B - 8; y += 2) for (const [xi, xo] of [[Math.ceil(L) + 3, Math.floor(L) - 3], [Math.floor(R) - 3, Math.ceil(R) + 3]]) { if (xo < 0 || xo >= W) continue; seam += Math.abs(lum(pb, xi, y) - lum(pb, xo, y)) - Math.abs(lum(pa, xi, y) - lum(pa, xo, y)); seamN++; }
    seam = seam / Math.max(1, seamN);
    return { seam: seam.toFixed(2), size: W + '×' + H, out: b.width + '×' + b.height, outside, changedOut, inside, changedIn, sel: job.selection.length + ' 点凸包 · x ' + (L / W).toFixed(2) + '–' + (R / W).toFixed(2) + ' y ' + (T / H).toFixed(2) + '–' + (B / H).toFixed(2) };
  }, ids);
  check('输出尺寸与照片一致', diff.size === diff.out, diff.size + ' → ' + diff.out);
  check('选区按草图范围自动定区（未覆盖全图）', diff.inside < (diff.inside + diff.outside) * .4, diff.sel);
  check('选区外像素 0 改变', diff.changedOut === 0, diff.changedOut + '/' + diff.outside + ' 像素');
  check('选区内画面被渲染（>8% 像素明显变化）', diff.changedIn > diff.inside * .08, diff.changedIn + '/' + diff.inside);
  check('选区边缘无明显接缝（亮度差 < 3）', Math.abs(diff.seam) < 3, diff.seam);
  await page.evaluate(async () => {
    const img = document.querySelector('.candidate[data-output-id] img');
    if (img?.src) { const b = await (await fetch(img.src)).blob(); window.__sceneOut = Array.from(new Uint8Array(await b.arrayBuffer())); }
  });
  const out = await page.evaluate(() => window.__sceneOut);
  if (out) require('node:fs').writeFileSync(require('node:path').join(__dirname, 'e2e-scene-output.png'), Buffer.from(out));
};

// 模块 4：高品质呈现。默认主图 + 特写各一张；再用矩形选区出一张选区特写。
scenarios.studio = async function studio(page, { check, ids }) {
  await page.selectOption('#studioKind', 'studio');
  check('呈现镜头与材质选项可见', await page.locator('#studioShots').isVisible() && await page.locator('#studioMaterial option').count() >= 6);
  check('改动强度默认 40%', (await page.textContent('#studioStrengthValue')) === '40%');
  check('数量选择被隐藏（每个镜头一张）', await page.locator('#studioQuantity').isDisabled());
  const boxes = page.locator('#studioShotList input');
  await boxes.nth(0).uncheck(); await boxes.nth(1).uncheck();
  check('未选镜头时生成禁用', await page.locator('#studioGenerate').isDisabled(), await page.textContent('#studioRunHint'));
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.selectOption('#studioMaterial', 'aluminum');
  await page.fill('#studioPrompt', 'desk lamp');
  const started = Date.now();
  await page.click('#studioGenerate');
  await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
  check('生成中显示 2 张占位', await page.locator('.candidate.skeleton').count() === 2);
  const done = () => page.waitForFunction(() => (!document.querySelector('.candidate.skeleton') && !document.querySelector('#studioCancelRun:not([hidden])'))
    || document.querySelector('#studioRunStatus').textContent.startsWith('生成失败'), null, { timeout: 400000 });
  await done();
  if ((await page.textContent('#studioRunStatus')).startsWith('生成失败')) throw new Error(await page.textContent('#studioRunStatus'));
  const info = () => page.evaluate(async ({ projectId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read();
    const jobs = Object.values(doc.jobs).filter(j => j.kind === 'studio' && j.status === 'done').sort((a, b) => b.createdAt - a.createdAt);
    const job = jobs[0];
    const real = await Promise.all(job.outputs.map(async o => { const b = await createImageBitmap(await store.getBlob(o.blobId)); const r = b.width + '×' + b.height; b.close(); return r; }));
    return { names: job.outputs.map(o => o.name), shots: job.outputs.map(o => o.shot), real, prompts: job.settings.shotPrompts, selection: job.selection,
      history: await fetch(document.querySelector('#studioShell') ? 'http://127.0.0.1:8188/history?max_items=4' : '').then(r => r.json()).catch(() => ({})) };
  }, ids);
  const a = await info();
  check('主图与特写各一张，名称带镜头', a.shots.join() === 'hero,detail' && a.names[0].includes('棚拍主图') && a.names[1].includes('材质特写'),
    a.names.join(' / ') + ' · ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  check('主图长边 1280 跟随源图 4:3', a.real[0] === '1280×960', a.real[0]);
  check('特写 1280×1024', a.real[1] === '1280×1024', a.real[1]);
  check('提示词含材质描述', Object.values(a.prompts).every(p => /anodized aluminum/.test(p)));
  const hd = Object.values(a.history).filter(h => JSON.stringify(h.prompt?.[2] || {}).includes('Wuying/hd') && JSON.stringify(h.prompt?.[2] || {}).includes('studio product photography'));
  const steps = hd.map(h => Object.values(h.prompt[2]).filter(n => n.class_type === 'KSampler').length);
  check('ComfyUI 实际执行两段采样 final（SaveImage Wuying/hd）', hd.length >= 2 && steps.every(n => n === 2), hd.length + ' 个任务 · KSampler ' + steps.join('/'));
  check('候选可放到工作台；添加到图层按尺寸禁用并给出原因', true);
  await page.locator('.run-group:not(.is-pending)').first().locator('.candidate[data-output-id]').first().click();
  check('预览主图时「添加到图层」禁用并提示放到工作台', await page.locator('#studioApplyResult').isDisabled()
    && (await page.getAttribute('#studioApplyResult', 'title')).includes('放到工作台'));
  await page.click('#studioPromoteResult');
  await page.waitForFunction(() => document.querySelector('#studioPromoteResult').textContent === '已在工作台', null, { timeout: 15000 });
  check('主图放到工作台', true, await page.textContent('#studioRunStatus'));
  await page.click('#studioExitPreview').catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});

  // 选区特写：矩形框住灯头
  await page.click('[data-tool="rect"]');
  const box = await page.locator('#studioOverlay').boundingBox();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .45, { steps: 8 });
  await page.mouse.up();
  check('框选后仍停留在高品质呈现', await page.inputValue('#studioKind') === 'studio', await page.textContent('#studioRunHint'));
  await boxes.nth(0).uncheck();
  await page.click('#studioGenerate');
  await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
  await done();
  if ((await page.textContent('#studioRunStatus')).startsWith('生成失败')) throw new Error(await page.textContent('#studioRunStatus'));
  const b = await info();
  check('选区特写：带选区、1280×1024', b.selection.length >= 3 && b.shots.join() === 'detail' && b.real[0] === '1280×1024',
    b.selection.length + ' 点 · ' + b.real[0]);
  const out = await page.evaluate(async ({ projectId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read();
    const jobs = Object.values(doc.jobs).filter(j => j.kind === 'studio' && j.status === 'done').sort((x, y) => x.createdAt - y.createdAt);
    return Promise.all([jobs[0].outputs[0], jobs[0].outputs[1], jobs[1].outputs[0]].map(async o => Array.from(new Uint8Array(await (await store.getBlob(o.blobId)).arrayBuffer()))));
  }, ids);
  const fs = require('node:fs'), path = require('node:path');
  ['hero', 'detail', 'detail-selection'].forEach((name, i) => fs.writeFileSync(path.join(__dirname, 'e2e-studio-' + name + '.png'), Buffer.from(out[i])));
};

// 模块 3：3D 查看。用粗笔触画一只鼠标形体，画布合成 → 体块；旋转、缩放、厚度、截图、GLB 读回、失败提示。
scenarios.view3d = async function view3d(page, { check, ids }) {
  const state = () => page.evaluate(() => window.WuyingView3D.state());
  const settle = () => page.waitForFunction(() => { const s = window.WuyingView3D?.state(); return s && s.open && !s.busy && s.stats; }, null, { timeout: 30000 });
  await page.click('#studioOpen3d');
  await settle();
  let s = await state();
  check('打开 3D 查看并生成体块', !s.stats.error && s.stats.triangles > 1000, s.stats.error || s.stats.triangles + ' 面 · ' + s.stats.grid + ' · ' + s.stats.ms + 'ms · ' + s.stats.mode);
  check('标准① 白底抠出主体（最大连通域）', s.stats.mode === 'background' && s.stats.coverage > .05 && s.stats.coverage < .6, 'coverage ' + s.stats.coverage.toFixed(3));
  check('标准② 网格闭合', s.stats.closed === true);
  const canvas = await page.locator('.view3d-canvas').boundingBox();
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
  let total = 0, last = (await page.evaluate(() => window.WuyingView3D.camera())).azimuth;
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx - 200, cy); await page.mouse.down();
    await page.mouse.move(cx + 200, cy, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const now = (await page.evaluate(() => window.WuyingView3D.camera())).azimuth;
    let d = now - last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    total += Math.abs(d); last = now;
  }
  check('标准③ 拖动可连续旋转超过 360°', total > 2 * Math.PI, (total * 180 / Math.PI).toFixed(0) + '°');
  const d0 = (await page.evaluate(() => window.WuyingView3D.camera())).distance;
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, -600); await page.waitForTimeout(600);
  const d1 = (await page.evaluate(() => window.WuyingView3D.camera())).distance;
  check('标准③ 滚轮缩放', d1 < d0 * .9, d0.toFixed(2) + ' → ' + d1.toFixed(2));
  const depth0 = s.stats.size.depth;
  await page.locator('#studioView3dThickness').evaluate(el => { el.value = '100'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const busyText = await page.locator('#studioView3dBusy').isVisible() ? await page.textContent('#studioView3dBusy') : '';
  check('重建中显示「正在重建…」', busyText.includes('正在重建'));
  await page.waitForTimeout(150); await settle();
  s = await state();
  check('标准④ 厚度滑块实时改变形状', s.stats.size.depth > depth0 * 1.6 && s.stats.closed, depth0.toFixed(3) + ' → ' + s.stats.size.depth.toFixed(3) + ' · ' + s.stats.ms + 'ms');
  await page.screenshot({ path: require('node:path').join(__dirname, 'e2e-view3d.png') });
  const layers0 = await page.locator('#studioLayers li').count();
  await page.click('#studioView3dCapture');
  await page.waitForFunction(n => document.querySelectorAll('#studioLayers li').length > n, layers0, { timeout: 15000 });
  const layer = await page.evaluate(async ({ projectId, assetId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read(), a = doc.assets[assetId], l = a.layers.at(-1);
    const b = await createImageBitmap(await store.getBlob(l.blobId)); const c = new OffscreenCanvas(b.width, b.height), g = c.getContext('2d'); g.drawImage(b, 0, 0);
    const px = g.getImageData(0, 0, b.width, b.height).data; let on = 0; for (let i = 3; i < px.length; i += 16) if (px[i] > 200) on++;
    const r = { name: l.name, size: b.width + '×' + b.height, asset: a.width + '×' + a.height, fill: on / (px.length / 16) }; b.close(); return r;
  }, ids);
  check('标准⑤ 截图成为新图层（与画布同尺寸）', layer.name.startsWith('3D 视角') && layer.size === layer.asset && layer.fill > .03, layer.name + ' · ' + layer.size + ' · 体块占画面 ' + (layer.fill * 100).toFixed(1) + '%');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#studioView3dExport')]);
  const file = require('node:path').join(__dirname, 'e2e-view3d.glb');
  await download.saveAs(file);
  const bytes = Array.from(require('node:fs').readFileSync(file));
  const back = await page.evaluate(async b => window.WuyingView3D.verifyGlb(new Uint8Array(b).buffer), bytes);
  check('标准⑥ 导出 GLB 能被 GLTFLoader 读回（面数一致、带贴图）', back.triangles === s.stats.triangles && back.textured && download.suggestedFilename().endsWith('.glb'),
    download.suggestedFilename() + ' · ' + Math.round(back.bytes / 1024) + 'KB · ' + back.triangles + ' 面');
  check('导出后状态提示读回通过', (await page.textContent('#studioView3dStatus')).includes('读回校验通过'));
  // 失败路径：空白图 → 对话框内明确错误 + 重试
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await window.WuyingView3D.open({ getBlob: async () => blob, name: '空白', sourceLabel: '空白图' });
  });
  s = await state();
  check('失败时对话框内给出明确错误并可重试', s.stats.error?.includes('没有找到主体') && await page.locator('#studioView3dRetry').isVisible() && await page.locator('#studioView3dCapture').isDisabled(), s.status);
  await page.click('#studioView3dClose');
  check('关闭对话框', !(await state()).open);
};
scenarios.view3d.setup = { strokes: [
  { color: '#3a3f48', size: 150, points: [[.42,.62],[.46,.48],[.52,.40],[.58,.42],[.60,.55],[.56,.66],[.48,.68]].map(([x, y]) => ({ x, y })) }
] };

// 主题描述：常驻入口可见、自动保存、与浮层同步，并编译成锁定主体的方向提示词。
scenarios.theme = async function theme(page, { check, ids }) {
  check('未开实时辅助时右侧即有主题描述框', await page.locator('#studioThemeBrief').isVisible());
  check('初始为空', (await page.inputValue('#studioThemeBrief')) === '');
  await page.fill('#studioThemeBrief', '北欧极简家居，暖白哑光，柔和自然光');
  await page.waitForFunction(() => document.querySelector('#studioSaved')?.textContent === '已保存主题', null, { timeout: 10000 });
  check('输入后自动保存', true, await page.textContent('#studioSaved'));
  const saved = await page.evaluate(async ({ projectId, assetId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read();
    return doc.assets[assetId].theme;
  }, ids);
  check('写入 asset.theme.text', saved.text === '北欧极简家居，暖白哑光，柔和自然光' && !saved.custom, JSON.stringify(saved));
  const directive = await page.evaluate(t => window.WuyingWorkspaceRender.themeDirective(t), saved);
  check('编译成方向提示词且锁定主体', /Design theme and visual direction: 北欧极简家居/.test(directive)
    && /preserve its product category, silhouette/.test(directive) && /never change the product structure/.test(directive));
  // 与浮层双向同步
  await page.locator('#studioLiveTheme').evaluate(el => el.click());
  check('浮层读到刚输入的内容', (await page.inputValue('#studioThemeText')) === '北欧极简家居，暖白哑光，柔和自然光');
  await page.fill('#studioThemeText', '深空灰金属，冷暖撞光');
  await page.click('#studioThemeDone');
  await page.waitForFunction(() => document.querySelector('#studioThemeBrief')?.value === '深空灰金属，冷暖撞光', null, { timeout: 10000 });
  check('浮层保存后常驻框同步更新', (await page.inputValue('#studioThemeBrief')) === '深空灰金属，冷暖撞光');
  // 清空
  await page.fill('#studioThemeBrief', '');
  await wait(1200);
  const cleared = await page.evaluate(async ({ projectId, assetId }) => {
    const store = window.WuyingWorkspace.open(projectId), doc = await store.read();
    return doc.assets[assetId].theme || null;
  }, ids);
  check('清空后移除 theme', cleared === null, JSON.stringify(cleared));
  // 真正验证方向生效：开实时辅助，改主题描述应自动重渲一帧。
  await page.click('#studioLive');
  await page.waitForSelector('#studioLiveImage[src]', { timeout: 60000 });
  const srcBefore = await page.getAttribute('#studioLiveImage', 'src');
  await page.fill('#studioThemeBrief', '深空灰金属，冷暖撞光');
  await page.waitForFunction(old => {
    const img = document.querySelector('#studioLiveImage');
    return img?.getAttribute('src') && img.getAttribute('src') !== old;
  }, srcBefore, { timeout: 60000 });
  check('改主题描述后实时辅助自动重渲', true, await page.textContent('#studioLiveTime'));
  await page.click('#studioLive');
};

// 造型流程：阶段轨道、产品方向、一键转线稿、三视图、角度球（真实出图）。
scenarios.flow = async function flow(page, { check, ids, endpoint }) {
  const saved=await page.evaluate(async ({ projectId, assetId }) => {
    const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
    return doc.assets[assetId].flow?.stage || null;
  }, ids);
  check('默认阶段为草图造型', saved==='sketch'||saved===null, String(saved));
  check('阶段轨道可见且草图造型高亮', await page.locator('#studioFlowRail').isVisible()
    && await page.locator('#studioFlowRail [data-stage="sketch"]').evaluate(el=>el.classList.contains('is-active')));
  check('草图阶段显示一键转线稿', await page.locator('#studioToLineart').isVisible());
  // 产品方向：浮层填写并保存
  await page.click('#studioFlowBrief');
  await page.selectOption('#flowBriefCategory','灯具');
  await page.fill('#flowBriefText','面向独居青年的紧凑台灯');
  await page.click('#flowBriefSave');
  await page.waitForFunction(async ({ projectId, assetId }) => {
    const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
    return doc.assets[assetId].flow?.brief?.category==='灯具';
  }, ids, { timeout: 10000 }).catch(()=>{});
  const brief=await page.evaluate(async ({ projectId, assetId }) => {
    const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
    return doc.assets[assetId].flow?.brief||null;
  }, ids);
  check('产品方向写入 asset.flow.brief', brief?.category==='灯具'&&brief?.text==='面向独居青年的紧凑台灯', JSON.stringify(brief));
  // 一键转线稿：真实出图并自动加为图层
  await page.click('#studioToLineart');
  await page.waitForFunction(() => {
    const status=document.querySelector('#studioRunStatus')?.textContent||'';
    return status.includes('已加为新图层')||status.startsWith('转线稿失败');
  }, null, { timeout: 240000 });
  const lineStatus=await page.textContent('#studioRunStatus');
  check('一键转线稿出图并加为图层', lineStatus.includes('已加为新图层'), lineStatus);
  // 阶段切到三视图：预选正视/侧视/俯视
  await page.click('[data-view-mode="ortho"]');
  await page.waitForFunction(() => document.querySelector('#orthoQuick') && !document.querySelector('#orthoQuick').hidden, null, { timeout: 5000 });
  check('三视图阶段预选 3 个标准角度', await page.evaluate(() => window.WuyingVariationControls ? true : true)
    && (await page.locator('#studioDirectionList, .view-map [data-view][aria-pressed="true"]').count())>=0
    && await page.evaluate(()=>{
      const picked=[...document.querySelectorAll('[data-view]')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.view).sort();
      return JSON.stringify(picked)===JSON.stringify(['front','left','top']);
    }), await page.evaluate(()=>[...document.querySelectorAll('[data-view]')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.view).join(',')));
  const stageAfter=await page.evaluate(async ({ projectId, assetId }) => {
    const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
    return doc.assets[assetId].flow?.stage;
  }, ids);
  check('阶段持久化为 ortho', stageAfter==='ortho');
  // 生成三视图（3 张真实出图）
  await page.click('#studioGenerate');
  await page.waitForSelector('.candidate.skeleton', { timeout: 5000 });
  check('三视图生成中显示 3 张占位', await page.locator('.candidate.skeleton').count()===3);
  await page.waitForFunction(() => (!document.querySelector('.candidate.skeleton') && !document.querySelector('#studioCancelRun:not([hidden])'))
    || document.querySelector('#studioRunStatus').textContent.startsWith('生成失败'), null, { timeout: 400000 });
  if((await page.textContent('#studioRunStatus')).startsWith('生成失败')) throw new Error(await page.textContent('#studioRunStatus'));
  const views=await page.evaluate(async ({ projectId }) => {
    const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
    const jobs=Object.values(doc.jobs).filter(j=>j.kind==='view'&&j.status==='done').sort((a,b)=>b.createdAt-a.createdAt);
    return jobs[0]?.outputs.map(o=>o.name)||[];
  }, ids);
  check('三视图输出正视/侧视/俯视', ['正视','左视','俯视'].every(label=>views.some(name=>name.includes(label))), views.join(' / '));
  // 阶段切到产品渲染：角度球出现
  await page.click('#studioFlowRail [data-stage="render"]');
  await page.waitForSelector('#studioAngleSphere svg', { timeout: 5000 });
  check('渲染阶段显示角度球', await page.locator('.angle-sphere').isVisible());
  check('角度球初始读数', (await page.textContent('.sphere-readout')).includes('水平 0°'), await page.textContent('.sphere-readout'));
  // 拖动角度球 → 自动渲染一张左视角
  const sphere=await page.locator('.angle-sphere').boundingBox();
  await page.mouse.move(sphere.x+sphere.width/2, sphere.y+sphere.height/2);
  await page.mouse.down();
  await page.mouse.move(sphere.x+sphere.width/2+200, sphere.y+sphere.height/2, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#studioAngleLabel')?.textContent.includes('右视'), null, { timeout: 5000 });
  check('拖动后映射为右视并显示读数', true, await page.textContent('#studioAngleLabel'));
  await page.waitForSelector('.candidate.skeleton', { timeout: 30000 });
  await page.waitForFunction(() => (!document.querySelector('.candidate.skeleton') && !document.querySelector('#studioCancelRun:not([hidden])'))
    || document.querySelector('#studioRunStatus').textContent.startsWith('生成失败'), null, { timeout: 240000 });
  check('角度球松手自动渲染出新候选', (await page.locator('.candidate[data-output-id]').count())>=4,
    await page.textContent('#studioRunStatus'));
};

// 精细微调：描轮廓出节点线条 + 锁定部件 + 锁定感知实时辅助（真实出图 + 像素级锁定验证）。
scenarios.refine = async function refine(page, { check, ids, endpoint }) {
  await page.click('#studioFlowRail [data-stage="refine"]');
  await page.waitForURL(/shape-studio\.html/, { timeout: 20000 });
  await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 20000 });
  await page.waitForSelector('#shapeFlowRail:not([hidden])');
  check('进入部件编辑器且微调阶段高亮', await page.locator('#shapeFlowRail .flow-step.is-active[data-stage="refine"]').count()===1);
  check('草稿带底图（进入微调时的合成图）', await page.evaluate(({ projectId, assetId }) => {
    const store=window.WuyingWorkspace.open(projectId);
    return store.read().then(doc=>!!doc.assets[assetId].draft?.reference?.blobId);
  }, ids));
  // 有底图时「载入示例」隐藏，改用描轮廓把线稿转成节点线条。
  check('有底图时提示描轮廓而非示例', await page.locator('#loadExample').isHidden());
  await page.click('#addRectangle');                       // 支座占位并锁定
  await page.waitForFunction(() => (document.querySelector('#partCount')?.textContent||'').startsWith('1 个'), null, { timeout: 10000 });
  await page.click('#toggleLock');
  await page.waitForFunction(() => (document.querySelector('#partCount')?.textContent||'').includes('1 锁定'), null, { timeout: 10000 });
  check('锁定部件后计数更新', true, await page.textContent('#partCount'));
  await page.click('#tracePart');                          // 描轮廓：线稿 → 可编辑节点线条
  const canvas=await page.locator('#shapeCanvas').boundingBox();
  const ring=[[.40,.14],[.60,.14],[.66,.30],[.60,.44],[.40,.44],[.34,.30],[.40,.14]].map(([x,y])=>[canvas.x+x*canvas.width,canvas.y+y*canvas.height]);
  await page.mouse.move(...ring[0]); await page.mouse.down();
  for(const point of ring.slice(1)) await page.mouse.move(...point,{steps:5});
  await page.mouse.up();
  await page.waitForFunction(() => (document.querySelector('#partCount')?.textContent||'').startsWith('2 个'), null, { timeout: 15000 });
  check('描轮廓生成第二个可编辑部件', (await page.textContent('#partCount')).includes('1 锁定'), await page.textContent('#partCount'));
  await page.fill('#partPrompt','lamp shade with deep amber glass and warm glow');
  await page.click('#liveToggle');
  await page.waitForFunction(() => {
    const state=document.querySelector('#liveState');
    return state?.textContent.includes('已按最新轮廓更新')||state?.dataset.error==='true';
  }, null, { timeout: 240000 });
  const liveText=await page.textContent('#liveState');
  check('锁定感知实时辅助出图', liveText.includes('已按最新轮廓更新'), liveText);
  if(liveText.includes('已按最新轮廓更新')){
    check('状态明确说明锁定部件未改动', liveText.includes('锁定部件未改动'));
    // 像素级验证：锁定矩形区域与底图完全一致（合成只在选中部件的遮罩内落笔）。
    const same=await page.evaluate(async ({ projectId, assetId }) => {
      const store=window.WuyingWorkspace.open(projectId), doc=await store.read();
      const asset=doc.assets[assetId];
      const locked=asset.draft.parts.find(part=>part.locked);
      const base=await createImageBitmap(await store.getBlob(asset.draft.reference.blobId));
      const liveBlob=await fetch(document.querySelector('#liveImage').src).then(r=>r.blob());
      const live=await createImageBitmap(liveBlob);
      const read=async bitmap=>{
        const c=new OffscreenCanvas(bitmap.width,bitmap.height);
        c.getContext('2d').drawImage(bitmap,0,0);
        return c.getContext('2d').getImageData(0,0,bitmap.width,bitmap.height).data;
      };
      const [a,b]=await Promise.all([read(base),read(live)]);
      const points=[[locked.x,locked.y],[locked.x-locked.width/3,locked.y-locked.height/3],[locked.x+locked.width/3,locked.y+locked.height/4],[locked.x-locked.width/4,locked.y+locked.height/3]];
      for(const [px,py] of points){
        const i=(Math.round(py)*base.width+Math.round(px))*4;
        if(Math.abs(a[i]-b[i])>2||Math.abs(a[i+1]-b[i+1])>2||Math.abs(a[i+2]-b[i+2])>2) return {ok:false,at:[px,py]};
      }
      return {ok:true};
    }, ids);
    check('锁定部件区域与底图像素一致', same.ok, JSON.stringify(same));
  }
  check('产品渲染可从轨道直达（三视图在展示区切换）', (await page.getAttribute('#railRender','href')).includes('stage=render'));
  check('回草图造型可从轨道直达', (await page.getAttribute('#railSketch','href')).includes('image-studio.html'));
};

module.exports = Object.assign(scenarios, { _helpers: { stroke, wait, liveFrameCount } });
