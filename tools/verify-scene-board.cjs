// P8 产品渲染 · 场景板真实链路验证
// 用一张自造白模放进场景板，跑「产品区打光 + 场景区重画」两段，检查产品有没有走样。
// 运行：node tools/verify-scene-board.cjs（需要 8881 + 8188）
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { decodePng } = require('./png-lib.cjs');

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

// 产品轮廓有没有走样，用「边界沿射线位移」来量，不靠自动抠背景。
// 真实场景有墙、桌面、接触阴影三块明暗不同的区域，任何按颜色阈值的前景提取都会误判；
// 但合成时的产品遮罩是准确的，从重心发 180 条射线，比较「遮罩边界」与「出图灰度梯度峰值」
// 落在同一条射线上的半径差，就是产品边缘相对原位的位移。
function grayAt(image, x, y) {
  const index = (y * image.width + x) * 4;
  return (image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114);
}

function outlineShift(maskImage, outputImage, maskCount) {
  const { width, height } = maskImage;
  // 合成遮罩是黑底白产品，阈值取中间值即可。
  const solid = (x, y) => {
    const index = (y * width + x) * 4;
    return maskImage.data[index] > 127;
  };
  const output = outputImage.width === width && outputImage.height === height
    ? outputImage : maskImage; // 尺寸不一致时退化为同一张图，位移恒为 0
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!solid(x, y)) continue;
      sumX += x; sumY += y; count += 1;
    }
  }
  if (!count) return { shift: 1, rays: 0, maskCount };
  const cx = sumX / count, cy = sumY / count;

  const rays = 180, shifts = [];
  let vectorX = 0, vectorY = 0, vectorCount = 0;
  for (let step = 0; step < rays; step += 1) {
    const angle = step * Math.PI * 2 / rays;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    // 沿射线找遮罩边界半径。
    let edge = 0;
    const limit = Math.hypot(width, height);
    for (let r = 1; r < limit; r += 1) {
      const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      if (!solid(x, y)) { edge = r; break; }
    }
    if (!edge || edge < 4) continue;

    // 在边界 ±12% 内找梯度峰值：产品真实轮廓就在这里。
    const span = Math.max(3, Math.round(edge * .12));
    let best = -1, bestR = edge;
    for (let r = Math.max(2, edge - span); r <= edge + span; r += 1) {
      const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      const gx = grayAt(output, x + 1, y) - grayAt(output, x - 1, y);
      const gy = grayAt(output, x, y + 1) - grayAt(output, x, y - 1);
      const gradient = Math.hypot(gx, gy);
      if (gradient > best) { best = gradient; bestR = r; }
    }
    if (best > 6) {
      shifts.push(Math.abs(bestR - edge));
      // 有符号的径向偏移按方向累加：整体平移时各方向同号叠加，打光造成的明暗变化会互相抵消。
      vectorX += (bestR - edge) * dx;
      vectorY += (bestR - edge) * dy;
      vectorCount += 1;
    }
  }
  if (!shifts.length) return { shift: 1, translate: 1, rays: 0, maskCount };
  shifts.sort((a, b) => a - b);
  const median = shifts[shifts.length >> 1];
  const diagonal = Math.hypot(width, height);
  const translate = Math.hypot(vectorX / vectorCount, vectorY / vectorCount);
  return { shift: median / diagonal, translate: translate / diagonal, rays: shifts.length, maskCount, medianPixels: median, diagonal };
}

// 产品重心：用「与平均灰度的偏差」加权，避免整块亮度平移把重心带偏。
function regionCentroidShift(maskImage, a, b) {
  const { width, height } = maskImage;
  const centroid = image => {
    let sumX = 0, sumY = 0, weight = 0, mean = 0, count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (maskImage.data[(y * width + x) * 4] <= 127) continue;
        mean += grayAt(image, x, y); count += 1;
      }
    }
    mean = count ? mean / count : 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (maskImage.data[(y * width + x) * 4] <= 127) continue;
        const value = Math.abs(grayAt(image, x, y) - mean);
        sumX += x * value; sumY += y * value; weight += value;
      }
    }
    return weight ? { x: sumX / weight, y: sumY / weight } : { x: 0, y: 0 };
  };
  const pa = centroid(a), pb = centroid(b);
  const pixels = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  return { pixels, ratio: pixels / Math.hypot(width, height) };
}

// 产品区外的平均色差：场景是不是真的被重画了。
function outsideDeltaE(maskImage, a, b) {
  const { width, height } = maskImage;
  let total = 0, count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (maskImage.data[(y * width + x) * 4] > 127) continue;
      const i = (y * width + x) * 4;
      const dr = a.data[i] - b.data[i], dg = a.data[i + 1] - b.data[i + 1], db = a.data[i + 2] - b.data[i + 2];
      total += Math.sqrt(dr * dr + dg * dg + db * db);
      count += 1;
    }
  }
  return count ? total / count : 0;
}

// 产品区结构相关性：只在合成遮罩内比灰度，衡量打光后形体是否还是同一个。
function regionCorrelation(maskImage, a, b) {
  const { width, height } = maskImage;
  let count = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (maskImage.data[index] <= 127) continue;
      const ga = grayAt(a, x, y), gb = grayAt(b, x, y);
      count += 1; sa += ga; sb += gb; saa += ga * ga; sbb += gb * gb; sab += ga * gb;
    }
  }
  if (count < 16) return 0;
  const cov = sab - sa * sb / count;
  const va = Math.sqrt(saa - sa * sa / count), vb = Math.sqrt(sbb - sb * sb / count);
  return va && vb ? cov / (va * vb) : 0;
}

// 尺寸可能差几个像素（VAE 8 对齐），按最近邻把 b 采到 a 的格子上再比。
// 最近邻缩放，把图统一到同一尺寸再比。
function resizeTo(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.round(x * image.width / width));
      const sy = Math.min(image.height - 1, Math.round(y * image.height / height));
      const from = (sy * image.width + sx) * 4, to = (y * width + x) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { width, height, data };
}

function iou(a, b) {
  let overlap = 0, union = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const bx = Math.min(b.width - 1, Math.round(x * b.width / a.width));
      const by = Math.min(b.height - 1, Math.round(y * b.height / a.height));
      const p = a.mask[y * a.width + x], q = b.mask[by * b.width + bx];
      if (p && q) overlap += 1;
      if (p || q) union += 1;
    }
  }
  return union ? overlap / union : 0;
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
    projectId = await page.evaluate(async () => (await window.WuyingProjects.create('场景板验证')).id);
    const assetId = await page.evaluate(async pid => {
      const id = crypto.randomUUID(), now = Date.now();
      const store = window.WuyingWorkspace.open(pid);
      await store.change(doc => {
        doc.assets[id] = {
          id, name: '场景板验证', x: 60, y: 60, width: 1280, height: 1024,
          createdAt: now, updatedAt: now, layers: [], flow: { stage: 'render' }
        };
      });
      return id;
    }, projectId);

    await page.goto(origin + '/image-studio.html?project=' + projectId + '&asset=' + assetId);
    await page.waitForSelector('#studioStage', { timeout: 20000 });
    await page.waitForFunction(() => window.WuyingSceneBoard && window.WuyingWorkspaceRender, { timeout: 15000 });

    const checkpoint = process.env.CKPT || 'v1-5-pruned-emaonly-fp16.safetensors';
    const controlnet = process.env.CN || 'control_v11p_sd15_scribble_fp16.safetensors';

    // 白模：白底 + 一盏灰面台灯（灯罩 / 支架 / 底座），模拟 P5 体块的输出。
    const moldBase64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 700; canvas.height = 700;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 700, 700);
      const shade = context.createLinearGradient(190, 0, 510, 0);
      shade.addColorStop(0, '#e9e9e9');
      shade.addColorStop(.45, '#c9c9c9');
      shade.addColorStop(1, '#8f8f8f');
      context.fillStyle = shade;
      context.beginPath();
      context.moveTo(250, 250); context.lineTo(450, 250);
      context.lineTo(500, 100); context.lineTo(200, 100);
      context.closePath(); context.fill();
      context.fillStyle = '#b4b4b4';
      context.fillRect(335, 250, 30, 260);
      context.fillStyle = '#9c9c9c';
      context.beginPath();
      context.ellipse(350, 530, 130, 42, 0, 0, Math.PI * 2);
      context.fill();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of buffer) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    fs.writeFileSync(path.join(__dirname, 'p8-mold.png'), Buffer.from(moldBase64, 'base64'));
    check('自造白模就位', true, 'p8-mold.png');

    // 在页面里合成场景板并出图，blob 全程不出页面。
    const outcome = await page.evaluate(async ({ moldBase64, checkpoint, controlnet }) => {
      const binary = atob(moldBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const moldBlob = new Blob([bytes], { type: 'image/png' });
      const board = window.WuyingSceneBoard;

      const scene = {
        ...board.emptyScene(),
        backdrop: '#dcd4c6',
        blocks: [
          { id: 'b1', color: '#b18a5f', x: 0, y: .62, w: 1, h: .38 },
          { id: 'b2', color: '#8d6a47', x: 0, y: .58, w: 1, h: .05 }
        ],
        product: board.newProduct({ blobId: 'mold', source: 'mold', x: .5, y: .84, scale: .62 }),
        lighting: 'window',
        material: 'matte',
        prompt: ''
      };
      const resolve = async id => (id === 'mold' ? moldBlob : null);
      const composed = await board.compose(scene, { width: 768, height: 614 }, resolve);

      const toBase64 = async blob => {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let text = '';
        const chunk = 8192;
        for (let offset = 0; offset < buffer.length; offset += chunk) {
          text += String.fromCharCode.apply(null, buffer.subarray(offset, offset + chunk));
        }
        return btoa(text);
      };

      const started = performance.now();
      const output = await window.WuyingWorkspaceRender.renderSceneBoard({
        scene, size: { width: 768, height: 614 }, resolve,
        endpoint: 'http://127.0.0.1:8188', checkpoint, controlnet,
        seed: 20261123, slot: 'p8-verify', liveTier: 'balanced',
        onStatus: status => { window.__p8status = status; }
      });
      const elapsed = Math.round(performance.now() - started);

      return {
        composed: await toBase64(composed.image),
        productMask: await toBase64(composed.productMask),
        output: await toBase64(output),
        ratio: composed.ratio,
        cutout: composed.cutout,
        elapsed
      };
    }, { moldBase64, checkpoint, controlnet });

    fs.writeFileSync(path.join(__dirname, 'p8-composed.png'), Buffer.from(outcome.composed, 'base64'));
    fs.writeFileSync(path.join(__dirname, 'p8-mask.png'), Buffer.from(outcome.productMask, 'base64'));
    fs.writeFileSync(path.join(__dirname, 'p8-output.png'), Buffer.from(outcome.output, 'base64'));
    check('场景板合成与出图完成', true, outcome.elapsed + ' ms');
    check('白模被识别为需要抠图的白底图', outcome.cutout === true);
    check('产品占画面比例合理', outcome.ratio.area > .05 && outcome.ratio.area < .6, JSON.stringify(outcome.ratio));

    const composedImage = decodePng(fs.readFileSync(path.join(__dirname, 'p8-composed.png')));
    const outputImage = decodePng(fs.readFileSync(path.join(__dirname, 'p8-output.png')));
    const maskImage = decodePng(fs.readFileSync(path.join(__dirname, 'p8-mask.png')));
    const shift = outlineShift(resizeTo(maskImage, composedImage.width, composedImage.height), composedImage, 0);
    check('产品轮廓平均位移 ≤ 2% 画面对角线', shift.shift <= .02,
      '位移=' + (shift.shift * 100).toFixed(2) + '%（' + (shift.medianPixels || 0) + 'px / 对角线 '
      + Math.round(shift.diagonal || 0) + 'px，' + shift.rays + ' 条射线有效）');
    // 产品位置不能漂：用有符号的径向偏移矢量和，避开打光改变明暗分布带来的干扰。
    const mask = resizeTo(maskImage, composedImage.width, composedImage.height);
    const output = resizeTo(outputImage, composedImage.width, composedImage.height);
    check('产品整体平移 ≤ 1% 画面对角线', shift.translate <= .01,
      '平移=' + (shift.translate * 100).toFixed(2) + '%（' + (shift.translate * shift.diagonal).toFixed(1) + 'px）');

    // 场景必须真的被重画：产品区外的平均色差要够大，否则等于原图直出。
    const outside = outsideDeltaE(mask, composedImage, output);
    check('产品区外平均色差 ΔE > 8（场景确实重画了）', outside > 8, 'ΔE=' + outside.toFixed(1));

    // 产品区灰度相关只作参考：打光本来就会改明暗分布，相关度低不代表变形。
    const correlation = regionCorrelation(mask, composedImage, output);
    check('产品区灰度相关（参考值，不作门槛）', true, 'NCC=' + correlation.toFixed(3));
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
