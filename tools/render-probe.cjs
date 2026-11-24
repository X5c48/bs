// 实时渲染探针：生成一张产品草图（白底黑轮廓），分别用 SD1.5 live 与 Qwen 渲染，
// 记录耗时、成功率和输出尺寸，作为「渲染失败 / 画质 / 造型还原」的量化基线。
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, painter) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y);
      const i = y * (width * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 一个「保温杯」侧视轮廓：上窄下宽的圆角柱 + 杯盖 + 提手，用来检验造型还原。
function shapeHit(x, y, width = 640, height = 480) {
  const cx = width / 2;
  const bx = cx - 80, by = 150, bw = 160, bh = 240, r = 26;
  const inRound = (x >= bx && x <= bx + bw && y >= by && y <= by + bh) &&
    Math.hypot(Math.max(bx + r - x, 0, x - (bx + bw - r)), Math.max(by + r - y, 0, y - (by + bh - r))) <= r;
  if (inRound) return y < by + 40 ? 'lid' : 'body';
  // 提手：杯子右侧一个半圆环（外径 42、内径 30，上半圈）
  const dx = x - (bx + bw), dy = y - (by + 60);
  const d = Math.hypot(dx, dy);
  if (dx >= -2 && dy <= 42 && d >= 30 && d <= 42) return 'handle';
  return null;
}
function sketch(width = 640, height = 480) {
  return png(width, height, (x, y) => {
    const hit = shapeHit(x, y, width, height);
    if (!hit) return [255, 255, 255, 255];
    // 边缘检测：邻域越界即为轮廓线
    const edge = !shapeHit(x + 2, y, width, height) || !shapeHit(x - 2, y, width, height) ||
      !shapeHit(x, y + 2, width, height) || !shapeHit(x, y - 2, width, height);
    if (edge) return [20, 20, 22, 255];
    return [236, 234, 228, 255];
  });
}
// 填充剪影板：整块浅色实体 + 深色边，比细线稿更能锁住造型（Qwen 编辑模型的强参考）
function plate(width = 640, height = 480) {
  return png(width, height, (x, y) => {
    const hit = shapeHit(x, y, width, height);
    if (!hit) return [252, 251, 249, 255];
    const edge = !shapeHit(x + 2, y, width, height) || !shapeHit(x - 2, y, width, height) ||
      !shapeHit(x, y + 2, width, height) || !shapeHit(x, y - 2, width, height);
    if (edge) return [26, 26, 28, 255];
    return hit === 'lid' ? [214, 212, 208, 255] : [232, 229, 222, 255];
  });
}

// 简易 PNG 解码（8 位 RGB/RGBA，支持全部 filter）与裁剪，用于比例验证
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 6, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1; else if (filter === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}
function cropPng(buf, x, y, w, h) {
  const img = decodePng(buf);
  return png(w, h, (px, py) => {
    const i = ((py + y) * img.width + (px + x)) * img.channels;
    const ch = img.channels;
    return ch === 4 ? [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
      : [img.data[i], img.data[i + 1] ?? img.data[i], img.data[i + 2] ?? img.data[i], 255];
  });
}

const blobOf = buffer => new Blob([buffer], { type: 'image/png' });
// Node 没有 createImageBitmap，直接读 PNG 的 IHDR
const sizeOf = async blob => {
  const buf = Buffer.from(await blob.arrayBuffer());
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

(async () => {
  const which = process.argv[2] || 'all';
  const endpoint = process.env.COMFY || 'http://127.0.0.1:8188';
  const comfy = require(path.join(__dirname, '..', 'dist', 'comfy.js'));
  const file = path.join(__dirname, 'render-probe-sketch.png');
  const buffer = sketch();
  fs.writeFileSync(file, buffer);
  const source = blobOf(buffer);
  console.log('sketch:', file, await sizeOf(source));

  const prompt = 'matte white ceramic insulated tumbler with brushed aluminum lid, product design render, ' +
    'studio softbox lighting, soft contact shadow, light gray seamless background, photorealistic, crisp edges';

  if (which === 'all' || which === 'sd') {
    for (const tier of ['speed', 'balanced', 'quality']) {
      for (let i = 0; i < 2; i++) {
        const t0 = Date.now();
        try {
          const { blob } = await comfy.renderLive({
            endpoint, checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
            controlnet: 'control_v11p_sd15_scribble_fp16.safetensors',
            prompt, negative: 'lowres, blurry, watermark, text, duplicate objects, deformed',
            input: 'sketch', quality: 'live', sourceImage: source, strength: .9, seed: 1000 + i,
            latentWidth: tier === 'speed' ? 384 : tier === 'balanced' ? 512 : 640,
            latentHeight: tier === 'speed' ? 288 : tier === 'balanced' ? 384 : 480, tier
          });
          console.log(`sd ${tier} #${i}: OK ${((Date.now() - t0) / 1000).toFixed(1)}s`, await sizeOf(blob));
        } catch (error) {
          console.log(`sd ${tier} #${i}: FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s`, String(error.message).slice(0, 200));
        }
      }
    }
  }

  if (which === 'all' || which === 'qwen') {
    for (const resolution of [640, 768]) {
      const t0 = Date.now();
      try {
        const { blob } = await comfy.renderQwen({
          endpoint, checkpoint: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
          prompt, negative: 'lowres, blurry, watermark, text, deformed, extra objects',
          sourceImage: source, resolution, seed: 7
        });
        const size = await sizeOf(blob);
        fs.writeFileSync(path.join(__dirname, `render-probe-qwen-${resolution}.png`), Buffer.from(await blob.arrayBuffer()));
        console.log(`qwen ${resolution}: OK ${((Date.now() - t0) / 1000).toFixed(1)}s`, size);
      } catch (error) {
        console.log(`qwen ${resolution}: FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s`, String(error.message).slice(0, 300));
      }
    }
  }

  // 参考图接线修复后的画质/还原度对比：4:3 剪影板直接作参考（不补边），看 latent 是否跟随比例
  if (which === 'plate43') {
    const base = plate(640, 480);
    fs.writeFileSync(path.join(__dirname, 'probe-plate-43.png'), base);
    for (const resolution of [640, 768, 1024]) {
      const t0 = Date.now();
      try {
        const { blob } = await comfy.renderQwen({
          endpoint, checkpoint: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
          prompt, negative: 'lowres, blurry, watermark, text, deformed, extra objects',
          sourceImage: blobOf(base), resolution, seed: 7
        });
        const size = await sizeOf(blob);
        fs.writeFileSync(path.join(__dirname, `probe-plate-43-${resolution}.png`), Buffer.from(await blob.arrayBuffer()));
        console.log(`plate43 ${resolution}: OK ${((Date.now() - t0) / 1000).toFixed(1)}s`, size);
      } catch (error) {
        console.log(`plate43 ${resolution}: FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s`, String(error.message).slice(0, 200));
      }
    }
  }
  if (which === 'qwenpad' || which === 'qwenplate') {
    const w = 640, h = 480, side = 768;
    const base = which === 'qwenplate' ? plate(w, h) : buffer;
    const img = decodePng(base);
    const padded = png(side, side, (x, y) => {
      const ox = x - (side - w) / 2, oy = y - (side - h) / 2;
      if (ox < 0 || oy < 0 || ox >= w || oy >= h) return [255, 255, 255, 255];
      const i = (oy * img.width + ox) * img.channels;
      return [img.data[i], img.data[i + 1], img.data[i + 2], 255];
    });
    fs.writeFileSync(path.join(__dirname, `render-probe-${which}-input.png`), padded);
    const t0 = Date.now();
    const { blob } = await comfy.renderQwen({
      endpoint, checkpoint: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
      prompt, negative: 'lowres, blurry, watermark, text, deformed, extra objects',
      sourceImage: blobOf(padded), resolution: side, seed: 7
    });
    const buf = Buffer.from(await blob.arrayBuffer());
    const got = await sizeOf(blob);
    console.log(`${which}: OK ${((Date.now() - t0) / 1000).toFixed(1)}s`, got);
    const cropH = Math.round(got.width * h / w / 2) * 2;
    const top = Math.round((got.height - cropH) / 2);
    fs.writeFileSync(path.join(__dirname, `render-probe-${which}-crop.png`), cropPng(buf, 0, top, got.width, cropH));
    console.log('cropped ->', got.width + 'x' + cropH);
  }
})().catch(error => { console.error(error); process.exit(1); });
