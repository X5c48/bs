// 探针：验证「SD1.5 的 CLIP 77 token 截断」是不是造型探索风格词失效的根因。
// 同一档位、同一种子，只改提示词长度：长提示词（用户描述 + 风格词 + 意图）vs 短提示词（只留风格）。
// 若短提示词能出马克笔草图、长提示词却出照片级白模，说明后半段提示词被截断了。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const comfy = require(path.join(__dirname, '..', 'dist', 'comfy.js'));
const { png } = require(path.join(__dirname, 'png-lib.cjs'));

const endpoint = process.env.COMFY || 'http://127.0.0.1:8188';
const checkpoint = process.env.CKPT || 'v1-5-pruned-emaonly-fp16.safetensors';
const controlnet = process.env.CN || 'control_v11p_sd15_scribble_fp16.safetensors';

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
      toBlob(callback) { callback(new Blob([canvas.__image?.__buffer || Buffer.alloc(0)], { type: 'image/png' })); }
    };
    return canvas;
  };
  return { createImageBitmap, document: { createElement } };
}
function loadRender() {
  const window = { WuyingComfy: comfy, WuyingShapeModel: require(path.join(__dirname, '..', 'dist', 'shape-model.js')) };
  const context = vm.createContext({
    window, Blob, FormData, fetch, crypto, AbortController, AbortSignal,
    setTimeout, clearTimeout, URL, URLSearchParams, structuredClone, console, ...makeCanvasEnv()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'workspace-render.js'), 'utf8'), context);
  return window.WuyingWorkspaceRender;
}

function shapeHit(x, y, width, height) {
  const cx = width / 2;
  const bx = cx - 80, by = 150, bw = 160, bh = 240, r = 26;
  const inRound = (x >= bx && x <= bx + bw && y >= by && y <= by + bh) &&
    Math.hypot(Math.max(bx + r - x, 0, x - (bx + bw - r)), Math.max(by + r - y, 0, y - (by + bh - r))) <= r;
  if (inRound) return true;
  const dx = x - (bx + bw), dy = y - (by + 60), d = Math.hypot(dx, dy);
  return dx >= -2 && dy <= 42 && d >= 30 && d <= 42;
}
function sketchPng(width = 640, height = 480) {
  return png(width, height, (x, y) => {
    if (!shapeHit(x, y, width, height)) return [255, 255, 255, 255];
    const edge = !shapeHit(x + 2, y, width, height) || !shapeHit(x - 2, y, width, height) ||
      !shapeHit(x, y + 2, width, height) || !shapeHit(x, y - 2, width, height);
    return edge ? [18, 18, 20, 255] : [255, 255, 255, 255];
  });
}

// CLIP 的粗估：英文约 1.3 token/词
const tokens = text => Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);

(async () => {
  const render = loadRender();
  const source = new Blob([sketchPng()], { type: 'image/png' });
  const shortPrompt = 'grey marker concept sketch, monochrome value shading, one product, plain white background';
  const longPrompt = 'a thermal travel mug with a handle, ' + render.sketchStyleDirective() +
    ' Explore the form of the sketched product. Keep it readable as the same product category; define volume and value, not materials.';
  console.log('短提示词 ~' + tokens(shortPrompt) + ' tokens；长提示词 ~' + tokens(longPrompt) + ' tokens（SD1.5 上限 77）');

  for (const [name, prompt] of [['short', shortPrompt], ['long', longPrompt]]) {
    const started = Date.now();
    const blob = await render.generate({
      kind: 'render', provider: 'comfy', live: true, liveTier: 'balanced',
      endpoint, checkpoint, controlnet, source, size: { width: 640, height: 480 },
      prompt, seed: 771, explore: { tier: 'loose' }
    });
    const buffer = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(path.join(__dirname, 'probe-token-' + name + '.png'), buffer);
    console.log(name, (Date.now() - started) + 'ms', '→ probe-token-' + name + '.png');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
