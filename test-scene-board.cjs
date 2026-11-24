// P8 产品渲染 · 实时辅助 → Krea 式实物渲染（场景板）
// 覆盖合成层的纯函数：白底抠图、遮罩外扩、轮廓、摆放几何、提示词编译。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function board() {
  const window = {};
  const context = vm.createContext({ window, Math, Uint8Array, Uint8ClampedArray, Number, Array, Object, String, JSON });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/scene-board.js', 'utf8'), context);
  return window.WuyingSceneBoard;
}

// 造一张「白底 + 中间一块深色产品」的小图，用来验证抠图。
function whiteWithObject(size = 8, inset = 2) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
      const value = inside ? 40 : 248;
      const index = (y * size + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { data, size };
}

test('白底抠图：四角判为背景，产品内部判为前景，边界做羽化', () => {
  const api = board();
  const { data, size } = whiteWithObject(8, 2);
  const alpha = api.whiteBackdropAlpha(data, size, size);
  const at = (x, y) => alpha[y * size + x];
  assert.equal(at(0, 0), 0, '角上必须是背景');
  assert.equal(at(7, 7), 0, '对角也必须是背景');
  assert.equal(at(3, 3), 255, '产品内部必须完全保留');
  const edge = at(2, 3);
  assert.ok(edge > 0 && edge < 255, '产品边缘要羽化，实际 ' + edge);
});

test('白底抠图：产品贴到画面边缘时不会被当成背景挖掉', () => {
  const api = board();
  const size = 6;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 左半是深色产品，右半是白背景：产品直接顶到左边界。
      const value = x < 3 ? 30 : 250;
      const index = (y * size + x) * 4;
      data[index] = value; data[index + 1] = value; data[index + 2] = value; data[index + 3] = 255;
    }
  }
  const alpha = api.whiteBackdropAlpha(data, size, size);
  assert.equal(alpha[2 * size + 1], 255, '顶边界的深色区仍是产品');
  assert.equal(alpha[2 * size + 5], 0, '右侧白区是背景');
});

test('遮罩外扩把边缘向外推，反相得到场景遮罩', () => {
  const api = board();
  const size = 9;
  const alpha = new Uint8ClampedArray(size * size);
  alpha[4 * size + 4] = 255;
  const grown = api.dilateMask(alpha, size, size, 2);
  assert.equal(grown[4 * size + 4], 255);
  assert.equal(grown[2 * size + 4], 255, '半径内的空点被填');
  assert.equal(grown[4 * size + 6], 255);
  assert.equal(grown[4 * size + 7], 0, '半径外的点不动');
  const inverse = api.invertMask(grown, size * size);
  assert.equal(inverse[4 * size + 4], 0);
  assert.equal(inverse[0], 255);
});

test('轮廓只画在遮罩边界上，内部保持白', () => {
  const api = board();
  const size = 8;
  const alpha = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size / 2; x += 1) alpha[y * size + x] = 255;
  const rgba = api.outlineFromMask(alpha, size, size);
  const at = (x, y) => rgba[(y * size + x) * 4];
  assert.equal(at(3, 4), 0, '左右交界处是轮廓');
  assert.equal(at(0, 4), 255, '左侧内部不是轮廓');
  assert.equal(at(7, 4), 255, '右侧内部不是轮廓');
});

test('摆放几何：scale 是高度占画布比例，底边中点落在地线上', () => {
  const api = board();
  const product = api.newProduct({ blobId: 'b1', x: .5, y: .9, scale: .5, rotate: 0 });
  const box = api.productBox(product, 1000, 1000, 200, 400);
  assert.equal(box.height, 500);
  assert.equal(box.width, 250, '宽度按图片宽高比推出来，产品不变形');
  assert.equal(box.centerX, 500);
  assert.equal(box.baseY, 900);
  assert.equal(box.left, 375);
  assert.equal(box.top, 400);
  assert.equal(box.bottom, 900);
});

test('摆放几何：换画幅时产品相对高度不变', () => {
  const api = board();
  const product = api.newProduct({ blobId: 'b1', x: .5, y: .8, scale: .4 });
  const wide = api.productBox(product, 1280, 1024, 300, 300);
  const square = api.productBox(product, 1024, 1024, 300, 300);
  assert.equal(wide.height, 1024 * .4);
  assert.equal(square.height, 1024 * .4);
  assert.equal(api.boxRatio(wide, 1280, 1024).h, api.boxRatio(square, 1024, 1024).h, '相对高度一致');
  // 画布更宽时产品占比更小，这是正确的：产品高度只跟着画布高度走。
  assert.ok(api.boxRatio(wide, 1280, 1024).w < api.boxRatio(square, 1024, 1024).w);
});

test('没有产品时包围盒为空，不抛错', () => {
  const api = board();
  assert.equal(api.productBox(null, 800, 600, 100, 100), null);
  // 跨 vm realm 的对象原型不同，不能 deepEqual，逐字段比。
  assert.equal(JSON.stringify(api.boxRatio(null, 800, 600)), JSON.stringify({ x: 0, y: 0, w: 0, h: 0, area: 0 }));
});

test('场景数据兜底与过滤：缺 blobId 的产品被清掉，没颜色的色块被丢掉', () => {
  const api = board();
  const empty = api.normalizeScene(null);
  assert.equal(empty.product, null);
  assert.equal(empty.blocks.length, 0);
  assert.equal(empty.lighting, 'studio');
  const cleaned = api.normalizeScene({
    backdrop: '#123456',
    product: { x: .4 },
    blocks: [{ color: '#fff', x: 0, y: .5, w: 1, h: .5 }, { x: .1 }],
    props: [{ blobId: 'p1' }, { x: .2 }]
  });
  assert.equal(cleaned.backdrop, '#123456');
  assert.equal(cleaned.product, null);
  assert.equal(cleaned.blocks.length, 1);
  assert.equal(cleaned.props.length, 1);
});

test('提示词编译：光照、材质、用户描述都要进正向词，负向词盯住产品变形', () => {
  const api = board();
  assert.equal(api.lightingPresets.length, 4);
  assert.equal(api.materialTags.length, 6);
  assert.equal(api.sampleScenes.length, 4);
  const prompt = api.scenePrompt({ lighting: 'night', material: 'glass', prompt: '户外草地，黄昏' });
  assert.match(prompt, /night time scene/);
  assert.match(prompt, /clear glass/);
  assert.match(prompt, /户外草地，黄昏/);
  assert.match(prompt, /silhouette, proportions and parts exactly/);
  assert.equal(api.lightingPrompt('bogus'), api.lightingPresets[0].prompt, '未知光照回落到棚拍');
  assert.equal(api.materialPrompt('bogus'), '');
  assert.match(api.sceneNegative, /extra products/);
  assert.match(api.sceneNegative, /distorted silhouette/);
  // 场景阶段的负向词不能带「no scene」这类草图阶段的词，否则自己把自己推走。
  assert.doesNotMatch(api.sceneNegative, /no scene/);
});

test('新建对象带默认值，可直接落进 render.scene', () => {
  const api = board();
  const product = api.newProduct({ blobId: 'mold-1', source: 'mold' });
  assert.equal(product.source, 'mold');
  assert.equal(product.x, .5);
  assert.equal(product.scale, .55);
  const block = api.newBlock({ color: '#b18a5f' });
  assert.match(block.id, /^block-/);
  assert.equal(block.y, .62);
  const prop = api.newProp({ blobId: 'p1' });
  assert.match(prop.id, /^prop-/);
});
