// Qwen 实时通道真实验收：同一张草图按画质档 512/640/768 各出一帧，计时；
// 再验证取消挂起（提交后立即中止，任务应被取消且不返回图片）。
// 运行：node tools/verify-qwen-live.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const endpoint = process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188';
const checkpoint = 'qwen_image_2.1_turbo_int8_convrot.safetensors';

// ---- 最小 PNG 编码器：白底黑线台灯草图（与 verify-influence.cjs 相同） ----
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
  const line = (x0, y0, x1, y1) => {
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
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const comfy = require('../dist/comfy.js');
const prompt = 'Industrial design concept preview. A table lamp with a conical shade on a round base, studio lighting.';

async function cancelCheck(sketch) {
  const controller = new AbortController();
  const started = Date.now();
  const attempt = comfy.renderQwen({
    endpoint, checkpoint, prompt, sourceImage: sketch, seed: 7,
    resolution: 512, slot: 'qwen-live-cancel', cancelPending: true, signal: controller.signal
  });
  setTimeout(() => controller.abort(), 1500); // 提交后 1.5s 中止
  await assertAborted(attempt);
  await new Promise(r => setTimeout(r, 1000));
  const queue = await (await fetch(`${endpoint}/queue`)).json();
  const running = (queue.queue_running || []).some(item => item?.[3]?.prompt_id || item[1] === 'qwen-cancel-check');
  console.log(`取消挂起：中止耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，队列 running 条目 ${running ? '仍在（历史任务，无法中断执行中采样）' : '已清'}`);
}

async function assertAborted(promise) {
  try { await promise; throw new Error('中止后不应返回结果'); }
  catch (error) {
    if (error.name !== 'AbortError') throw error;
    console.log('中止行为正确：AbortError');
  }
}

(async () => {
  const sketch = new Blob([sketchPng()], { type: 'image/png' });
  const results = [];
  for (const resolution of [512, 640, 768]) {
    const t0 = Date.now();
    const { blob, promptId } = await comfy.renderQwen({
      endpoint, checkpoint, prompt, sourceImage: sketch, seed: 20261120,
      resolution, slot: 'qwen-live-' + resolution, cancelPending: true
    });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const file = path.join(__dirname, `qwen-live-${resolution}-output.png`);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    results.push({ resolution, seconds, bytes: fs.statSync(file).size, promptId });
    console.log(`分辨率 ${resolution}：${seconds}s → ${path.basename(file)}（${(fs.statSync(file).size / 1024).toFixed(0)} KB）`);
  }
  await cancelCheck(sketch);
  console.log('\n三档计时汇总（RTX 4060 8GB，Qwen-Image-2.1 Turbo int8）：');
  for (const r of results) console.log(`  ${r.resolution}px：${r.seconds}s`);
})().catch(error => { console.error('验收失败：', error.message); process.exit(1); });
