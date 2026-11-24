'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vectorize=require('./dist/vectorize.js');
const rules=require('./dist/sketch-rules.js');

const W=240,H=200;
const blank=()=>({grid:new Uint8Array(W*H),w:W,h:H});
function ellipse(ctx,cx,cy,rx,ry){
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const dx=(x-cx)/rx,dy=(y-cy)/ry;
    if(dx*dx+dy*dy<=1) ctx.grid[y*W+x]=1;
  }
}
function rect(ctx,x0,y0,x1,y1){
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) ctx.grid[y*W+x]=1;
}

test('binarize：暗像素成线、白底与透明都算背景',()=>{
  const rgba=new Uint8ClampedArray([
    255,255,255,255,   // 白
    10,10,10,255,      // 近黑
    150,150,150,255,   // 中灰：阈值 0.62 算线，阈值 0.5 算背景
    0,0,0,0            // 全透明
  ]);
  assert.deepEqual([...vectorize.binarize(rgba,4,1,0.62)],[0,1,1,0]);
  assert.deepEqual([...vectorize.binarize(rgba,4,1,0.5)],[0,1,0,0]);
});

test('components：4 连通域分组，噪点被最小像素数滤掉',()=>{
  const {grid}=blank();
  rect({grid},10,10,19,19);      // 100 像素块
  rect({grid},50,50,51,51);      // 4 像素块
  grid[100*W+100]=1;             // 单像素噪点
  const list=vectorize.components(grid,W,H,20);
  assert.equal(list.length,1);
  assert.equal(list[0].pixels.length,100);
  assert.deepEqual([list[0].minX,list[0].maxX,list[0].minY,list[0].maxY],[10,19,10,19]);
});

test('detectParts：程序生成的台灯线稿拆出 3 个部件（灯罩/支架/底座）',()=>{
  const ctx=blank();
  ellipse(ctx,120,60,60,30);   // 灯罩
  rect(ctx,113,92,127,152);    // 支架
  rect(ctx,40,162,200,180);    // 底座
  const parts=vectorize.detectParts(ctx.grid,W,H);
  assert.equal(parts.length,3,'应拆出 3 个部件');
  // 按面积从大到小：灯罩 > 底座 > 支架
  const [shade,base,stem]=parts;
  for(const part of parts){
    const check=rules.inspect({closed:true,nodes:part.points.map(p=>({point:p,in:p,out:p}))});
    assert.equal(check.ok,true,'输出轮廓必须自身合法：'+check.reason);
    assert.ok(part.points.length<=90,'节点数不超过 90');
  }
  // 外接框与绘制形状吻合（追踪沿像素外沿，允许 ±3 px）
  const near=(value,target,tolerance=3)=>Math.abs(value-target)<=tolerance;
  assert.ok(near(shade.bounds.x,60)&&near(shade.bounds.width,120)&&near(shade.bounds.height,60),
    JSON.stringify(shade.bounds));
  assert.ok(near(base.bounds.y,162)&&near(base.bounds.height,18),JSON.stringify(base.bounds));
  assert.ok(near(stem.bounds.width,14)&&near(stem.bounds.height,60),JSON.stringify(stem.bounds));
  // 面积量级合理（椭圆 π·60·30≈5655、底座 160×18≈2880、支架 14×60≈840）
  assert.ok(shade.area>5000&&shade.area<6300,'灯罩面积 '+shade.area);
  assert.ok(base.area>2500&&base.area<3300,'底座面积 '+base.area);
  assert.ok(stem.area>600&&stem.area<1100,'支架面积 '+stem.area);
});

test('detectParts：maxParts 截断与 minArea 过滤生效',()=>{
  const ctx=blank();
  ellipse(ctx,50,50,20,20);
  ellipse(ctx,120,50,18,18);
  rect(ctx,10,120,200,140);
  assert.equal(vectorize.detectParts(ctx.grid,W,H,{maxParts:2}).length,2);
  const big=vectorize.detectParts(ctx.grid,W,H,{minArea:2000});
  assert.equal(big.length,1,'只剩面积最大的底座');
});

test('接触线与一像素断口仍生成两个独立的可编辑区域',()=>{
  const ctx=blank();
  for(const [left,right] of [[20,70],[70,120]]){
    rect(ctx,left,40,right,40);rect(ctx,left,90,right,90);
    rect(ctx,left,40,left,90);rect(ctx,right,40,right,90);
  }
  ctx.grid[40*W+45]=0;
  const parts=vectorize.detectParts(ctx.grid,W,H);
  assert.equal(parts.length,2);
  assert.ok(parts.every(p=>p.bounds.width<50&&p.bounds.height<50));
});
