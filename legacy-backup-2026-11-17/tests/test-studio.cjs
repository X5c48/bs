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

test('new strokes retain the smooth pressure outline when saved alongside older strokes', () => {
  const legacy = line([[10,10],[19,18],[40,13]]);
  const smooth = { ...legacy, engine:'perfect', opacity:.7, points:legacy.points.map((p,i)=>({...p,pressure:.25+i*.31})) };
  const [oldStroke,newStroke] = studio.cleanInk([legacy,smooth]);
  assert.equal(oldStroke.engine,undefined);
  assert.equal(studio.brushGeometry(oldStroke).filled,false);
  assert.equal(newStroke.engine,'perfect');
  assert.equal(newStroke.opacity,.7);
  const outline = studio.brushGeometry(newStroke);
  assert.equal(outline.filled,true);
  assert.match(outline.d,/ Q.+ Z$/);
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

test('local shading preserves separate forms and closes contours assembled from several strokes', () => {
  const seat=[
    line([[0,0],[40,0],[80,0]],3,'moss'),
    line([[80,1],[80,39]]),
    line([[80,40],[2,40]]),
    line([[1,39],[1,1]])
  ];
  const lamp=line([[110,18],[140,18],[145,42],[111,41],[110,18]],3,'ochre');
  const open=line([[140,18],[160,10],[162,53]]);
  const regions=studio.inkRegions([...seat,lamp,open],rules);
  assert.equal(regions.length,2);
  assert.equal(regions[0].color,'moss');
  assert.equal(regions[1].color,'ochre');
  const rendered=studio.renderSvg({ink:[...seat,lamp,open]},rules,{style:'ps',id:'separate'});
  assert.equal((rendered.match(/class="studio-ink-region"/g)||[]).length,2);
  assert.equal((rendered.match(/class="studio-ink-line"/g)||[]).length,6);
  assert.equal(studio.inkRegions([open],rules).length,0);
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

test('the AI color guide fills closed colored shapes without filling the line map or open strokes', () => {
  const scene={ink:[
    line([[0,0],[40,0],[40,38],[0,38],[0,0]],3,'moss'),
    line([[52,10],[75,22],[82,45]],3,'blue'),
    line([[100,0],[140,0],[140,38],[100,38],[100,0]],3,'graphite')
  ]};
  const guide=studio.lineMarkup(scene,rules,{fillInk:true});
  assert.equal((guide.match(/fill-opacity="\.82"/g)||[]).length,1);
  assert.match(guide,/fill="#557b54" fill-opacity="\.82"/);
  assert.doesNotMatch(studio.lineMarkup(scene,rules),/fill-opacity="\.82"/);
  assert.doesNotMatch(studio.lineMarkup(scene,rules,{monochrome:true,fillInk:true}),/fill-opacity="\.82"/);
});

test('drawn thickness stays with its closed hand-drawn part and produces a side in both previews', () => {
  const left=line([[10,10],[90,10],[90,80],[10,80],[10,10]]);
  const right=line([[130,20],[200,20],[200,75],[130,75],[130,20]]);
  const open=line([[240,10],[280,50],[260,70]]);
  assert.deepEqual(studio.depthTarget({ink:[left,right,open]},rules,{x:166,y:45},5).indices,[1]);
  assert.equal(studio.depthTarget({ink:[left,right,open]},rules,{x:262,y:35},5),null);
  const ink=studio.cleanInk([left,{...right,depth:{x:30,y:18}},{...open,depth:{x:Infinity,y:10}}]);
  const parts=studio.depthParts({ink},rules);
  assert.equal(parts.length,1);
  assert.deepEqual(parts[0].indices,[1]);
  assert.deepEqual(parts[0].depth,{x:30,y:18});
  assert.equal(ink[2].depth,undefined);
  const outline=studio.lineMarkup({ink},rules,{monochrome:true});
  assert.match(outline,/class="studio-depth-side"[^>]+fill="none"/);
  assert.match(studio.renderSvg({ink},rules,{style:'ps'}),/class="studio-depth-side"/);
});

test('side and top project the same closed parts and their individual drawn thickness', () => {
  const upper=line([[20,20],[100,20],[100,70],[20,70],[20,20]]);
  const lower=line([[140,100],[260,100],[260,130],[140,130],[140,100]]);
  const scene={ink:[{...upper,depth:{x:24,y:18}},{...lower,depth:{x:-16,y:0}}]};
  const side=studio.orthographicProjection(scene,rules,'side');
  const top=studio.orthographicProjection(scene,rules,'top');
  assert.deepEqual(side.map(({y,width,height})=>[y,width,height]),[[20,30,50],[100,16,30]]);
  assert.equal(side[0].x,side[1].x);
  assert.deepEqual(top.map(({x,width,height})=>[x,width,height]),[[20,80,30],[140,120,16]]);
  assert.equal(top[0].y+top[0].height,top[1].y+top[1].height);
  assert.deepEqual(studio.orthographicProjection({ink:[line([[20,20],[100,20],[100,70]])]},rules,'top'),[]);
  assert.equal(studio.orthographicProjection({ink:[upper]},rules,'side').length,1);
  const openCurve={...rules.createBase(),closed:false};
  assert.equal(studio.orthographicProjection({curve:openCurve,ink:[upper]},rules,'side').length,1);
  assert.doesNotMatch(studio.lineMarkup({...scene,view:'front'},rules,{monochrome:true}),/class="studio-depth-side"/);
  assert.doesNotMatch(studio.renderSvg({...scene,view:'front'},rules,{style:'ps'}),/class="studio-depth-side"/);
});
