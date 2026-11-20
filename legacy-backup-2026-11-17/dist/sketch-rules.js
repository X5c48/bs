(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.WuyingSketchRules = rules;
})(globalThis, function () {
  'use strict';

  const profiles = {
    rounded: [
      [203, 176, 177, 187, 246, 157], [335, 134, 287, 137, 393, 128],
      [465, 167, 421, 150, 509, 186], [528, 251, 531, 212, 526, 285],
      [485, 316, 514, 303, 444, 331], [335, 338, 395, 339, 272, 338],
      [199, 317, 244, 330, 160, 306], [151, 248, 149, 281, 150, 216]
    ],
    rectilinear: [
      [204, 151, 176, 151, 285, 151], [465, 151, 379, 151, 498, 151],
      [519, 200, 519, 171, 519, 226], [519, 283, 519, 257, 519, 311],
      [466, 330, 493, 330, 389, 330], [204, 330, 279, 330, 175, 330],
      [153, 284, 153, 308, 153, 257], [153, 199, 153, 226, 153, 171]
    ],
    tapered: [
      [202, 164, 176, 171, 264, 152], [366, 134, 311, 140, 413, 127],
      [480, 146, 445, 132, 512, 158], [536, 210, 533, 181, 539, 239],
      [503, 285, 524, 261, 477, 308], [360, 329, 417, 317, 301, 340],
      [206, 328, 256, 339, 167, 321], [152, 252, 149, 285, 150, 217]
    ]
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const point = (x, y) => ({ x, y });
  const midpoint = (a, b) => point((a.x + b.x) / 2, (a.y + b.y) / 2);
  const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const coordinate = p => p.x.toFixed(2) + ' ' + p.y.toFixed(2);
  const cubicCommand = (a, b) => ' C ' + coordinate(a.out) + ' ' + coordinate(b.in) + ' ' + coordinate(b.point);

  function createBase(profile = 'rounded', withPin = false) {
    const data = Object.hasOwn(profiles, profile) ? profiles[profile] : profiles.rounded;
    return {
      closed: true,
      nodes: data.map(([x, y, inX, inY, outX, outY]) => ({
        point: point(x, y), in: point(inX, inY), out: point(outX, outY), explicit: true
      })),
      pins: { anchors: [], segments: withPin ? [6] : [] }
    };
  }

  function pinSpec(sketch) {
    const count = sketch.nodes.length;
    const valid = (indices, end) => Array.isArray(indices)
      ? [...new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < end))].sort((a, b) => a - b)
      : [];
    return {
      anchors: valid(sketch.pins?.anchors, count),
      segments: valid(sketch.pins?.segments, sketch.closed ? count : count - 1)
    };
  }

  function lockedIndices(sketch) {
    const pins = pinSpec(sketch);
    const locked = new Set(pins.anchors);
    for (const i of pins.segments) {
      locked.add(i);
      locked.add((i + 1) % sketch.nodes.length);
    }
    return locked;
  }

  function segmentPath(sketch, index) {
    const start = sketch.nodes[index];
    const next = sketch.nodes[index + 1] || (sketch.closed ? sketch.nodes[0] : null);
    return start && next ? 'M ' + coordinate(start.point) + cubicCommand(start, next) : '';
  }

  function pathData(sketch) {
    const [first, ...rest] = sketch.nodes;
    if (!first) return '';
    let path = 'M ' + coordinate(first.point);
    let previous = first;
    for (const next of rest) {
      path += cubicCommand(previous, next);
      previous = next;
    }
    return path + (sketch.closed && rest.length > 1 ? cubicCommand(previous, first) + ' Z' : '');
  }

  function bounds(points) {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  function controlBounds(sketch) {
    return bounds(sketch.nodes.flatMap(node => [node.point, node.in, node.out]));
  }

  function distanceToEdgeSquared(p, a, b) {
    const length = distanceSquared(a, b);
    if (!length) return distanceSquared(p, a);
    const t = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length, 0, 1);
    return distanceSquared(p, point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }

  function flatten(a, b, c, d, threshold, output, depth = 0) {
    if (depth >= 9 || Math.max(distanceToEdgeSquared(b, a, d), distanceToEdgeSquared(c, a, d)) <= threshold) {
      output.push(d);
      return;
    }
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const left = midpoint(ab, bc), right = midpoint(bc, cd);
    const middle = midpoint(left, right);
    flatten(a, ab, left, middle, threshold, output, depth + 1);
    flatten(middle, right, cd, d, threshold, output, depth + 1);
  }

  function hasCrossing(points, scale) {
    const tolerance = scale * 1e-8;
    const sign = value => value > tolerance * scale ? 1 : value < -tolerance * scale ? -1 : 0;
    const overlaps = (a, b, c, d) => Math.max(a, b) + tolerance >= Math.min(c, d) &&
      Math.max(c, d) + tolerance >= Math.min(a, b);
    const count = points.length - 1;
    const edges = points.slice(0, count).map((a, i) => {
      const b = points[i + 1];
      return { a, b, i, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x) };
    });
    for (let i = 0; i < count; i++) {
      const a = points[i], b = points[i + 1], c = points[(i + 2) % count];
      if (!sign(cross(a, b, c)) && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < -(tolerance ** 2)) return true;
    }
    edges.sort((left, right) => left.minX - right.minX);
    for (let i = 0; i < count; i++) {
      const { a, b, i: index, maxX } = edges[i];
      for (let j = i + 1; j < count && edges[j].minX <= maxX + tolerance; j++) {
        const { a: c, b: d, i: other } = edges[j];
        const gap = Math.abs(other - index);
        if (gap === 1 || gap === count - 1 || !overlaps(a.y, b.y, c.y, d.y)) continue;
        if (sign(cross(a, b, c)) * sign(cross(a, b, d)) <= 0 &&
            sign(cross(c, d, a)) * sign(cross(c, d, b)) <= 0) return true;
      }
    }
    return false;
  }

  function inspect(sketch) {
    if (!sketch?.closed || !Array.isArray(sketch.nodes) || sketch.nodes.length < 3) return { ok: false, reason: 'open' };
    const nodes = sketch.nodes;
    if (nodes.length > 100 || !nodes.every(node => ['point', 'in', 'out'].every(key => {
      const p = node?.[key];
      return Number.isFinite(p?.x) && Number.isFinite(p?.y) && Math.abs(p.x) <= 1e6 && Math.abs(p.y) <= 1e6;
    }))) return { ok: false, reason: 'invalid' };
    const extent = controlBounds(sketch);
    const scale = Math.hypot(extent.width, extent.height);
    if (scale < 1e-4) return { ok: false, reason: 'degenerate' };
    const start = nodes[0].point;
    const points = [start];
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], b = nodes[(i + 1) % nodes.length];
      if (distanceSquared(a.point, b.point) <= (scale * 1e-6) ** 2) return { ok: false, reason: 'degenerate' };
      flatten(a.point, a.out, b.in, b.point, (scale / 1600) ** 2, points);
      if (points.length > 2400) return { ok: false, reason: 'complex' };
    }
    const measured = bounds(points);
    const plane = points.some(p => Math.abs(cross(start, nodes[1].point, p)) > scale * scale * 1e-8);
    if (!plane || Math.min(measured.width, measured.height) <= scale * .01) return { ok: false, reason: 'degenerate' };
    if (hasCrossing(points, scale)) return { ok: false, reason: 'crossing' };
    const area = points.slice(1).reduce((total, end, i) => total + cross(start, points[i], end), 0) / 2;
    if (Math.abs(area) < measured.width * measured.height * .035) return { ok: false, reason: 'degenerate' };
    return { ok: true, points, bounds: measured, area, scale };
  }

  function visiblyDifferent(a, b, threshold) {
    const outside = (from, to) => from.some(p => {
      for (let i = 1; i < to.length; i++) {
        if (distanceToEdgeSquared(p, to[i - 1], to[i]) <= threshold) return false;
      }
      return true;
    });
    return outside(a, b) || outside(b, a);
  }

  function generate(source, options = {}) {
    const base = inspect(source);
    const empty = reason => ({ candidates: [], reason });
    if (!base.ok) return empty(base.reason);
    const locked = lockedIndices(source);
    if (locked.size === source.nodes.length) return empty('locked');
    const width = clamp(Number(options.width) || 0, 0, 32) / 100;
    const bend = clamp(Number(options.bend) || 0, 0, 32) / 100;
    if (!width && !bend) return empty('unchanged');
    const direction = options.direction === 'narrow' || options.direction === 'wide' ? options.direction : 'both';
    const weights = direction === 'both'
      ? [[-.62, -.5], [.78, .6], [-1, .86], [1, -.9], [-.36, .42], [.45, -.4]]
      : [[.42, -.45], [.72, .48], [1, .86], [.27, -.9], [.58, .65], [.9, -.7]];
    const centerX = base.bounds.x + base.bounds.width / 2;
    const minimumChange = (base.scale * .0025) ** 2;
    const candidates = [];
    const tested = [];
    let rejected = 0;
    for (const [horizontal, arc] of weights) {
      const horizontalFactor = 1 + width * horizontal * (direction === 'narrow' ? -1 : 1);
      const bendFactor = 1 + bend * arc;
      const nodes = source.nodes.map((node, index) => {
        if (locked.has(index)) return { ...node, point: { ...node.point }, in: { ...node.in }, out: { ...node.out } };
        const anchor = point(centerX + (node.point.x - centerX) * horizontalFactor, node.point.y);
        const handle = p => point(
          anchor.x + (p.x - node.point.x) * horizontalFactor * bendFactor,
          anchor.y + (p.y - node.point.y) * bendFactor
        );
        return { ...node, point: anchor, in: handle(node.in), out: handle(node.out) };
      });
      const candidate = { closed: true, nodes, pins: pinSpec(source) };
      const result = inspect(candidate);
      if (!result.ok || Math.sign(result.area) !== Math.sign(base.area)) {
        rejected++;
        continue;
      }
      const widthChange = (result.bounds.width / base.bounds.width - 1) * 100;
      if (width && ((direction === 'narrow' && widthChange >= -.05) || (direction === 'wide' && widthChange <= .05))) continue;
      if (!visiblyDifferent(base.points, result.points, minimumChange) ||
          tested.some(other => !visiblyDifferent(other, result.points, minimumChange))) continue;
      tested.push(result.points);
      candidates.push({ ...candidate, bounds: result.bounds, widthChange, bendChange: (bendFactor - 1) * 100 });
      if (candidates.length === 3) break;
    }
    return { candidates, reason: candidates.length ? '' : rejected ? 'candidate' : 'unchanged', rejected };
  }

  function simplifyStroke(points, threshold) {
    const kept = new Set([0, points.length - 1]);
    const pending = [[0, points.length - 1]];
    while (pending.length) {
      const [first, last] = pending.pop();
      let furthest = -1, distance = threshold;
      for (let i = first + 1; i < last; i++) {
        const error = distanceToEdgeSquared(points[i], points[first], points[last]);
        if (error > distance) { furthest = i; distance = error; }
      }
      if (furthest >= 0) {
        kept.add(furthest);
        pending.push([first, furthest], [furthest, last]);
      }
    }
    return points.filter((_, index) => kept.has(index));
  }

  function redraw(source, index, stroke, snapDistance) {
    const fail = reason => ({ reason, candidate: null });
    const base = inspect(source);
    if (!base.ok) return fail(base.reason);
    const count = source.nodes.length;
    if (!Number.isInteger(index) || index < 0 || index >= count) return fail('invalid');
    const pins = pinSpec(source);
    if (pins.segments.includes(index)) return fail('pinned');
    if (!Array.isArray(stroke) || stroke.length < 3) return fail('short');
    if (stroke.length > 1024 || stroke.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) return fail('invalid');

    const nextIndex = (index + 1) % count;
    const start = source.nodes[index].point, end = source.nodes[nextIndex].point;
    const chord = Math.sqrt(distanceSquared(start, end));
    const snap = Math.min(Math.max(1, Number(snapDistance) || 16), chord * .42);
    const errors = (first, last) => [distanceSquared(first, start), distanceSquared(last, end)];
    const forward = errors(stroke[0], stroke.at(-1)), backward = errors(stroke.at(-1), stroke[0]);
    const points = Math.max(...backward) < Math.max(...forward) ? [...stroke].reverse() : stroke;
    if (Math.min(Math.max(...forward), Math.max(...backward)) > snap ** 2) return fail('endpoint');

    const minGap = Math.max(chord * .018, .08);
    const samples = [start];
    for (const p of points.slice(1, -1)) {
      if (distanceSquared(p, samples.at(-1)) >= minGap ** 2 &&
          distanceSquared(p, end) >= minGap ** 2) samples.push(p);
    }
    if (samples.length < 2) return fail('short');
    samples.push(end);
    let tolerance = Math.max(chord * .016, snap / 9);
    let fitted = simplifyStroke(samples, tolerance ** 2);
    const maxInner = Math.min(10, 100 - count);
    if (maxInner < 1) return fail('complex');
    while (fitted.length > maxInner + 2) {
      tolerance *= 1.5;
      fitted = simplifyStroke(samples, tolerance ** 2);
    }
    if (fitted.length < 3) fitted = [start, samples[Math.floor(samples.length / 2)], end];

    const locked = lockedIndices(source);
    const original = source.nodes.map(node => ({
      ...node, point: { ...node.point }, in: { ...node.in }, out: { ...node.out }
    }));
    const toward = (a, b) => point(a.x + (b.x - a.x) * .3, a.y + (b.y - a.y) * .3);
    if (!locked.has(index)) original[index].out = toward(start, fitted[1]);
    if (!locked.has(nextIndex)) original[nextIndex].in = toward(end, fitted.at(-2));
    const inserted = fitted.slice(1, -1).map((p, i) => {
      const a = fitted[i], b = fitted[i + 2];
      const span = Math.sqrt(distanceSquared(a, b)) || 1;
      const dx = (b.x - a.x) / span, dy = (b.y - a.y) / span;
      const into = Math.sqrt(distanceSquared(p, a)) * .26;
      const out = Math.sqrt(distanceSquared(p, b)) * .26;
      return { point: { ...p }, in: point(p.x - dx * into, p.y - dy * into),
        out: point(p.x + dx * out, p.y + dy * out), explicit: true };
    });
    original.splice(index + 1, 0, ...inserted);
    const remap = i => i > index ? i + inserted.length : i;
    const candidate = { closed: true, nodes: original,
      pins: { anchors: pins.anchors.map(remap), segments: pins.segments.map(remap) } };
    const result = inspect(candidate);
    if (!result.ok) return fail(result.reason);
    if (Math.sign(result.area) !== Math.sign(base.area)) return fail('crossing');
    if (!visiblyDifferent(base.points, result.points, (base.scale * .0025) ** 2)) return fail('unchanged');
    return { reason: '', candidate: { ...candidate, bounds: result.bounds } };
  }

  function sketchKey(sketch) {
    return JSON.stringify([sketch.id, sketch.closed, pinSpec(sketch),
      sketch.nodes.map(node => [node.point.x, node.point.y, node.in.x, node.in.y, node.out.x, node.out.y])]);
  }

  return { createBase, pinSpec, lockedIndices, segmentPath, pathData, controlBounds, inspect, generate, redraw, sketchKey };
});
