(() => {
  'use strict';

  // 模块 3：把一张产品图膨胀成闭合网格（纯计算，不依赖 Three.js，便于单测）。
  // 步骤：抠主体（透明度或与边框底色的色差）→ 最大连通域 → 填洞 → 网格化 → 距离场 → 正背两面在轮廓处 z=0 相接。

  // 主体掩膜。有明显透明区域时按 alpha；否则取四边像素的中位色作底色，色差大于阈值的为主体。
  function subjectMask(data, width, height, { threshold = 40 } = {}) {
    const n = width * height, mask = new Uint8Array(n);
    let transparent = 0;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) transparent++;
    if (transparent > n * .02) {
      for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
      return { mask, mode:'alpha' };
    }
    const border = [[], [], []];
    const take = i => { for (let c = 0; c < 3; c++) border[c].push(data[i * 4 + c]); };
    for (let x = 0; x < width; x++) { take(x); take((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { take(y * width); take(y * width + width - 1); }
    const bg = border.map(list => list.sort((a, b) => a - b)[list.length >> 1]);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(data[i * 4] - bg[0]) + Math.abs(data[i * 4 + 1] - bg[1]) + Math.abs(data[i * 4 + 2] - bg[2]);
      mask[i] = d > threshold ? 1 : 0;
    }
    return { mask, mode:'background', background:bg };
  }

  // 4 邻域最大连通域，再把被主体围住的背景（从边框不可达的部分）填上。
  function largestComponent(mask, width, height) {
    const n = width * height, label = new Int32Array(n), stack = new Int32Array(n);
    let best = 0, bestSize = 0, next = 0;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || label[start]) continue;
      next++;
      let top = 0, size = 0;
      stack[top++] = start; label[start] = next;
      while (top) {
        const i = stack[--top], x = i % width;
        size++;
        const near = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
        for (const j of near) if (j >= 0 && j < n && mask[j] && !label[j]) { label[j] = next; stack[top++] = j; }
      }
      if (size > bestSize) { bestSize = size; best = next; }
    }
    const out = new Uint8Array(n);
    if (!best) return { mask:out, size:0 };
    for (let i = 0; i < n; i++) out[i] = label[i] === best ? 1 : 0;
    // 填洞
    const outside = new Uint8Array(n);
    let top = 0;
    const seed = i => { if (!out[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
    while (top) {
      const i = stack[--top], x = i % width;
      if (x > 0) seed(i - 1);
      if (x < width - 1) seed(i + 1);
      if (i >= width) seed(i - width);
      if (i < n - width) seed(i + width);
    }
    let size = 0;
    for (let i = 0; i < n; i++) { if (!outside[i]) out[i] = 1; size += out[i]; }
    return { mask:out, size };
  }

  // 缩到网格：长边 grid 格，格内过半像素为主体则该格为主体。
  function toGrid(mask, width, height, grid) {
    const scale = Math.max(width, height) / grid;
    const gw = Math.max(2, Math.round(width / scale)), gh = Math.max(2, Math.round(height / scale));
    const cells = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * width / gw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * width / gw));
      const y0 = Math.floor(gy * height / gh), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * height / gh));
      let on = 0, all = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { on += mask[y * width + x]; all++; }
      cells[gy * gw + gx] = on * 2 >= all ? 1 : 0;
    }
    return { cells, gw, gh };
  }

  // 两遍 chamfer（3-4）距离：每格到最近背景格的距离（格单位）。
  function distanceField(cells, gw, gh) {
    const INF = 1e9, d = new Float32Array(gw * gh);
    const at = (x, y) => x < 0 || y < 0 || x >= gw || y >= gh ? 0 : d[y * gw + x];
    for (let i = 0; i < d.length; i++) d[i] = cells[i] ? INF : 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
  }

  // 生成网格。世界坐标：长边为 1，中心在原点，y 向上。thickness 0–1：1 时截面接近圆。
  function build(data, width, height, { grid = 128, thickness = .5, threshold } = {}) {
    if (!(width > 1 && height > 1) || data.length < width * height * 4) throw new Error('图像数据无效。');
    const found = subjectMask(data, width, height, { threshold });
    const { mask, size } = largestComponent(found.mask, width, height);
    if (size < width * height * .005) throw new Error('没有找到主体：画面里需要一个与背景区分明显的产品。');
    if (size > width * height * .97) throw new Error('主体铺满了整张图，无法区分背景。请先去除背景，或换一张白底图。');
    const { cells, gw, gh } = toGrid(mask, width, height, grid);
    // 去掉只靠对角相连的「捏点」，保证每条网格边至多被两格共用，网格才是闭合流形。
    for (let changed = true; changed;) {
      changed = false;
      for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) {
        const i = y * gw + x, a = cells[i], b = cells[i + 1], c = cells[i + gw], d = cells[i + gw + 1];
        if (a && d && !b && !c) { cells[i + 1] = 1; changed = true; }
        else if (b && c && !a && !d) { cells[i] = 1; changed = true; }
      }
    }
    const dist = distanceField(cells, gw, gh);
    let dmax = 0;
    for (const v of dist) dmax = Math.max(dmax, v);
    if (dmax < 1) throw new Error('主体太细，无法生成体块。');
    const unit = 1 / Math.max(gw, gh);
    const depth = clamp01(thickness) * dmax * unit;
    const inside = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh && cells[y * gw + x] === 1;
    // 角点高度：四个相邻格都在主体内时取其距离均值，否则在轮廓上（z=0）。
    const cw = gw + 1;
    const height0 = i => {
      const x = i % cw, y = (i / cw) | 0;
      let sum = 0;
      for (const [cx, cy] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]]) {
        if (!inside(cx, cy)) return 0;
        sum += dist[cy * gw + cx];
      }
      return sum / 4;
    };
    const tables = { 1:new Int32Array(cw * (gh + 1)).fill(-1), '-1':new Int32Array(cw * (gh + 1)).fill(-1) };
    const positions = [], uvs = [], indices = [];
    const vertex = (i, side) => {
      const table = tables[side];
      if (table[i] >= 0) return table[i];
      const x = i % cw, y = (i / cw) | 0, n = Math.min(1, height0(i) / dmax);
      const id = positions.length / 3;
      positions.push((x - gw / 2) * unit, (gh / 2 - y) * unit, side * depth * Math.sqrt(n * (2 - n)));
      uvs.push(x / gw, 1 - y / gh);
      return table[i] = id;
    };
    // 轮廓侧壁：正面边 (p,q) 与背面同一条边连成四边形；轮廓处两面 z 都为 0，侧壁高度为 0，正背面在此相接。
    const wall = (p, q) => {
      const fp = vertex(p, 1), fq = vertex(q, 1), bp = vertex(p, -1), bq = vertex(q, -1);
      indices.push(fp, bp, fq, fq, bp, bq);
    };
    let quads = 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      if (!inside(gx, gy)) continue;
      quads++;
      const a = gy * cw + gx, b = a + 1, c = a + cw, e = c + 1;
      const fa = vertex(a, 1), fb = vertex(b, 1), fc = vertex(c, 1), fe = vertex(e, 1);
      indices.push(fa, fc, fb, fb, fc, fe);
      const ba = vertex(a, -1), bb = vertex(b, -1), bc = vertex(c, -1), be = vertex(e, -1);
      indices.push(ba, bb, bc, bb, be, bc);
      // 方向与该边在正面三角形里的走向相反，侧壁法线朝外。
      if (!inside(gx, gy - 1)) wall(b, a);
      if (!inside(gx + 1, gy)) wall(e, b);
      if (!inside(gx, gy + 1)) wall(c, e);
      if (!inside(gx - 1, gy)) wall(a, c);
    }
    return {
      positions:new Float32Array(positions), uvs:new Float32Array(uvs), indices:new Uint32Array(indices),
      size:{ width:gw * unit, height:gh * unit, depth:depth * 2 },
      stats:{ mode:found.mode, cells:quads, grid:gw + '×' + gh, coverage:size / (width * height), vertices:positions.length / 3, triangles:indices.length / 3 }
    };
  }

  const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : .5));

  // 闭合检查：每条无向边恰好被两个三角形共用。
  function isClosed(indices) {
    const edges = new Map();
    for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + (k + 1) % 3], key = a < b ? a + ',' + b : b + ',' + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
    for (const count of edges.values()) if (count !== 2) return false;
    return edges.size > 0;
  }

  window.WuyingInflate = { build, isClosed, subjectMask, largestComponent };
})();
