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

test('体块是轮廓挤出的棱柱：随轮廓形状、随角度保持同一物体、含旋转的三视图一致',()=>{
  const part=parts.createPart('body','rectangle','主体',{x:320,y:240,width:120,height:160,depth:80,angle:0},size);
  // 正视平视(az=0,el=0)：只看到前盖面（侧壁法线 z=0，被剔除）
  const level=parts.blockFaces(part,0,0);
  assert.deepEqual(level.map(f=>f.id),['front']);
  assert.equal(level[0].points.length,4,'矩形前盖应为 4 点轮廓');
  // 略俯视：顶边侧壁 + 前盖，远→近
  const level2=parts.blockFaces(part,0,0.35);
  assert.ok(level2.some(f=>f.id==='front')&&level2.some(f=>f.id.startsWith('wall-')),
    level2.map(f=>f.id).join(','));
  assert.ok(level2.every(f=>f.shade>=0.3&&f.shade<=1));
  // 俯仰翻转：俯视看到顶边侧壁，仰视看到底边侧壁；后盖在两个方向上都不可见
  const down=parts.blockFaces(part,0,0.6), up=parts.blockFaces(part,0,-0.6);
  assert.ok(down.some(f=>f.id.startsWith('wall-')));
  assert.ok(up.some(f=>f.id.startsWith('wall-')));
  assert.ok(!up.some(f=>f.id==='back')&&!down.some(f=>f.id==='back'),'后盖朝向相机背面，始终不可见');
  // 轮廓形状进入体块：三角描线部件 → 前盖 3 点、侧壁 3 面
  const tri=parts.createPart('tri','polygon','三角',{x:320,y:240,width:100,height:100,depth:40,angle:0,
    points:[{x:0,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}]},size);
  const triFaces=parts.blockFaces(tri,0,0);
  assert.equal(triFaces[0].points.length,3,'三角部件的前盖必须是 3 点，而不是包围盒 4 点');
  assert.ok(triFaces.length===1,'平视只看到前盖');
  // 角度改变后三视图仍与体块同源：侧视高度=轮廓旋转后高度、俯视宽度=轮廓旋转后宽度
  const rotated=parts.createPart('rot','rectangle','旋转主体',{x:320,y:240,width:120,height:60,depth:50,angle:90},size);
  const box=parts.outlineBounds(rotated);
  assert.equal(Math.round(box.width),60);
  assert.equal(Math.round(box.height),120);
  assert.deepEqual(parts.sideRect(rotated),{x:rotated.z-25,y:box.y,width:50,height:box.height});
  assert.deepEqual(parts.topRect(rotated),{x:box.x,y:rotated.z-25,width:box.width,height:50});
  // 投影点为有限数值，且中心深度随方位角变化（画家算法排序用）
  for(const face of down) for(const p of face.points){
    assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
  }
  assert.notEqual(parts.blockDepth(part,0),parts.blockDepth(part,1.2));
});



test('moveNode：合法移动只改目标节点，入参不被修改',()=>{
  const hex=[{x:0,y:-.5},{x:.5,y:-.25},{x:.5,y:.25},{x:0,y:.5},{x:-.5,y:.25},{x:-.5,y:-.25}];
  const part=parts.createPart('p','polygon','六边形',{x:300,y:300,width:200,height:200,angle:0,points:hex},size);
  const moved=parts.moveNode(part,0,{x:0,y:-.3});
  assert.equal(moved.ok,true);
  assert.deepEqual(moved.part.points[0],{x:0,y:-.3});
  moved.part.points.slice(1).forEach((point,index)=>assert.deepEqual(point,part.points[index+1]));
  assert.deepEqual(part.points[0],hex[0]);
  // 拖出包围盒的坐标被钳回边界（用「房子」五边形拖一个角到边界，形状仍合法）
  const house=[{x:0,y:-.5},{x:.5,y:0},{x:.35,y:.5},{x:-.35,y:.5},{x:-.5,y:0}];
  const tent=parts.createPart('t','polygon','房子',{x:300,y:300,width:200,height:200,angle:0,points:house},size);
  const clamped=parts.moveNode(tent,3,{x:-9,y:9});
  assert.equal(clamped.ok,true,'钳回边界后应保持合法');
  assert.deepEqual(clamped.part.points[3],{x:-.5,y:.5});
});

test('moveNode：自交时拒绝（自动回退），锁定与非描线部件报错',()=>{
  // U 形凹多边形：把内凹角拖到另一条腿上必然自交
  const u=[{x:-.5,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:.1,y:.5},
    {x:.1,y:0},{x:-.1,y:0},{x:-.1,y:.5},{x:-.5,y:.5}];
  const part=parts.createPart('u','polygon','U 形',{x:300,y:300,width:200,height:200,angle:0,points:u},size);
  let crossed=0,okCount=0;
  const reasons=new Set();
  for(let y=-.5;y<=.5;y+=.1){
    for(let x=-.5;x<=.5;x+=.1){
      const result=parts.moveNode(part,4,{x,y});
      if(!result.ok){ reasons.add(result.reason); if(result.reason==='crossing') crossed++; }
      else okCount++;
    }
  }
  assert.ok(crossed>0,'凹多边形拖节点必须触发自交防护：crossing '+crossed+'，失败原因 '+[...reasons].join('/'));
  assert.ok(okCount>0,'也要保留一批合法位置');
  // 锁定部件不许拖节点
  const locked={...part,locked:true};
  assert.throws(()=>parts.moveNode(locked,0,{x:0,y:0}),/已锁定/);
  // 矩形部件没有节点
  const box=parts.createPart('b','rectangle','矩形',{x:300,y:300,width:80,height:80,depth:20,angle:0},size);
  assert.throws(()=>parts.moveNode(box,0,{x:0,y:0}),/只有描线部件/);
});

test('updatePart 支持描线部件更新 points 并做合法性校验',()=>{
  const square=[{x:-.5,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}];
  const part=parts.createPart('s','polygon','方块',{x:300,y:300,width:160,height:160,angle:0,points:square},size);
  const next=parts.updatePart([part],'s',{points:[{x:-.4,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}]},size)[0];
  assert.deepEqual(next.points[0],{x:-.4,y:-.5});
  // 越界坐标会被 validate 拒绝（轮廓超出画布）
  assert.throws(()=>parts.updatePart([part],'s',{points:[{x:-9,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}]},size),/超出画布/);
});

test('splitting a curved segment preserves its shape and independent handles survive later edits',()=>{
  const part=parts.tracePart('panel','面板',[{x:80,y:80},{x:180,y:80},{x:180,y:180},{x:80,y:180}],size);
  const smooth=parts.editNode(part,0,'out',{x:-.25,y:-.45}).part;
  assert.deepEqual(smooth.points[0].in,{x:-.75,y:-.55});
  const asymmetric=parts.editNode(smooth,0,'in',{x:-.52,y:-.35},true).part;
  assert.deepEqual(asymmetric.points[0].out,smooth.points[0].out);
  const before=parts.polygon(asymmetric);
  const split=parts.editNode(asymmetric,0,'insert',.5).part;
  const after=parts.polygon(split);
  assert.equal(split.points.length,5);
  for(const p of before) assert.ok(after.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<.001));
  assert.equal(parts.editNode(split,1,'delete').part.points.length,4);
  const locked={...part,id:'locked',locked:true};
  assert.throws(()=>parts.updatePart([part,locked],part.id,{width:110},size),/共用/);
  const triangle=parts.editNode(part,0,'delete').part;
  assert.equal(parts.editNode(triangle,0,'delete').ok,false);
});

test('局部帧族谱记录节点参数差，父稿保持原值',()=>{
  const lamp=parts.tracePart('shade','灯罩',[{x:80,y:80},{x:200,y:80},{x:180,y:140},{x:80,y:140}],size);
  const next=parts.moveNode(lamp,1,{x:.45,y:-.35}).part;
  const change=parts.diff([lamp],[next]);
  assert.equal(change.length,1);
  assert.match(change[0].fields[0].label,/节点 2/);
  assert.notEqual(change[0].fields[0].before,change[0].fields[0].after);
  assert.deepEqual(lamp.points[1],{x:.5,y:-.5});
});

/* ── 细长部件（秒针/指针）：描线、校验与显示保障 ── */

test('细长描线部件（4×80 秒针）可以创建、更新并保持轮廓可见',()=>{
  const big={width:800,height:600};
  // 去程 + 回程两条近似平行边（用户沿表针两侧描画的真实笔迹）
  const stroke=[];
  const x0=400,y0=100,x1=404,y1=180;
  for(let i=0;i<=40;i++) stroke.push({x:x0+(x1-x0)*i/40,y:y0+(y1-y0)*i/40});
  for(let i=40;i>=0;i--) stroke.push({x:x0+3.5+(x1-x0-3.5)*i/40,y:y0+(y1-y0)*i/40});
  stroke.push({x:x0,y:y0});
  const part=parts.tracePart('second-hand','秒针',stroke,big);
  assert.equal(part.shape,'polygon');
  assert.ok(part.width>=3&&part.height>=80,'细针宽度 ≥3、长度保留：'+part.width+'×'+part.height);
  const outline=parts.polygon(part);
  assert.ok(outline.length>=3,'轮廓至少 3 点，SVG polygon 才会渲染');
  assert.ok(outline.every(({x,y})=>Number.isFinite(x)&&Number.isFinite(y)));
  // 旋转后轮廓仍闭合可见，且深度投影可用
  const rotated=parts.updatePart([part],'second-hand',{angle:60},big)[0];
  assert.equal(parts.polygon(rotated).length,outline.length);
  assert.ok(parts.blockFaces(rotated,0,0).length>=1,'细针也有可投影的体块面');
  // 低于 3px 仍然拒绝
  assert.throws(()=>parts.updatePart([part],'second-hand',{width:2,height:60},big),/至少为 3/);
});

/* ── 规整化：手绘轮廓吸附标准几何，节点仍可编辑 ── */

const canvas={width:800,height:600};
function polygonPart(points,name='部件'){
  return parts.createPart('reg','polygon',name,{x:400,y:300,width:200,height:200,angle:0,depth:24,z:0,points},canvas);
}

test('规整化·接近圆：识别为圆并吸附，产物仍是可拖节点',()=>{
  const jitter=Array.from({length:20},(_,i)=>{const t=i/20*Math.PI*2,r=.5+(i%3?0:.035);return{x:r*Math.cos(t),y:r*Math.sin(t)};});
  const part=polygonPart(jitter,'表盘');
  const info=parts.describeOutline(part);
  assert.equal(info.suggestion.target,'circle');
  assert.ok(info.suggestion.score>.5,'匹配度 '+info.suggestion.score);
  const result=parts.regularize(part,canvas);
  assert.equal(result.ok,true);
  assert.equal(result.target,'circle');
  assert.equal(result.part.shape,'polygon','规整后必须是 polygon，节点才可拖');
  assert.equal(result.part.points.length,16);
  assert.equal(result.part.name,'表盘','名称保留');
  // 圆：宽高应几乎相等
  assert.ok(Math.abs(result.part.width-result.part.height)<1);
});

test('规整化·椭圆与矩形：各按特征吸附',()=>{
  const ellipse=Array.from({length:24},(_,i)=>{const t=i/24*Math.PI*2;return{x:.5*Math.cos(t),y:.25*Math.sin(t)};});
  const oval=polygonPart(ellipse);
  assert.equal(parts.describeOutline(oval).suggestion.target,'ellipse');
  assert.equal(parts.regularize(oval,canvas).target,'ellipse');

  const box=[{x:-.5,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}];
  const rect=polygonPart(box);
  assert.equal(parts.describeOutline(rect).suggestion.target,'rectangle');
  const result=parts.regularize(rect,canvas);
  assert.equal(result.part.points.length,4);
});

test('规整化·自由形不强掰，可手动指定标准形',()=>{
  const star=Array.from({length:10},(_,i)=>{const t=i/10*Math.PI*2,r=i%2?.22:.5;return{x:r*Math.cos(t),y:r*Math.sin(t)};});
  const part=polygonPart(star,'星形挂件');
  const auto=parts.regularize(part,canvas);
  assert.equal(auto.ok,false);
  assert.equal(auto.reason,'freeform');
  assert.match(auto.message,/自由造型/);
  // 用户仍可显式要求圆角矩形
  const forced=parts.regularize(part,canvas,{target:'rounded'});
  assert.equal(forced.ok,true);
  assert.equal(forced.part.points.length,12,'圆角矩形 12 个可拖节点');
});

test('规整化·锁定拒绝、越界自动收进画布、角度归零',()=>{
  const jitter=Array.from({length:20},(_,i)=>{const t=i/20*Math.PI*2;return{x:.5*Math.cos(t),y:.5*Math.sin(t)};});
  const part=polygonPart(jitter);
  assert.throws(()=>parts.regularize({...part,locked:true},canvas),/已锁定/);
  // 旋转 30° 的大部件：规整后角度烘焙进点集
  const rotated={...part,angle:30,width:700,height:700};
  const result=parts.regularize(rotated,canvas);
  assert.equal(result.part.angle,0);
  const outline=parts.polygon(result.part);
  assert.ok(outline.every(({x,y})=>x>=-.01&&y>=-.01&&x<=canvas.width+.01&&y<=canvas.height+.01),'轮廓必须回到画布内');
});

test('规整化·保持可编辑：规整后拖节点仍生效',()=>{
  const jitter=Array.from({length:20},(_,i)=>{const t=i/20*Math.PI*2,r=.5+(i%2?.02:-.02);return{x:r*Math.cos(t),y:r*Math.sin(t)};});
  const part=polygonPart(jitter);
  const tidy=parts.regularize(part,canvas).part;
  const edited=parts.editNode(tidy,0,'point',{x:tidy.points[0].x*.88,y:tidy.points[0].y*.88});
  assert.equal(edited.ok,true,'规整后的节点必须能被拖动');
  assert.notEqual(edited.part.points[0].x,tidy.points[0].x);
});
