'use strict';
// 草图造型模块：造型裂变（矢量变换）与发散（方向表）的纯逻辑测试
const test = require('node:test');
const assert = require('node:assert');
const explore = require('./dist/sketch-explore.js');

const stroke = (points, extra = {}) => ({ points, size: 4, color: '#202020', ...extra });
const vertical = () => [{
  id: 'l1', kind: 'ink', visible: true, opacity: 1,
  strokes: [stroke(Array.from({ length: 40 }, (_, i) => ({ x: .5, y: .1 + i * .02 }))) ]
}];

test('frameOf：返回包围盒重心与平均半径，空图层返回 null', () => {
  const frame = explore.frameOf(vertical());
  assert.ok(frame);
  assert.equal(Math.round(frame.x * 100), 50);
  assert.ok(frame.count === 40);
  assert.ok(frame.avgR > 0);
  assert.equal(explore.frameOf([]), null);
  assert.equal(explore.frameOf([{ strokes: [] }]), null);
});

test('裂变·修长：横向收紧、纵向拉长，点仍在 0..1 内', () => {
  const layers = [{ id: 'l1', kind: 'ink', strokes: [stroke([{ x: .3, y: .5 }, { x: .7, y: .5 }])] }];
  const [slender] = explore.fission({ layers }, { ids: ['slender'] });
  assert.equal(slender.id, 'slender');
  const points = slender.layers[0].strokes[0].points;
  // 以重心 0.5 为基准，横向距离从 .2 收到 .16
  assert.ok(Math.abs(points[0].x - .34) < .02, '实际 ' + points[0].x);
  assert.ok(Math.abs(points[1].x - .66) < .02, '实际 ' + points[1].x);
  assert.ok(points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
});

test('裂变·镜像与错位：左右翻转、上下半错开', () => {
  const layers = [{ id: 'l1', kind: 'ink', strokes: [stroke([{ x: .2, y: .2 }, { x: .2, y: .8 }])] }];
  const [mirror] = explore.fission({ layers }, { ids: ['mirror'] });
  assert.ok(Math.abs(mirror.layers[0].strokes[0].points[0].x - .8) < .001);
  const [offset] = explore.fission({ layers }, { ids: ['offset'] });
  const moved = offset.layers[0].strokes[0].points;
  assert.ok(moved[0].x > .2, '上半部右移');
  assert.ok(moved[1].x < .2, '下半部左移');
});

test('裂变·圆化：点半径向均值收敛，方形轮廓变圆', () => {
  // 一个正方形四点，重心 0.5/0.5，四角半径 0.28；圆化后角点应向均值半径靠拢
  const square = [{ id: 'l1', kind: 'ink', strokes: [stroke(
    [{ x: .25, y: .25 }, { x: .75, y: .25 }, { x: .75, y: .75 }, { x: .25, y: .75 }])] }];
  const [round] = explore.fission({ layers: square }, { ids: ['round'] });
  const points = round.layers[0].strokes[0].points;
  const radii = points.map(p => Math.hypot(p.x - .5, p.y - .5));
  const before = Math.hypot(.25 - .5, .25 - .5);
  assert.ok(radii.every(r => r < before + 1e-6), '角点半径必须收敛');
});

test('裂变：默认产出六个方向，count 截断，隐藏图层不参与', () => {
  const layers = [...vertical(), { id: 'hide', kind: 'ink', visible: false, strokes: [stroke([{ x: .1, y: .1 }])] }];
  assert.equal(explore.fission({ layers }).length, 6);
  assert.equal(explore.fission({ layers }, { count: 3 }).length, 3);
  const [first] = explore.fission({ layers });
  assert.equal(first.layers.length, 1, '隐藏图层被剔除');
});

test('裂变：属性完整保留（size/color/erase），产物可继续编辑', () => {
  const layers = [{ id: 'l1', kind: 'ink', strokes: [stroke([{ x: .4, y: .4 }, { x: .6, y: .6 }], { size: 9, color: '#ff0000' })] }];
  const [variant] = explore.fission({ layers }, { ids: ['sturdy'] });
  const kept = variant.layers[0].strokes[0];
  assert.equal(kept.size, 9);
  assert.equal(kept.color, '#ff0000');
  assert.equal(kept.points.length, 2);
});

test('密集笔迹抽稀：点数上限 240，短笔迹不丢点', () => {
  const dense = Array.from({ length: 1200 }, (_, i) => ({ x: .1 + i / 1200 * .8, y: .5 }));
  const layers = [{ id: 'l1', kind: 'ink', strokes: [stroke(dense)] }];
  const [variant] = explore.fission({ layers }, { ids: ['mirror'] });
  const count = variant.layers[0].strokes[0].points.length;
  assert.ok(count <= 240 && count >= 100, '抽稀后 ' + count);
  const short = [{ id: 'l1', kind: 'ink', strokes: [stroke([{ x: .1, y: .1 }, { x: .2, y: .2 }])] }];
  assert.equal(explore.fission({ layers: short }, { ids: ['mirror'] })[0].layers[0].strokes[0].points.length, 2);
});

test('发散：按方向表逐一调用出图通道，数量可截断', async () => {
  const calls = [];
  const results = await explore.diverge({
    asset: { width: 640, height: 480 },
    source: 'source-blob',
    count: 3,
    generate: async options => { calls.push(options); return 'blob-' + calls.length; }
  });
  assert.equal(results.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].kind, 'render');
  assert.equal(calls[0].source, 'source-blob');
  assert.deepEqual(calls[0].size, { width: 640, height: 480 });
  assert.match(results[0].prompt, /minimal/);
  assert.equal(results[0].blob, 'blob-1');
  // 每次种子不同，避免同方向出同一张
  assert.notEqual(calls[0].seed, calls[1].seed);
});

test('发散：缺源图或通道时报错，取消信号中止', async () => {
  await assert.rejects(explore.diverge({ asset: { width: 1, height: 1 }, source: null, generate: async () => 'x' }), /缺少源图/);
  await assert.rejects(explore.diverge({ asset: { width: 1, height: 1 }, source: 's' }), /缺少源图/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(explore.diverge({
    asset: { width: 1, height: 1 }, source: 's', generate: async () => 'x', signal: aborted.signal
  }));
});

test('方向表：六种方向带可用于出图的英文提示词', () => {
  assert.equal(explore.directions.length, 6);
  for (const direction of explore.directions) {
    assert.ok(direction.id && direction.label && direction.prompt);
    assert.ok(direction.prompt.length > 20);
  }
  assert.equal(explore.chooseDirections(9).length, 6, '超出上限时截到 6');
  assert.equal(explore.chooseDirections(0).length, 6, '非法数量回落到全部');
});
