// 角度球映射与控件纯函数测试。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function load(){
  const window={};
  const context=vm.createContext({window});
  vm.runInContext(fs.readFileSync(__dirname+'/dist/angle-sphere.js','utf8'),context);
  return window.WuyingAngleSphere;
}

const sphere=load();

test('水平方位角映射到最近的 8 方位预设',()=>{
  assert.equal(sphere.mapToView(0,0).view,'front');
  assert.equal(sphere.mapToView(350,0).view,'front');
  assert.equal(sphere.mapToView(46,0).view,'front-right');
  assert.equal(sphere.mapToView(95,0).view,'right');
  assert.equal(sphere.mapToView(180,0).view,'rear');
  assert.equal(sphere.mapToView(270,0).view,'left');
  assert.equal(sphere.mapToView(-90,0).view,'left');
});

test('俯仰分档：顶视 / 底视 / 前上方，后方 ignores 俯仰',()=>{
  assert.equal(sphere.mapToView(0,70).view,'top');
  assert.equal(sphere.mapToView(90,70).view,'top');
  assert.equal(sphere.mapToView(0,-70).view,'bottom');
  assert.equal(sphere.mapToView(0,40).view,'elevated');
  assert.equal(sphere.mapToView(45,40).view,'elevated');
  // 后向 25–55° 不用「前上方」，回落到水平方位
  assert.equal(sphere.mapToView(180,40).view,'rear');
  assert.equal(sphere.mapToView(270,40).view,'left');
  // 25° 以内按水平方位
  assert.equal(sphere.mapToView(0,20).view,'front');
  assert.equal(sphere.mapToView(0,-20).view,'front');
});

test('normalize 收敛非法输入并规范角度',()=>{
  assert.deepEqual({...sphere.normalize({azimuth:400,elevation:120})},{azimuth:40,elevation:85});
  assert.deepEqual({...sphere.normalize({azimuth:-30,elevation:-120})},{azimuth:330,elevation:-85});
  assert.deepEqual({...sphere.normalize({})},{azimuth:0,elevation:0});
  assert.deepEqual({...sphere.normalize({azimuth:'x',elevation:null})},{azimuth:0,elevation:0});
});

test('把手投影：右视在右、俯视在上、仰视在下',()=>{
  const size=200,c=size/2;
  const right=sphere.handlePoint(90,0,size);
  assert.ok(Math.abs(right.y-c)<1e-6,'右视 y 居中');
  assert.ok(right.x>c+size*.2,'右视把手在右半边');
  const top=sphere.handlePoint(0,85,size);
  assert.ok(top.y<c,'俯视把手在上半');
  const bottom=sphere.handlePoint(0,-85,size);
  assert.ok(bottom.y>c,'仰视把手在下半');
});

test('朝向深度：正视最亮、后视最暗，用于区分重合投影',()=>{
  assert.ok(Math.abs(sphere.facing(0,0)-1)<1e-6,'正视深度 1');
  assert.ok(Math.abs(sphere.facing(180,0)+1)<1e-6,'后视深度 -1');
  assert.ok(Math.abs(sphere.facing(90,0))<1e-6,'侧视深度 0');
});

test('保留映射的方位与角度，供 UI 显示与提示词使用',()=>{
  const mapped=sphere.mapToView(315,10);
  assert.equal(mapped.view,'front-left');
  assert.equal(mapped.direction,'front-left');
  assert.equal(mapped.azimuth,315);
  assert.equal(mapped.elevation,10);
});
