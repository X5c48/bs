const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./dist/sketch-rules.js');
const studio = require('./dist/studio-core.js');

const points = coordinates => coordinates.map(([x, y]) => ({ x, y }));
const line = (coordinates, size = 4, color = 'graphite') => ({points: points(coordinates), size, color});

test('single taps and strokes are drawable, erasable between sparse samples, and validated on load', () => {
  const strokes = studio.cleanInk([
    line([[1, 0], [49, 0]]), line([[10, 20]]), line([[0, 0]], 4, '" style="bad'),
    line([[Infinity, 0]]), { points: null }
  ]);
  assert.equal(strokes.length, 2);
  assert.match(studio.brushPath(strokes[1]), /^M.+L/);
  assert.equal(studio.hitStroke(strokes[0], {x:25,y:3}, 4), true);
  assert.equal(studio.hitStroke(strokes[0], {x:25,y:12}, 4), false);
});

test('continuous erasing between pointer samples still hits a crossed stroke', () => {
  const stroke = line([[0, 0], [50, 0]]);
  assert.equal(studio.hitStroke(stroke, {x:25,y:12}, 3, {x:25,y:-14}), true);
  assert.equal(studio.hitStroke(stroke, {x:25,y:12}, 3, {x:39,y:12}), false);
});

test('an open stroke stays line art, a simple closed stroke provides a filled form', () => {
  const open = line([[0, 0], [44, 0], [44, 30], [18, 30]]);
  const closed = line([[0, 0], [44, 0], [44, 30], [0, 30], [0, 1]]);
  const crossing = line([[0, 0], [44, 28], [0, 28], [42, 0], [0, 1]]);
  assert.equal(studio.inkOutline([open], rules), null);
  assert.equal(studio.inkOutline([crossing], rules), null);
  assert.ok(studio.inkOutline([closed], rules)?.closed);
});

test('the showcase geometry passes the same curve checks and real paint is included in both exports', () => {
  const shoe = studio.shoeSample();
  assert.equal(rules.inspect(shoe).ok, true);
  const scene = {curve:shoe, ink:[line([[195,222], [209,243]], 4, 'ochre')], profile:'shoe'};
  const sketch = studio.lineMarkup(scene, rules);
  assert.match(sketch, /M195 222/);
  const silver = studio.renderSvg(scene, rules, {tone:'silver',light:38,id:'main'});
  const spruce = studio.renderSvg(scene, rules, {tone:'moss',light:62,id:'alt'});
  assert.match(silver, /M195 222/);
  assert.match(silver, /main-body/);
  assert.match(spruce, /alt-body/);
  assert.notEqual(silver, spruce);
});
