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

test('brush opacity survives save and pen pressure changes the shape of the ink', () => {
  const pressureStroke={...line([[0,10],[22,11],[44,10]],10),opacity:.42};
  pressureStroke.points[0].pressure=.12;
  pressureStroke.points[1].pressure=.86;
  const [saved]=studio.cleanInk([pressureStroke]);
  assert.equal(saved.opacity,.42);
  assert.equal(saved.points[0].pressure,.12);
  assert.equal(studio.brushGeometry(saved).filled,true);
  assert.notEqual(studio.brushGeometry(saved).d,studio.brushPath(saved));
  assert.match(studio.inkMarkup([saved]),/opacity="0.42"/);
});

test('the raster color mask fills an enclosed line drawing without spilling into the paper', () => {
  const size=24, image=new Uint8ClampedArray(size*size*4).fill(255);
  for(let y=5;y<=17;y++)for(let x=5;x<=17;x++){
    if(x!==5&&x!==17&&y!==5&&y!==17)continue;
    image.fill(20,(y*size+x)*4,(y*size+x)*4+3);
  }
  const mask=studio.enclosedMask(image,size,size);
  assert.equal(mask[10*size+10],255);
  assert.equal(mask[1],0);
  image.fill(255,(5*size+10)*4,(5*size+10)*4+3);
  assert.equal(studio.enclosedMask(image,size,size),null);
});

test('the Photoshop-style preview keeps the design outline and adds a marker wash to open strokes', () => {
  const shoe=studio.shoeSample();
  const closed=studio.renderSvg({curve:shoe,ink:[],profile:'shoe'},rules,{id:'psclosed',style:'ps'});
  assert.match(closed,/class="studio-ps-outline"/);
  assert.match(closed,/class="studio-ps-light"/);
  const open=studio.renderSvg({ink:[line([[18,25],[88,53]])]},rules,{id:'psopen',style:'ps'});
  assert.match(open,/class="studio-ps-wash"/);
  assert.match(open,/class="studio-ink-line"/);
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
