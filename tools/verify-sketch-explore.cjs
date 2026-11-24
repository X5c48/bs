// P7 真实链路验证：造型探索三档（贴线 / 推敲 / 发散）
// 指标：白底无场景、贴线档线条 IoU、发散档三候选两两结构差异、单帧耗时。
// 用法：node tools/verify-sketch-explore.cjs [endpoint]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const comfy = require(path.join(__dirname, '..', 'dist', 'comfy.js'));
const { png, decodePng } = require(path.join(__dirname, 'png-lib.cjs'));

const endpoint = process.argv[2] || process.env.COMFY || 'http://127.0.0.1:8188';
const checkpoint = process.env.CKPT || 'v1-5-pruned-emaonly-fp16.safetensors';
const controlnet = process.env.CN || 'control_v11p_sd15_scribble_fp16.safetensors';
const outDir = __dirname;

// workspace-render 需要的最小 canvas / bitmap 垫片（与 verify-render-fixes 一致）
function makeCanvasEnv() {
  const dims = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
  const createImageBitmap = async blob => {
    const buffer = Buffer.from(await blob.arrayBuffer());
    return { ...dims(buffer), __buffer: buffer, close() {} };
  };
  const createElement = tag => {
    if (tag !== 'canvas') throw new Error('unexpected ' + tag);
    const canvas = {
      width: 0, height: 0, __image: null,
      getContext: () => ({
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '', globalAlpha: 1,
        fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
        drawImage(image) { canvas.__image = image; },
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {}
      }),
      toBlob(callback) {
        callback(new Blob([canvas.__image?.__buffer || Buffer.alloc(0)], { type: 'image/png' }));
      }
    };
    return canvas;
  };
  return { createImageBitmap, document: { createElement } };
}

function loadRender() {
  const window = { WuyingComfy: comfy, WuyingShapeModel: require(path.join(__dirname, '..', 'dist', 'shape-model.js')) };
  const context = vm.createContext({
    window, Blob, FormData, fetch, crypto, AbortController, AbortSignal,
    setTimeout, clearTimeout, URL, URLSearchParams, structuredClone, console,
    ...makeCanvasEnv()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'workspace-render.js'), 'utf8'), context);
  return window.WuyingWorkspaceRender;
}

// 保温杯侧视轮廓：圆角柱身 + 杯盖 + 提手，白底 + 浅灰面，用来检验「贴线」是否真的贴住
function shapeHit(x, y, width, height) {
  const cx = width / 2;
  const bx = cx - 80, by = 150, bw = 160, bh = 240, r = 26;
  const inRound = (x >= bx && x <= bx + bw && y >= by && y <= by + bh) &&
    Math.hypot(Math.max(bx + r - x, 0, x - (bx + bw - r)), Math.max(by + r - y, 0, y - (by + bh - r))) <= r;
  if (inRound) return true;
  const dx = x - (bx + bw), dy = y - (by + 60), d = Math.hypot(dx, dy);
  if (dx >= -2 && dy <= 42 && d >= 30 && d <= 42) return true;
  return false;
}
function sketchPng(width = 640, height = 480) {
  return png(width, height, (x, y) => {
    if (!shapeHit(x, y, width, height)) return [255, 255, 255, 255];
    const edge = !shapeHit(x + 2, y, width, height) || !shapeHit(x - 2, y, width, height) ||
      !shapeHit(x, y + 2, width, height) || !shapeHit(x, y - 2, width, height);
    return edge ? [18, 18, 20, 255] : [255, 255, 255, 255];
  });
}

function gray(buf) {
  const img = decodePng(buf);
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < img.data.length; i += img.channels, p += 1) {
    g[p] = .299 * img.data[i] + .587 * img.data[i + 1] + .114 * img.data[i + 2];
  }
  return { width: img.width, height: img.height, g };
}
// 线条 mask：暗于阈值的像素
function lineMask(buf, threshold = 120) {
  const { width, height, g } = gray(buf);
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < g.length; i += 1) if (g[i] < threshold) { mask[i] = 1; count += 1; }
  return { width, height, mask, count };
}
function iou(a, b) {
  const { width, height } = a;
  // 输出可能因 latent 档位落在 800×640，比较前按最近邻重采样到参考图尺寸。
  const sample = (mask, bw, bh, x, y) => {
    const sx = Math.min(bw - 1, Math.round(x * bw / width));
    const sy = Math.min(bh - 1, Math.round(y * bh / height));
    return mask[sy * bw + sx];
  };
  let overlap = 0, union = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const m = a.mask[y * width + x];
      const n = b.width === width && b.height === height ? b.mask[y * width + x] : sample(b.mask, b.width, b.height, x, y);
      if (m && n) overlap += 1;
      if (m || n) union += 1;
    }
  }
  return { iou: union ? overlap / union : 0, a: a.count, b: b.count };
}
// 背景与场景检查
function backgroundStats(buf) {
  const img = decodePng(buf);
  const { width, height, data, channels } = img;
  let white = 0, total = width * height;
  let edgeTotal = 0, edgeChroma = 0;
  const band = Math.max(6, Math.round(Math.min(width, height) * .02));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 240 && g > 240 && b > 240) white += 1;
      const onEdge = x < band || y < band || x >= width - band || y >= height - band;
      if (onEdge) {
        edgeTotal += 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 25) edgeChroma += 1;
      }
    }
  }
  return {
    whiteRatio: white / total,
    edgeChromaRatio: edgeTotal ? edgeChroma / edgeTotal : 0
  };
}
// 结构差异：缩到 32×32 灰度后的归一化余弦距离（LPIPS 的轻量代理，无额外依赖）
function structureDiff(a, b, grid = 32) {
  const small = buf => {
    const { width, height, g } = gray(buf);
    const cell = new Float32Array(grid * grid);
    for (let gy = 0; gy < grid; gy += 1) {
      for (let gx = 0; gx < grid; gx += 1) {
        let sum = 0, n = 0;
        const x0 = Math.floor(gx * width / grid), x1 = Math.floor((gx + 1) * width / grid);
        const y0 = Math.floor(gy * height / grid), y1 = Math.floor((gy + 1) * height / grid);
        for (let y = y0; y < Math.max(y0 + 1, y1); y += 1) {
          for (let x = x0; x < Math.max(x0 + 1, x1); x += 1) { sum += g[y * width + x]; n += 1; }
        }
        cell[gy * grid + gx] = sum / Math.max(1, n);
      }
    }
    return cell;
  };
  const A = small(a), B = small(b);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < A.length; i += 1) {
    const x = 255 - A[i], y = 255 - B[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  const cosine = na && nb ? dot / Math.sqrt(na * nb) : 1;
  return Math.max(0, Math.min(1, 1 - cosine));
}

async function run(render, source, options) {
  const started = Date.now();
  const blob = await render.generate({
    kind: 'render', provider: 'comfy', live: true, liveTier: 'balanced',
    endpoint, checkpoint, controlnet,
    source, size: { width: 640, height: 480 },
    prompt: 'a thermal travel mug with a handle',
    ...options
  });
  const buffer = Buffer.from(await blob.arrayBuffer());
  return { buffer, ms: Date.now() - started };
}

(async () => {
  const render = loadRender();
  const sketchBuffer = sketchPng();
  fs.writeFileSync(path.join(outDir, 'p7-sketch-input.png'), sketchBuffer);
  const source = new Blob([sketchBuffer], { type: 'image/png' });
  const baseLine = lineMask(sketchBuffer);
  const report = { endpoint, checkpoint, controlnet, tiers: {}, candidates: {}, checks: {} };
  const seeds = [20261123, 771, 99173];

  for (const tier of ['tight', 'balanced', 'loose']) {
    const { buffer, ms } = await run(render, source, { explore: { tier }, seed: seeds[0] });
    const file = path.join(outDir, 'p7-' + tier + '.png');
    fs.writeFileSync(file, buffer);
    const bg = backgroundStats(buffer);
    const shape = iou(baseLine, lineMask(buffer));
    report.tiers[tier] = {
      file: path.basename(file), ms,
      whiteRatio: +bg.whiteRatio.toFixed(3),
      edgeChromaRatio: +bg.edgeChromaRatio.toFixed(4),
      lineIou: +shape.iou.toFixed(3),
      linePixels: shape.b
    };
    console.log('[' + tier + ']', JSON.stringify(report.tiers[tier]));
  }

  // 发散档三候选：不同种子，两两比较结构差异
  const loose = [];
  for (const [index, seed] of seeds.entries()) {
    const { buffer, ms } = await run(render, source, { explore: { tier: 'loose' }, seed });
    const file = path.join(outDir, 'p7-loose-cand-' + (index + 1) + '.png');
    fs.writeFileSync(file, buffer);
    loose.push({ buffer, seed, ms });
    console.log('[candidate ' + (index + 1) + '] seed=' + seed + ' ' + ms + 'ms');
  }
  const pairs = [];
  for (let i = 0; i < loose.length; i += 1) {
    for (let j = i + 1; j < loose.length; j += 1) {
      pairs.push({ pair: (i + 1) + '-' + (j + 1), diff: +structureDiff(loose[i].buffer, loose[j].buffer).toFixed(3) });
    }
  }
  report.candidates = { seeds, pairs };

  const tight = report.tiers.tight;
  report.checks = {
    tightIouPass: tight.lineIou >= .7,
    loosenessMonotonic: report.tiers.tight.lineIou >= report.tiers.balanced.lineIou && report.tiers.balanced.lineIou >= report.tiers.loose.lineIou,
    candidatesDiffer: pairs.every(item => item.diff >= .25),
    whiteBackground: Object.values(report.tiers).every(item => item.whiteRatio >= .5),
    noColoredScene: Object.values(report.tiers).every(item => item.edgeChromaRatio <= .02)
  };
  fs.writeFileSync(path.join(outDir, 'p7-verify.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report.checks, null, 2));
  console.log('候选两两差异:', JSON.stringify(pairs));
  const failed = Object.entries(report.checks).filter(([, value]) => !value).map(([key]) => key);
  console.log(failed.length ? '未通过: ' + failed.join(', ') : '全部通过');
  process.exitCode = failed.length ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
