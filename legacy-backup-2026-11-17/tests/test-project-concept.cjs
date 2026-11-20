'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const projects = require('./dist/project-store.js');
const geometry = require('./dist/concept-geometry.js');
const rules = require('./dist/sketch-rules.js');

function storage() {
  const values = new Map([['wuying-existing-board', 'old drawing']]);
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

test('project records isolate briefs and retain the legacy workspace', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const localStorage = storage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  try {
    const first = projects.create(' 灯具探索 ');
    const second = projects.create('');
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, '灯具探索');
    assert.equal(second.name, '未命名项目');
    assert.equal(first.desk, 'brief');
    assert.equal(first.editorPanel, 'derive');
    assert.equal(first.activeDraftId, null);
    assert.deepEqual(first.preferences, { enabled: false, text: '' });
    assert.equal(projects.idFromLocation('?project=' + first.id), first.id);
    assert.equal(projects.idFromLocation('https://example.test/?project=../broken'), null);
    assert.equal(projects.suffix(first.id), '-project-' + first.id);
    assert.equal(projects.suffix(null), '');
    assert.equal(projects.suffix('legacy'), '');
    assert.equal(projects.get('broken'), null);
    projects.update(first.id, { brief: { product: '桌面灯' }, desk: 'editor', editorPanel: 'generate', activeDraftId: 'draft1' });
    projects.update(first.id, { brief: { goal: '便于调整' }, preferences: { text: '哑光' }, id: second.id });
    projects.rename(first.id, '灯具改稿');
    const saved = projects.get(first.id);
    assert.equal(saved.id, first.id);
    assert.equal(saved.name, '灯具改稿');
    assert.equal(saved.brief.product, '桌面灯');
    assert.equal(saved.brief.goal, '便于调整');
    assert.equal(saved.activeDraftId, 'draft1');
    assert.equal(saved.editorPanel, 'generate');
    assert.deepEqual(saved.preferences, { enabled: false, text: '哑光' });
    assert.equal(projects.get(second.id).brief.product, '');
    assert.equal(projects.list().length, 2);
    assert.equal(localStorage.getItem('wuying-existing-board'), 'old drawing');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

const anchors = [
  [[.18,.34],[.30,.24],[.68,.24],[.82,.36],[.77,.68],[.29,.68]],
  [[.40,.12],[.60,.12],[.66,.34],[.65,.82],[.34,.82],[.33,.34]],
  [[.13,.57],[.28,.37],[.62,.42],[.85,.53],[.71,.77],[.21,.77]]
];

const fixture = () => anchors.map((coords, index) => ({
  id: 'untrusted-' + index,
  name: ['压低体量', '直立聚拢', '斜向展开'][index],
  reason: '方向说明',
  tradeoff: '需要验证边缘衔接',
  anchors: coords.map(([x, y]) => ({ x, y })),
  parts: [{ label: '主要部件', x: .5, y: .5 }]
}));

test('three directions become editable contours in one shared frame', () => {
  const input = fixture();
  const output = geometry.validate({ directions: input }, rules);
  assert.equal(output.length, 3);
  for (const [index, direction] of output.entries()) {
    assert.equal(rules.inspect(direction.shape).ok, true);
    assert.deepEqual(direction.shape.nodes[0].point, { x: input[index].anchors[0].x * 800, y: input[index].anchors[0].y * 640 });
    assert.equal(direction.parts[0].label, '主要部件');
    assert.deepEqual(direction.shape.pins, { anchors: [], segments: [] });
    assert.equal('id' in direction, false);
  }
  assert.deepEqual(geometry.validate(output, rules), output);
});

test('rejects malformed, self-crossing and geometrically duplicate directions', () => {
  const inputs = fixture();
  assert.throws(() => geometry.validate([inputs[0]], rules), /三/);
  const outside = fixture();
  outside[0].anchors[0].x = .02;
  assert.throws(() => geometry.validate(outside, rules), /轮廓|坐标/);
  const crossed = fixture();
  [crossed[0].anchors[1], crossed[0].anchors[4]] = [crossed[0].anchors[4], crossed[0].anchors[1]];
  assert.throws(() => geometry.validate(crossed, rules), /轮廓/);
  const shifted = fixture();
  shifted[1].anchors = shifted[0].anchors.map(({ x, y }) => ({ x: x * .8 + .09, y: y * .8 + .05 })).reverse();
  assert.throws(() => geometry.validate(shifted, rules), /差异/);
  const flat = fixture();
  flat[0].anchors = flat[0].anchors.map(({ x, y }) => ({ x, y: .4 + y * .06 }));
  assert.throws(() => geometry.validate(flat, rules), /比例|轮廓/);
});
