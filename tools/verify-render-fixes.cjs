// 真实链路验证：platform workspace-render → ComfyUI（Qwen / SD1.5）
// 指标：成功率、平均耗时、输出画布比例 vs 参考图比例（造型不被拉伸）
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const comfy = require(path.join(__dirname, '..', 'dist', 'comfy.js'));
const { foregroundBox } = require(path.join(__dirname, 'png-lib.cjs'));

const endpoint = process.env.COMFY || 'http://127.0.0.1:8188';
const qwen = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
const sd = 'v1-5-pruned-emaonly-fp16.safetensors';
const controlnet = 'control_v11p_sd15_scribble_fp16.safetensors';

// 最小 canvas/bitmap 垫片：只保证 workspace-render 的裁切/缩放链路能跑完并回传 PNG
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
  const window = {
    WuyingComfy: comfy,
    WuyingImageSelection: { enough: points => points.length >= 3 },
    WuyingWorkspaceComposite: { toPng: async () => null }
  };
  const context = vm.createContext({
    window, Blob, FormData, fetch, crypto, AbortController, AbortSignal,
    setTimeout, clearTimeout, URL, URLSearchParams, structuredClone, console,
    ...makeCanvasEnv()
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'workspace-render.js'), 'utf8'), context);
  return window.WuyingWorkspaceRender;
}

const blobOf = buffer => new Blob([buffer], { type: 'image/png' });
const dims = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

(async () => {
  const render = loadRender();
  const plate = fs.readFileSync(path.join(__dirname, 'probe-plate-43.png'));
  const ref = foregroundBox(plate);
  const refAspect = 4 / 3;
  console.log('参考剪影：' + ref.width + 'x' + ref.height + '（产品宽高比 ' + ref.aspect.toFixed(3) + '，画布 4:3）');

  const prompt = 'matte white insulated mug with brushed aluminum lid and a side loop handle';

  async function run(label, options, times) {
    const rows = [];
    for (let i = 0; i < times; i++) {
      const started = Date.now();
      try {
        const blob = await render.generate({ provider: 'comfy', source: blobOf(plate), prompt, seed: 100 + i, ...options });
        const buffer = Buffer.from(await blob.arrayBuffer());
        const size = dims(buffer);
        const box = foregroundBox(buffer);
        rows.push({ ok: true, seconds: (Date.now() - started) / 1000, size,
          canvasAspect: size.width / size.height, productAspect: box?.aspect ?? 0 });
        if (i === 0) fs.writeFileSync(path.join(__dirname, `verify-${label}.png`), buffer);
      } catch (error) {
        rows.push({ ok: false, seconds: (Date.now() - started) / 1000, error: String(error.message).slice(0, 160) });
      }
    }
    const ok = rows.filter(row => row.ok);
    console.log(`\n[${label}] 成功率 ${ok.length}/${rows.length}`);
    for (const row of rows) {
      console.log(row.ok
        ? `  ✓ ${row.seconds.toFixed(1)}s  ${row.size.width}x${row.size.height}  画布比例 ${row.canvasAspect.toFixed(3)}  产品比例 ${row.productAspect.toFixed(3)}`
        : `  ✗ ${row.seconds.toFixed(1)}s  ${row.error}`);
    }
    const last = ok.at(-1);
    const canvasError = last ? Math.abs(last.canvasAspect - refAspect) / refAspect : 1;
    const productError = last ? Math.abs(last.productAspect - ref.aspect) / ref.aspect : 1;
    return { rate: ok.length / rows.length, seconds: ok.reduce((sum, row) => sum + row.seconds, 0) / (ok.length || 1), canvasError, productError };
  }

  const result = {};
  result['Qwen 出图 1k'] = await run('qwen-hd', { kind: 'render', endpoint, checkpoint: qwen }, 2);
  result['Qwen 实时 576'] = await run('qwen-live', { kind: 'render', endpoint, checkpoint: qwen, live: true, liveTier: 'balanced' }, 3);
  result['SD1.5 实时 640'] = await run('sd-live', { kind: 'render', endpoint, checkpoint: sd, controlnet, live: true, liveTier: 'balanced', strength: .9 }, 3);

  console.log('\n==== 汇总 ====');
  for (const [label, value] of Object.entries(result)) {
    console.log(`${label}: 成功率 ${(value.rate * 100).toFixed(0)}%，平均 ${value.seconds.toFixed(1)}s，画布比例偏差 ${(value.canvasError * 100).toFixed(1)}%`);
  }
  // 产品包围盒比例会被接触阴影/渐变背景撑宽，只作参考；造型还原以画布比例 + 人工比对为准。
})().catch(error => { console.error(error); process.exit(1); });
