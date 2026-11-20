'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const design=require('./dist/design-model.js');

const draftAsset=()=>({
  id:'a1',name:'台灯',width:1024,height:768,
  draft:{
    revision:'r1',
    reference:{blobId:'b1',assetId:'a1',label:'台灯'},
    parts:[
      {id:'shade',shape:'ellipse',name:'灯罩',locked:false,x:512,y:216,width:340,height:190,angle:0,depth:114,z:0},
      {id:'stem',shape:'rectangle',name:'支架',locked:false,x:512,y:390,width:48,height:260,angle:0,depth:28.8,z:10},
      {id:'base',shape:'rectangle',name:'底座',locked:true,x:512,y:590,width:380,height:76,angle:0,depth:45.6,z:0}
    ]
  }
});

test('needsMigration：有 draft 无 design 才迁移',()=>{
  assert.equal(design.needsMigration(draftAsset()),true);
  assert.equal(design.needsMigration({}),false);
  const migrated=draftAsset(); migrated.design=design.fromDraft(migrated);
  assert.equal(design.needsMigration(migrated),false);
});

test('fromDraft 无损迁移：轮廓节点、锁定表、部件元数据、共享尺寸',()=>{
  const asset=draftAsset();
  const model=design.fromDraft(asset);
  assert.equal(model.revision,'r1');
  // 部件元数据与方案级锁定表
  assert.deepEqual(Object.keys(model.parts),['shade','stem','base']);
  assert.equal(model.parts.base.name,'底座');
  assert.deepEqual(model.locks,{base:true});
  // 正视视图：三个部件都有闭合轮廓，reference 保留
  const front=model.views.front;
  assert.equal(front.revision,'r1');
  assert.deepEqual(front.reference,{blobId:'b1',assetId:'a1',label:'台灯'});
  assert.deepEqual(Object.keys(front.outlines),['shade','stem','base']);
  for(const outline of Object.values(front.outlines)){
    assert.equal(outline.closed,true);
    assert.ok(outline.nodes.length>=3);
    for(const node of outline.nodes){
      assert.deepEqual(node.in,node.point);
      assert.deepEqual(node.out,node.point);
    }
  }
  // 矩形 → 4 个角点，包围盒与部件尺寸一致（含角度旋转）
  const stemBox=outlineBounds(front.outlines.stem.nodes);
  assert.deepEqual(stemBox,{minX:488,maxX:536,minY:260,maxY:520});
  const tilted=draftAsset();
  tilted.draft.parts[1].angle=90;
  const tiltedBox=outlineBounds(design.fromDraft(tilted).views.front.outlines.stem.nodes);
  assert.deepEqual(tiltedBox,{minX:382,maxX:642,minY:366,maxY:414}); // 48×260 转 90° → 260×48
  // 椭圆 → 40 个采样点，极值在半径处
  const shadeBox=outlineBounds(front.outlines.shade.nodes);
  assert.deepEqual(shadeBox,{minX:342,maxX:682,minY:121,maxY:311});
  // 多边形 → 节点数等于采样点数
  const poly=draftAsset();
  poly.draft.parts[0]={...poly.draft.parts[0],shape:'polygon',
    points:[{x:-.5,y:-.5},{x:.5,y:-.5},{x:0,y:.5}]};
  assert.equal(design.fromDraft(poly).views.front.outlines.shade.nodes.length,3);
  // 共享尺寸：bounds 深度=部件深度区间的总跨度（支架 z=10 的区间被灯罩覆盖）
  assert.deepEqual(model.bounds,{width:1024,height:768,depth:114});
});

test('migrate 写 design 且保留 draft；重复调用是幂等空操作',()=>{
  const asset=draftAsset();
  assert.equal(design.migrate(asset),true);
  assert.ok(asset.design);
  assert.ok(asset.draft);           // 保留一个周期作回退
  const revision=asset.design.revision;
  assert.equal(design.migrate(asset),false); // needsMigration=false
  assert.equal(asset.design.revision,revision);
});

test('locksOf 读方案级表，未迁移时从 draft 推导',()=>{
  const asset=draftAsset();
  assert.deepEqual(design.locksOf(asset),{base:true});
  design.migrate(asset);
  assert.deepEqual(design.locksOf(asset),{base:true});
});

test('applyLock 写 design.locks 并双写 draft 部件；design 缺失就地补建',()=>{
  const asset=draftAsset();
  assert.equal(design.applyLock(asset,'shade',true),true);
  assert.deepEqual(asset.design.locks,{base:true,shade:true});
  assert.equal(asset.draft.parts.find(p=>p.id==='shade').locked,true);
  assert.equal(design.applyLock(asset,'base',false),true);
  assert.deepEqual(asset.design.locks,{shade:true});
  assert.equal(asset.draft.parts.find(p=>p.id==='base').locked,false);
  // 未知部件返回 false，不动表
  assert.equal(design.applyLock(asset,'ghost',true),false);
  assert.deepEqual(asset.design.locks,{shade:true});
  // 没迁移过的资产也能直接锁（就地补建 design）
  const raw={draft:{parts:[{id:'x',name:'X',locked:false}]}};
  assert.equal(design.applyLock(raw,'x',true),true);
  assert.deepEqual(raw.design.locks,{x:true});
});

function outlineBounds(nodes){
  const xs=nodes.map(n=>n.point.x),ys=nodes.map(n=>n.point.y);
  return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
}
