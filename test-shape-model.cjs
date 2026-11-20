const {test}=require('node:test');
const assert=require('node:assert/strict');
const parts=require('./dist/shape-model.js');
const size={width:640,height:480};

function fixture(){
  return [
    parts.createPart('shade','ellipse','灯罩',{x:300,y:135,width:210,height:115,angle:0},size),
    parts.createPart('base','rectangle','底座',{x:320,y:370,width:235,height:48,angle:0,locked:true},size),
    parts.createPart('stem','rectangle','支架',{x:320,y:238,width:29,height:165,angle:0},size)
  ];
}

test('locked parts cannot change or be deleted, and candidates only change the selected part',()=>{
  const source=fixture();
  assert.throws(()=>parts.updatePart(source,'base',{width:210},size),/锁定/);
  assert.throws(()=>parts.removePart(source,'base'),/锁定/);
  assert.throws(()=>parts.variants(source,'base','width',18,size),/锁定/);
  const list=parts.variants(source,'shade','width',20,size);
  assert.equal(list.length,3);
  for(const item of list){
    assert.deepEqual(item.parts.slice(1),source.slice(1));
    assert.deepEqual(parts.diff(source,item.parts).map(c=>[c.id,c.fields.map(f=>f.key)]),[['shade',['width']]]);
  }
  assert.equal(source[0].width,210);
});

test('a traced polygon can be moved and rotated, and rejects crossing or out of bounds',()=>{
  const stroke=[{x:80,y:80},{x:180,y:80},{x:180,y:180},{x:80,y:180}];
  const part=parts.tracePart('panel','外壳',stroke,size);
  assert.equal(part.shape,'polygon');
  assert.deepEqual(parts.polygon(part),stroke);
  const moved=parts.updatePart([part],'panel',{x:240,angle:90},size)[0];
  assert.deepEqual(parts.diff([part],[moved])[0].fields.map(f=>f.key),['x','angle']);
  assert.throws(()=>parts.updatePart([part],'panel',{x:4},size),/画布/);
  assert.throws(()=>parts.tracePart('cross','相交', [stroke[0],stroke[2],stroke[1],stroke[3]],size),/轮廓/);
});

test('the AI edit mask uses the active part and excludes every neighboring or locked part',()=>{
  const source=fixture();
  const mask=parts.editRegion(source,'shade',size);
  assert.equal(mask.points.length,40);
  assert.equal(mask.protectedAreas.length,2);
  assert.deepEqual(mask.protectedAreas[0][0],{x:202.5/size.width,y:346/size.height});
  assert.throws(()=>parts.editRegion(source,'base',size),/锁定/);
});

test('version lineage freezes the compared geometry independently of later parent edits',()=>{
  const parent={id:'root',name:'台灯',draft:{revision:'r1',parts:fixture()}};
  const lineage=parts.snapshot(parent);
  parent.draft.parts[0].width=260;
  assert.equal(lineage.parts[0].width,210);
  assert.deepEqual([lineage.parentId,lineage.revision],['root','r1']);
});

/* ── 深度维度：三视图推导 + 体块投影（融合自结构空间原型） ── */

test('legacy drafts gain thickness and depth position through normalization',()=>{
  const legacy=[{id:'p1',shape:'rectangle',name:'主体',locked:false,x:320,y:240,width:100,height:150,angle:0}];
  assert.equal(parts.needsNormalize(legacy),true);
  const fixed=parts.normalizeParts(legacy);
  assert.equal(parts.needsNormalize(fixed),false);
  assert.equal(fixed[0].depth,60);           // 默认厚度 = min(w,h)*0.6
  assert.equal(fixed[0].z,0);
  assert.equal(parts.needsNormalize(fixture()),false); // createPart 已带深度
  // depth/z 参与校验、更新与差异
  assert.throws(()=>parts.updatePart(fixed,'p1',{depth:2},size),/厚度/);
  const deeper=parts.updatePart(fixed,'p1',{depth:90,z:-20},size)[0];
  assert.deepEqual(parts.diff(fixed,[deeper])[0].fields.map(f=>f.key),['depth','z']);
  assert.throws(()=>parts.updatePart(fixed,'p1',{depth:'x'},size),/有效/);
});

test('side and top projections derive from outline plus depth without AI generation',()=>{
  const source=fixture(); // 灯罩椭圆、底座(锁定)、支架
  const shade=source[0]; // 灯罩 210×115 → 默认厚度 = min*0.6 = 69
  assert.equal(shade.depth,69);
  assert.deepEqual(parts.sideRect(shade),{x:shade.z-34.5,y:135-57.5,width:69,height:115});
  assert.deepEqual(parts.topRect(shade),{x:300-105,y:shade.z-34.5,width:210,height:69});
  const span=parts.depthSpan(source);
  assert.ok(span.min<=Math.min(...source.map(p=>p.z))&&span.max>=Math.max(...source.map(p=>p.z)));
  // 厚度也进入规则推敲候选
  const list=parts.variants(source,'stem','depth',20,size);
  assert.equal(list.length,3);
  assert.ok(list.every(item=>parts.diff(source,item.parts)[0].fields[0].key==='depth'));
});

test('block faces are sorted far to near, lit, and flip visibility with pitch',()=>{
  const part=parts.createPart('body','rectangle','主体',{x:320,y:240,width:120,height:160,depth:80,angle:0},size);
  // 正视平视(az=0,el=0)：侧棱正对相机，只看到正面
  const level=parts.blockFaces(part,0,0);
  assert.deepEqual(level.map(f=>f.id),['front']);
  // 略俯视：顶面 + 正面，远→近
  const level2=parts.blockFaces(part,0,0.35);
  assert.deepEqual(level2.map(f=>f.id),['top','front']);
  assert.ok(level2.every(f=>f.shade>=0.3&&f.shade<=1));
  // 俯视(el>0)：顶面可见、底面不可见；仰视(el<0)相反
  const down=parts.blockFaces(part,0,0.6), up=parts.blockFaces(part,0,-0.6);
  assert.deepEqual(down.map(f=>f.id).filter(id=>id==='top'),['top']);
  assert.deepEqual(down.map(f=>f.id).filter(id=>id==='bottom'),[]);
  assert.deepEqual(up.map(f=>f.id).filter(id=>id==='bottom'),['bottom']);
  assert.deepEqual(up.map(f=>f.id).filter(id=>id==='top'),[]);
  // 投影点为有限数值，且中心深度随方位角变化（供画家算法排序）
  for(const face of down) for(const p of face.points){
    assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
  }
  assert.notEqual(parts.blockDepth(part,0),parts.blockDepth(part,1.2));
  // 光照：顶面比受光少的侧面亮
  const top=down.find(f=>f.id==='top');
  const dark=down.find(f=>f.id!=='top');
  assert.ok(top.shade>=dark.shade);
});


