const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBase, generate, inspect, lockedIndices, segmentPath, redraw } = require('./dist/sketch-rules.js');

const options = { direction: 'both', width: 16, bend: 14 };
const fixture = () => createBase('rounded', true);

test('base profiles provide different, editable, valid closed outlines', () => {
  const profiles = ['rounded', 'rectilinear', 'tapered'].map(profile => createBase(profile));
  for (const profile of profiles) {
    assert.equal(profile.closed, true);
    assert.equal(inspect(profile).ok, true);
    assert.equal(lockedIndices(profile).size, 0);
  }
  assert.equal(new Set(profiles.map(profile => JSON.stringify(profile.nodes))).size, profiles.length);
});

test('generates multiple deterministic edits while preserving both handles of every locked node', () => {
  const source = fixture();
  source.pins.anchors.push(0);
  const snapshot = structuredClone(source);
  const first = generate(source, options);
  assert.deepEqual(first, generate(source, options));
  assert.deepEqual(source, snapshot);
  assert.equal(first.candidates.length, 3);
  assert.ok(first.candidates.some(result => result.widthChange < 0));
  assert.ok(first.candidates.some(result => result.widthChange > 0));
  for (const result of first.candidates) {
    assert.equal(inspect(result).ok, true);
    assert.notDeepEqual(result.nodes, source.nodes);
    assert.deepEqual(result.pins, source.pins);
    for (const index of lockedIndices(source)) assert.deepEqual(result.nodes[index], source.nodes[index]);
    for (const index of source.pins.segments) assert.equal(segmentPath(result, index), segmentPath(source, index));
  }
});

test('obeys the selected horizontal direction and skips unchanged results', () => {
  const source = fixture();
  const narrow = generate(source, { direction: 'narrow', width: 18, bend: 0 });
  assert.ok(narrow.candidates.length >= 2);
  assert.ok(narrow.candidates.every(result => result.widthChange < 0));
  const wide = generate(source, { direction: 'wide', width: 18, bend: 0 });
  assert.ok(wide.candidates.every(result => result.widthChange > 0));
  assert.ok(wide.candidates.length >= 2);
  assert.deepEqual(generate(source, { width: 0, bend: 0 }).candidates, []);
  assert.equal(generate(source, { width: 0, bend: 0 }).reason, 'unchanged');
});

test('reports open, fully locked, crossing, and degenerate outlines before generating', () => {
  const source = fixture();
  const open = { ...source, closed: false };
  const locked = { ...source, pins: { anchors: [], segments: source.nodes.map((_, i) => i) } };
  const polygon = points => ({
    closed: true,
    nodes: points.map(([x, y]) => ({ point: { x, y }, in: { x, y }, out: { x, y } }))
  });
  const crossing = polygon([[0, 0], [4, 5], [0, 4], [6, 0]]);
  const retraced = polygon([[0, 0], [5, 0], [3, 0], [4, 5], [0, 4]]);
  const degenerate = polygon([[0, 0], [1, 1], [2, 2]]);
  assert.equal(generate(open, options).reason, 'open');
  assert.equal(generate(locked, options).reason, 'locked');
  assert.equal(generate(crossing, options).reason, 'crossing');
  assert.equal(generate(retraced, options).reason, 'crossing');
  assert.equal(generate(degenerate, options).reason, 'degenerate');
});

test('fits a hand-drawn section as editable cubics and remaps the untouched locked section', () => {
  const source = fixture();
  source.pins.anchors = [0, 1, 4];
  const stroke = [[204, 174], [236, 148], [263, 126], [290, 118], [321, 122], [335, 134]]
    .map(([x, y]) => ({ x, y }));
  const snapshot = structuredClone(source);
  const result = redraw(source, 0, stroke, 18);
  assert.equal(result.reason, '');
  assert.ok(result.candidate.nodes.length > source.nodes.length);
  assert.equal(inspect(result.candidate).ok, true);
  assert.deepEqual(source, snapshot);
  const added = result.candidate.nodes.length - source.nodes.length;
  assert.equal(segmentPath(result.candidate, 6 + added), segmentPath(source, 6));
  assert.equal(segmentPath(result.candidate, 1 + added), segmentPath(source, 1));
  assert.equal(segmentPath(result.candidate, 7 + added), segmentPath(source, 7));
  assert.deepEqual(result.candidate.nodes[0], source.nodes[0]);
  assert.deepEqual(result.candidate.nodes[1 + added], source.nodes[1]);
  assert.deepEqual(result.candidate.pins.anchors, [0, 1 + added, 4 + added]);
  assert.deepEqual(redraw(source, 0, [...stroke].reverse(), 18), result);
});

test('hand redraw handles the closing segment, rejects invalid strokes and respects fixed segments', () => {
  const source = fixture();
  const stroke = [[151, 248], [148, 216], [164, 182], [187, 169], [203, 176]]
    .map(([x, y]) => ({ x, y }));
  const valid = redraw(source, 7, stroke, 18);
  assert.equal(valid.reason, '');
  assert.equal(segmentPath(valid.candidate, 6), segmentPath(source, 6));
  assert.equal(segmentPath(valid.candidate, 0), segmentPath(source, 0));
  assert.equal(redraw(source, 6, stroke, 18).reason, 'pinned');
  assert.equal(redraw(source, 2, stroke, 18).reason, 'endpoint');
  const crossing = [[203, 176], [268, 299], [382, 373], [399, 150], [335, 134]]
    .map(([x, y]) => ({ x, y }));
  assert.equal(redraw(source, 0, crossing, 18).reason, 'crossing');
});

test('a bend-only edit on a straight polygon produces no false visual alternatives', () => {
  const source = createBase('rectilinear');
  for (const node of source.nodes) {
    node.in = { ...node.point };
    node.out = { ...node.point };
  }
  assert.equal(inspect(source).ok, true);
  assert.deepEqual(generate(source, { width: 0, bend: 24 }).candidates, []);
});
