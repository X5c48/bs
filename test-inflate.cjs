const test=require('node:test'), assert=require('node:assert'), fs=require('fs'), vm=require('vm');
function load(){const window={};vm.runInContext(fs.readFileSync(__dirname+'/dist/inflate-mesh.js','utf8'),vm.createContext({window}));return window.WuyingInflate;}
// 画布：白底上一个深色圆 + 一个小噪点，或透明底
function image(w,h,paint,bg=[255,255,255,255]){const d=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)d.set(bg,i*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=paint(x,y);if(c)d.set(c,(y*w+x)*4);}return d;}
const disc=(cx,cy,r,c)=>(x,y)=>(x-cx)**2+(y-cy)**2<=r*r?c:null;

test('inflate: white background picks the largest subject, mesh is closed and meets at z=0 on the rim',()=>{
  const I=load();
  const paint=(x,y)=>disc(100,80,50,[40,60,90,255])(x,y)||disc(185,10,4,[0,0,0,255])(x,y);
  const m=I.build(image(200,160,paint),200,160,{grid:64,thickness:.6});
  assert.equal(m.stats.mode,'background');
  assert.ok(I.isClosed(m.indices),'网格闭合');
  const zs=[];for(let i=2;i<m.positions.length;i+=3)zs.push(m.positions[i]);
  assert.ok(Math.max(...zs)>0&&Math.min(...zs)<0,'正背两面');
  assert.ok(Math.abs(Math.max(...zs)+Math.min(...zs))<1e-6,'正背对称');
  // 噪点被丢弃：所有顶点都在大圆附近（右上角 x>0.4 y>0.3 无顶点）
  assert.ok(![...Array(m.positions.length/3).keys()].some(i=>m.positions[i*3]>.4&&m.positions[i*3+1]>.3),'只保留最大连通域');
  assert.ok(Math.abs(m.stats.coverage-Math.PI*2500/32000)<.02);
});

test('inflate: transparent image uses alpha, thickness scales depth, holes inside the subject are filled',()=>{
  const I=load();
  const ring=(x,y)=>{const r=Math.hypot(x-60,y-60);return r<=50?(r<12?[255,255,255,255]:[200,30,30,255]):null;};
  const data=image(120,120,ring,[0,0,0,0]);
  const thin=I.build(data,120,120,{grid:48,thickness:.2}), thick=I.build(data,120,120,{grid:48,thickness:1});
  assert.equal(thin.stats.mode,'alpha');
  assert.ok(thick.size.depth>thin.size.depth*4,'厚度滑块改变深度');
  assert.ok(I.isClosed(thick.indices));
  assert.ok(Math.abs(thick.stats.coverage-Math.PI*2500/14400)<.02,'中间白洞被填上');
});

test('inflate: diagonal pinches stay manifold; empty or full images give clear errors',()=>{
  const I=load();
  const checker=(x,y)=>((x>>3)+(y>>3))%2===0&&x<64&&y<64&&x>=16&&y>=16?[0,0,0,255]:null;
  const m=I.build(image(80,80,(x,y)=>checker(x,y)||((x>=16&&x<64&&y>=16&&y<64&&((x>>3)+(y>>3))%2)?null:null)),80,80,{grid:80});
  assert.ok(I.isClosed(m.indices),'棋盘对角相连也闭合');
  assert.throws(()=>I.build(image(50,50,()=>null),50,50),/没有找到主体/);
  assert.throws(()=>I.build(image(200,200,(x,y)=>x>0&&y>0&&x<199&&y<199?[0,0,0,255]:null),200,200),/铺满/);
});
