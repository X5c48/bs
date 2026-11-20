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

