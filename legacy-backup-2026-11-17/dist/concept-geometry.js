(function (root, factory) {
  const geometry = factory();
  if (typeof module === 'object' && module.exports) module.exports = geometry;
  else root.WuyingConceptGeometry = geometry;
})(globalThis, function () {
  'use strict';

  const WIDTH = 800;
  const HEIGHT = 640;
  const grid = 48;
  const minDifference = .14;

  function point(value, minimum, maximum, error) {
    const x = value?.x, y = value?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < minimum || x > maximum || y < minimum || y > maximum) {
      throw new Error(error);
    }
    return { x, y };
  }

  function text(value, max, error) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(error);
    return value.trim();
  }

  function between(a, b, fraction) {
    return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
  }

  function buildShape(points, smooth) {
    return {
      closed: true,
      nodes: points.map((current, index) => {
        const previous = points[(index + points.length - 1) % points.length];
        const next = points[(index + 1) % points.length];
        const node = { point: current, in: between(current, previous, 1 / 3), out: between(current, next, 1 / 3), explicit: true };
        if (!smooth) return node;
        const lengthBefore = Math.hypot(current.x - previous.x, current.y - previous.y);
        const lengthAfter = Math.hypot(next.x - current.x, next.y - current.y);
        const ax = (current.x - previous.x) / lengthBefore, ay = (current.y - previous.y) / lengthBefore;
        const bx = (next.x - current.x) / lengthAfter, by = (next.y - current.y) / lengthAfter;
        if (ax * bx + ay * by < .35) return node;
        const length = .25 * Math.min(lengthBefore, lengthAfter) / Math.hypot(ax + bx, ay + by);
        node.in = { x: current.x - (ax + bx) * length, y: current.y - (ay + by) * length };
        node.out = { x: current.x + (ax + bx) * length, y: current.y + (ay + by) * length };
        return node;
      }),
      pins: { anchors: [], segments: [] }
    };
  }

  // Compare centered outlines on the same scale to ignore translations and uniform resizing.
  function silhouette({ points, bounds }) {
    const scale = Math.max(bounds.width, bounds.height);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const path = points.map(({ x, y }) => ({ x: (x - centerX) / scale, y: (y - centerY) / scale }));
    const mask = new Uint8Array(grid * grid);
    for (let row = 0; row < grid; row++) {
      const y = (row + .5) / grid - .5;
      const crossings = [];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y));
      }
      crossings.sort((a, b) => a - b);
      for (let index = 1; index < crossings.length; index += 2) {
        const start = Math.max(0, Math.ceil((crossings[index - 1] + .5) * grid - .5));
        const end = Math.min(grid, Math.ceil((crossings[index] + .5) * grid - .5));
        mask.fill(1, row * grid + start, row * grid + end);
      }
    }
    return mask;
  }

  function difference(a, b) {
    let union = 0, changed = 0;
    for (let i = 0; i < a.length; i++) {
      union += a[i] || b[i];
      changed += a[i] !== b[i];
    }
    return union ? changed / union : 0;
  }

  function direction(input, index, rules) {
    const label = '第 ' + (index + 1) + ' 个方向';
    const name = text(input?.name, 60, label + '缺少有效的名称。');
    const reason = text(input?.reason, 500, label + '缺少有效的造型说明。');
    const tradeoff = text(input?.tradeoff, 500, label + '缺少有效的取舍说明。');
    if (!Array.isArray(input.anchors) || input.anchors.length < 5 || input.anchors.length > 12) {
      throw new Error(label + '的轮廓需要 5 至 12 个锚点。');
    }
    const anchors = input.anchors.map(anchor => point(anchor, .08, .92, label + '的轮廓坐标超出画板范围。'));
    if (!Array.isArray(input.parts) || input.parts.length > 5) throw new Error(label + '最多可标记 5 个部件。');
    const parts = input.parts.map(part => ({
      label: text(part?.label, 40, label + '有无效的部件名称。'),
      ...point(part, 0, 1, label + '的部件坐标超出画板范围。')
    }));
    const canvasPoints = anchors.map(({ x, y }) => ({ x: x * WIDTH, y: y * HEIGHT }));
    let shape = buildShape(canvasPoints, false);
    let outline = rules.inspect(shape);
    if (!outline.ok) throw new Error(label + '的轮廓无法闭合，可能存在交叉或重叠。');
    if (outline.bounds.width < WIDTH * .12 || outline.bounds.height < HEIGHT * .12) {
      throw new Error(label + '的轮廓比例过细或占据的画板面积过小。');
    }
    const smooth = buildShape(canvasPoints, true);
    const inspected = rules.inspect(smooth);
    if (inspected.ok) { shape = smooth; outline = inspected; }
    return { value: { name, reason, tradeoff, anchors, parts, shape }, mask: silhouette(outline) };
  }

  function validate(response, rules) {
    const items = Array.isArray(response) ? response : response?.directions;
    if (!Array.isArray(items) || items.length !== 3) throw new Error('需要返回三个造型方向。');
    const directions = items.map((item, index) => direction(item, index, rules));
    for (let i = 0; i < directions.length; i++) {
      for (let j = i + 1; j < directions.length; j++) {
        if (difference(directions[i].mask, directions[j].mask) < minDifference) {
          throw new Error('第 ' + (i + 1) + ' 和第 ' + (j + 1) + ' 个方向的造型差异太小，请调整轮廓或比例。');
        }
      }
    }
    return directions.map(({ value }) => value);
  }

  return { WIDTH, HEIGHT, validate };
});
