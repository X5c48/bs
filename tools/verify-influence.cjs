// 草图影响力（方案 §7.3）真实验收：同一张草图用影响力 0.2 / 0.8 / 1.5 各出一张，
// 从 ComfyUI history 读回实际提交的 strength 与 end_percent，输出 PNG 供肉眼对比。
// 运行：node tools/verify-influence.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const endpoint = process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188';
const checkpoint = 'v1-5-pruned-emaonly-fp16.safetensors';
const controlnet = 'control_v11p_sd15_scribble_fp16.safetensors';

// ---- 最小 PNG 编码器：白底 + 黑线草图（台灯线稿） ----
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function sketchPng(width = 512, height = 640) {
  const px = Buffer.alloc(width * height * 3, 255);
  const line = (x0, y0, x1, y1) => { // Bresenham
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const px_ = x + ox, py = y + oy;
        if (px_ >= 0 && px_ < width && py >= 0 && py < height) {
          const i = (py * width + px_) * 3; px[i] = px[i + 1] = px[i + 2] = 20;
        }
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  };
  // 灯罩梯形、灯杆、底座、开关线
  line(176, 128, 336, 128); line(176, 128, 216, 288); line(336, 128, 296, 288); line(216, 288, 296, 288);
  line(256, 288, 256, 520);
  line(160, 520, 352, 520); line(160, 520, 176, 568); line(352, 520, 336, 568); line(176, 568, 336, 568);
  line(296, 380, 376, 380); line(376, 380, 376, 430);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    px.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 读回工作流的 influenceMapping ----
const window = {};
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/workspace-render.js'), 'utf8'),
  vm.createContext({ window, Blob, URL, Response }));
const { influenceMapping } = window.WuyingComfyRenderCheck || window.WuyingWorkspaceRender;
const comfy = require('../dist/comfy.js');

async function submittedParams(promptId) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${endpoint}/history/${promptId}`);
    const data = await res.json();
    const entry = data[promptId];
    if (entry) {
      // 新版 ComfyUI 的 history.prompt 是 [编号, prompt_id, 工作流, extra] 数组。
      const graph = Array.isArray(entry.prompt) ? entry.prompt[2] : entry.prompt;
      const apply = Object.values(graph ?? {}).find(n => n?.class_type === 'ControlNetApplyAdvanced');
      if (!apply) throw new Error('工作流里没有 ControlNetApplyAdvanced：' + JSON.stringify(graph).slice(0, 200));
      return { strength: apply.inputs.strength, end_percent: apply.inputs.end_percent, status: entry.status?.status_str };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('history 里找不到任务 ' + promptId);
}

(async () => {
  const sketch = new Blob([sketchPng()], { type: 'image/png' });
  const prompt = 'Industrial design concept preview. A table lamp with a conical shade on a round base.';
  const results = [];
  for (const influence of [0.2, 0.8, 1.5]) {
    const mapping = influenceMapping(influence);
    console.log(`影响力 ${influence} → strength=${mapping.strength} end_percent=${mapping.endPercent}`);
    const { blob, promptId } = await comfy.renderLive({
      endpoint, input: 'sketch', quality: 'final', checkpoint, controlnet, prompt,
      sourceImage: sketch, strength: mapping.strength, endPercent: mapping.endPercent,
      seed: 20261120, slot: 'influence-verify-' + String(influence).replace('.', '_'),
      onStatus: () => {}
    });
    const submitted = await submittedParams(promptId);
    const file = path.join(__dirname, `influence-${String(influence).replace('.', '_')}-output.png`);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    results.push({ influence, submitted, file, bytes: fs.statSync(file).size });
    console.log(`  提交值: strength=${submitted.strength} end_percent=${submitted.end_percent} status=${submitted.status} → ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
    if (Math.abs(submitted.strength - mapping.strength) > 1e-9 || Math.abs(submitted.end_percent - mapping.endPercent) > 1e-9) {
      throw new Error('ComfyUI 实际收到的参数与预期不一致！');
    }
  }
  console.log('\n全部通过：三档影响力提交参数一致，输出已保存。');
  console.log(JSON.stringify(results.map(r => ({ influence: r.influence, ...r.submitted })), null, 2));
})().catch(error => { console.error('验收失败：', error.message); process.exit(1); });
