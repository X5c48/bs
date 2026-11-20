'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const stages=require('./dist/flow-stages.js');

test('layersSig 对图层增删、显隐、透明度、笔迹数敏感，对无关字段不敏感',()=>{
  const layer={id:'a',kind:'ink',visible:true,opacity:1,strokes:[{points:[1,2]}]};
  const base=stages.layersSig([layer]);
  assert.equal(stages.layersSig([{...layer,strokes:[{points:[1,2]}]}]),base); // 内容相同
  assert.notEqual(stages.layersSig([layer,{id:'b',kind:'image'}]),base);      // 加图层
  assert.notEqual(stages.layersSig([{...layer,visible:false}]),base);         // 隐藏
  assert.notEqual(stages.layersSig([{...layer,opacity:.5}]),base);            // 透明度
  assert.notEqual(stages.layersSig([{...layer,strokes:[{},{},{}]}]),base);    // 笔迹数
  assert.notEqual(stages.layersSig([{...layer,blobId:'x'}]),base);            // 换位图
  assert.equal(stages.layersSig([{...layer,updatedAt:99}]),base);             // 无关字段
  assert.equal(stages.layersSig(null),'[]');
});

test('markStale 只标记下游已存在的阶段条目，可清除',()=>{
  const flow={stages:{refine:{snapshot:{revision:'r1'}},render:{stale:false}}};
  stages.markStale(flow,'sketch');
  assert.equal(flow.stages.refine.stale,true);
  assert.equal(flow.stages.ortho,undefined);        // 从没到过的阶段不加条目
  assert.equal(flow.stages.render.stale,true);
  assert.equal(stages.staleOf(flow,'render'),true);
  assert.equal(stages.staleOf(flow,'ortho'),false);
  stages.markStale(flow,'sketch',false);
  assert.equal(flow.stages.refine.stale,false);
  assert.equal(flow.stages.render.stale,false);   // 清除也是整段下游
  // 自己与上游不受影响；未知阶段不动作
  stages.markStale(flow,'render');
  assert.equal(flow.stages.refine.stale,false);
  stages.markStale(flow,'nope');
  stages.markStale(flow,'ortho');
  assert.equal(flow.stages.refine.stale,false);   // 上游不受影响
  assert.equal(flow.stages.render.stale,true);
});

test('capture 记录快照并清除该阶段过期标记，保留旧字段',()=>{
  const flow={stages:{ortho:{snapshot:{old:1},at:1,stale:true}}};
  stages.capture(flow,'ortho',{angles:['front','left','top']});
  const entry=flow.stages.ortho;
  assert.deepEqual(entry.snapshot,{angles:['front','left','top']});
  assert.equal(entry.stale,false);
  assert.ok(entry.at>1);
  stages.capture(flow,'sketch',{blobId:'b1'});
  assert.equal(flow.stages.sketch.stale,false);
});

test('normalizeStage 兜底未知阶段为 sketch',()=>{
  assert.equal(stages.normalizeStage('ortho'),'ortho');
  assert.equal(stages.normalizeStage('bogus'),'sketch');
  assert.equal(stages.normalizeStage(undefined),'sketch');
});
