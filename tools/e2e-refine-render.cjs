// 精细微调 + 产品渲染两个模块的端到端验收：
// 微调：手绘轮廓 → 规整化为标准圆 → 节点仍可拖动
// 渲染：右侧顺序 = 3D 角度 → 两步流程 → 产品方向；未白模时精修禁用；白模后解锁并记下机位
// 运行：node tools/e2e-refine-render.cjs（需要 8881 服务）
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  // 预置出图来源，否则渲染页会先弹「模型连接」而不是走流程
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wuying-workspace-model-v1', JSON.stringify({
        provider: 'comfy', endpoint: 'http://127.0.0.1:8188',
        checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', controlnet: 'control_v11p_sd15_scribble_fp16.safetensors'
      }));
    } catch {}
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let projectId = null;

  try {
    await page.goto(origin + '/files.html');
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('三模块E2E')).id);

    // 造一个「画得不圆」的表盘部件：24 点，半径带抖动
    const assetId = await page.evaluate(async pid => {
      const store = window.WuyingWorkspace.open(pid);
      const id = crypto.randomUUID(), now = Date.now();
      const points = Array.from({ length: 24 }, (_, i) => {
        const t = i / 24 * Math.PI * 2;
        const r = .5 + (i % 4 === 0 ? .06 : i % 3 === 0 ? -.05 : 0);
        return { x: Math.round(r * Math.cos(t) * 1000) / 1000, y: Math.round(r * Math.sin(t) * 1000) / 1000 };
      });
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '挂钟表盘', x: 80, y: 80, width: 800, height: 600, createdAt: now, updatedAt: now, layers: [],
          flow: { stage: 'render' },
          draft: { revision: 'r0', parts: [{
            id: 'dial', shape: 'polygon', name: '表盘', locked: false,
            x: 400, y: 300, width: 220, height: 220, angle: 0, depth: 26, z: 0, points
          }] }
        };
      });
      return id;
    }, projectId);

    // ── 精细微调模块 ──
    await page.goto(origin + '/shape-studio.html?project=' + projectId + '&asset=' + assetId);
    await page.waitForSelector('#shapeShell:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('#tidySuggest', { timeout: 10000 });

    const tidyCopy = await page.evaluate(() => ({
      hint: document.querySelector('#tidyHint')?.textContent || '',
      suggest: document.querySelector('#tidySuggest')?.textContent || '',
      disabled: document.querySelector('#tidySuggest')?.disabled,
      manual: [...document.querySelectorAll('[data-tidy]')].map(b => b.textContent.trim())
    }));
    check('微调页出现「规整化」区块并给出建议', /建议规整为圆/.test(tidyCopy.suggest) && !tidyCopy.disabled,
      tidyCopy.suggest);
    check('提供四个手动标准形入口', tidyCopy.manual.join('/') === '圆/椭圆/矩形/圆角矩形', tidyCopy.manual.join('/'));

    await page.click('#tidySuggest');
    await page.waitForFunction(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const part = Object.values(doc.assets).flatMap(a => a.draft?.parts || [])[0];
      return part?.points?.length === 16;
    }, projectId, { timeout: 15000 });
    const tidy = await page.evaluate(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const part = Object.values(doc.assets).flatMap(a => a.draft?.parts || [])[0];
      return {
        shape: part.shape, nodes: part.points.length,
        ratio: Math.round(part.width / part.height * 100) / 100,
        name: part.name
      };
    }, projectId);
    check('规整后吸附成标准圆（宽高相等）', Math.abs(tidy.ratio - 1) < .03, '宽高比 ' + tidy.ratio);
    check('规整后仍是 polygon，节点保留 16 个', tidy.shape === 'polygon' && tidy.nodes === 16, JSON.stringify(tidy));
    check('部件名称保留', tidy.name === '表盘');

    // 节点仍可拖：画布上有可交互节点手柄
    const handles = await page.evaluate(() => document.querySelectorAll('#shapeCanvas circle[data-node]').length);
    check('规整后画布仍有可拖节点手柄', handles >= 8, handles + ' 个');

    // ── 产品渲染模块 ──
    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId);
    await page.waitForSelector('#studioStage', { timeout: 15000 });
    await sleep(900);

    const order = await page.evaluate(() =>
      [...document.querySelectorAll('.operations > .inspector-group')].map(node => node.id).filter(Boolean));
    const angleAt = order.indexOf('angleGroup');
    const flowAt = order.indexOf('renderFlow');
    const dirAt = order.indexOf('directionGroup');
    check('右侧顶部是 3D 角度模块', angleAt >= 0 && angleAt < flowAt, order.join(' → '));
    check('角度模块下紧接两步渲染流程', flowAt >= 0 && flowAt < dirAt, '角度 ' + angleAt + ' / 流程 ' + flowAt);
    check('渲染流程在描述输入之前（从上到下）', flowAt >= 0 && flowAt < dirAt);

    const steps = await page.evaluate(() => ({
      mold: document.querySelector('#stepMold')?.dataset.state,
      final: document.querySelector('#stepFinal')?.dataset.state,
      finalDisabled: document.querySelector('#runFinal')?.disabled,
      hasDescription: !!document.querySelector('#finalPrompt'),
      sphereMounted: document.querySelector('#studioAngleSphere')?.children.length > 0
    }));
    check('两步状态初始为「白模可做、精修锁定」', steps.mold === 'ready' && steps.final === 'locked' && steps.finalDisabled,
      JSON.stringify(steps));
    check('精细渲染有独立的描述输入区', steps.hasDescription);
    check('3D 角度球已挂载', steps.sphereMounted);

    // 画笔与橡皮尺寸分离（图像编辑室同样适用）
    const brushes = await page.evaluate(() => ({
      brush: !!document.querySelector('#studioSize'),
      erase: !!document.querySelector('#studioEraseSize'),
      brushLabel: document.querySelector('#studioSizeField')?.textContent.trim().slice(0, 4),
      eraseLabel: document.querySelector('#studioEraseField')?.textContent.trim().slice(0, 4),
      brushActive: document.querySelector('#studioSizeField')?.classList.contains('is-active')
    }));
    check('画笔与橡皮是两个独立尺寸入口',
      brushes.brush && brushes.erase && brushes.brushLabel !== brushes.eraseLabel,
      JSON.stringify(brushes));
    // 渲染阶段按设计隐藏画笔工具栏（这一阶段不画草图）。橡皮高亮的实际点击验证
    // 放到最后切回草图阶段再做，避免中途 reload 打断白模/精修的状态机。
    const toolsHidden = await page.evaluate(() => {
      const tools = document.querySelector('.editor-tools');
      return tools ? getComputedStyle(tools).display === 'none' : null;
    });
    check('渲染阶段隐藏画笔工具栏', toolsHidden === true, String(toolsHidden));

    // mock 出图：验证状态机与机位记录（不真跑模型）
    await page.evaluate(() => {
      window.__moldRequest = null;
      window.WuyingWorkflow.run = async (store, request) => {
        window.__moldRequest = request;
        const id = crypto.randomUUID(), blobId = crypto.randomUUID(), jobId = crypto.randomUUID();
        const now = Date.now();
        const blob = new Blob([new Uint8Array(4096)], { type: 'image/png' });
        let job = null;
        await store.change(doc => {
          job = { id: jobId, sourceId: request.sourceId, kind: request.kind, status: 'done', createdAt: now,
            outputs: [{ id, blobId, name: '白模', width: 640, height: 480 }] };
          doc.jobs[jobId] = job;
          doc.assets[id] = { id, name: '白模', x: 900, y: 80, width: 640, height: 480,
            createdAt: now, updatedAt: now, jobId,
            layers: [{ id: 'l', name: '白模', kind: 'image', blobId, visible: true, opacity: 1 }] };
        }, [{ id: blobId, blob }]);
        return job;
      };
    });
    await page.click('#runMold');
    await page.waitForFunction(() => document.querySelector('#stepFinal')?.dataset.state === 'ready', null, { timeout: 15000 })
    // 两步流程要求先确认白模与机位，确认之后精修才解锁。
    await page.waitForSelector('#moldConfirm:not([disabled])', { timeout: 10000 });
    await page.click('#moldConfirm');
    await page.waitForFunction(() => document.querySelector('#runFinal')?.disabled === false, null, { timeout: 10000 })
      .catch(async () => {
        const diag = await page.evaluate(() => ({
          status: document.querySelector('#flowStatus')?.textContent,
          dialog: !document.querySelector('#studioModelDialog')?.hidden,
          runType: typeof window.WuyingWorkflow.run,
          ready: (() => { try { return window.WuyingWorkflow.ready(JSON.parse(localStorage.getItem('wuying-workspace-model-v1') || '{}')); } catch (e) { return String(e); } })()
        }));
        console.log('白模未完成，诊断:', JSON.stringify(diag));
      });
    await sleep(400);
    const afterMold = await page.evaluate(async pid => {
      const doc = await window.WuyingWorkspace.open(pid).read();
      const target = Object.values(doc.assets).find(a => a.render?.mold);
      return {
        finalDisabled: document.querySelector('#runFinal')?.disabled,
        previewShown: !document.querySelector('#moldPreview')?.hidden,
        meta: document.querySelector('#moldMeta')?.textContent || '',
        mold: target?.render?.mold || null,
        request: window.__moldRequest
      };
    }, projectId);
    check('白模完成后精修解锁', afterMold.finalDisabled === false);
    check('白模预览与机位信息显示', afterMold.previewShown && /水平/.test(afterMold.meta), afterMold.meta);
    check('白模请求带当前机位（多视角一致的基础）',
      !!afterMold.request?.viewAngles && Object.keys(afterMold.request.viewAngles).length === 1,
      JSON.stringify(afterMold.request?.viewAngles));
    check('白模结果与角度存进资产', !!afterMold.mold?.angles, JSON.stringify(afterMold.mold?.angles));

    // 切回草图阶段验证画笔/橡皮入口的互斥高亮（渲染阶段工具栏是隐藏的，点不到）。
    await page.evaluate(async ({ pid, id }) => {
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => { doc.assets[id].flow = { ...(doc.assets[id].flow || {}), stage: 'sketch' }; });
    }, { pid: projectId, id: assetId });
    await page.reload();
    await page.waitForSelector('#studioStage', { timeout: 20000 });
    await sleep(1000);
    await page.click('[data-tool="erase"]');
    await sleep(250);
    const toolSwitch = await page.evaluate(() => ({
      eraseActive: document.querySelector('#studioEraseField')?.classList.contains('is-active'),
      brushActive: document.querySelector('#studioSizeField')?.classList.contains('is-active')
    }));
    check('切到橡皮时高亮橡皮入口', toolSwitch.eraseActive && !toolSwitch.brushActive, JSON.stringify(toolSwitch));

    check('无页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
    if (projectId) {
      try {
        const cleanup = loadPlaywright();
        const b = await cleanup.chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
        const p = await b.newPage();
        await p.goto(origin + '/files.html');
        await p.evaluate(async id => { await fetch('/api/projects/' + id, { method: 'DELETE' }); }, projectId);
        await b.close();
      } catch (error) { console.log('清理项目失败:', error.message); }
    }
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { console.log('失败项：' + failed.map(item => item.name).join('；')); process.exitCode = 1; }
})();
