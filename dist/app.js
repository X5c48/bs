(() => {
'use strict';
const $ = (q, scope = document) => scope.querySelector(q);
const $$ = (q, scope = document) => [...scope.querySelectorAll(q)];
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const icons = {
  logo:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  board:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h3v3H8zm5 5h3v3h-3z"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', minus:'<path d="M5 12h14"/>',
  pen:'<path d="m4 20 4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20zm9-13 4 4"/>',
  cube:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  undo:'<path d="M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10"/>', redo:'<path d="m15 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10"/>',
  target:'<circle cx="12" cy="12" r="7"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="2"/>',
  move:'<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3"/>',
  link:'<path d="M10 13a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-2 2m3 4a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l2-2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  spark:'<path d="M11 2c1 6 3 8 9 9-6 1-8 3-9 9-1-6-3-8-9-9 6-1 8-3 9-9Zm8 12c.4 2 1 2.6 3 3-2 .4-2.6 1-3 3-.4-2-1-2.6-3-3 2-.4 2.6-1 3-3Z"/>',
  bookmark:'<path d="M6 4h12v16l-6-4-6 4z"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>'
};
function icon(name) {
  return '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+icons[name]+'</svg>';
}
$$('[data-icon]').forEach(el => {el.innerHTML = icon(el.dataset.icon);});
const forms = [
  {id:'box', code:'A01', name:'圆角盒体', note:'紧凑 · 对称', size:[140,110,76,22], color:'#87959a',material:'metal'},
  {id:'capsule', code:'A02', name:'竖向胶囊', note:'柔和 · 窄体', size:[106,144,70,32], color:'#d0b9a6',material:'fabric'},
  {id:'slope', code:'A03', name:'倾斜底座', note:'前倾 · 分体', size:[146,118,86,17], color:'#626f8f',material:'plastic'}
];
const finishes = [
  {id:'metal', name:'磨砂铝', note:'细腻金属反光'},
  {id:'fabric', name:'织物', note:'柔和低光泽'},
  {id:'plastic', name:'哑光塑料', note:'均匀漫反射'}
];
const palette = [['#87959a','银灰'],['#2f3646','墨蓝'],['#d0b9a6','沙色'],['#758b79','苔绿'],['#626f8f','雾紫']];
const defaults = () => Object.fromEntries(forms.map(f => {
  const [width,height,depth,radius] = f.size;
  return [f.id,{variant:f.id,width,height,depth,radius,color:f.color,material:f.material,light:74,buttonX:.19,buttonY:.26,lockButton:true}];
}));
const demo=new URLSearchParams(location.search).get('demo')==='1';
const key = 'wuying-preview-v1'+(demo?'-demo':'');
let saved = {};
try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
let designs = defaults();
for(const id of Object.keys(designs)){
  const prev = saved.designs?.[id]; if(!prev) continue;
  for(const k of ['width','height','depth','radius','light','buttonX','buttonY']) if(Number.isFinite(prev[k])) designs[id][k]=prev[k];
  if(typeof prev.color==='string' && /^#[0-9a-f]{6}$/i.test(prev.color)) designs[id].color=prev.color;
  if(finishes.some(m=>m.id===prev.material)) designs[id].material=prev.material;
  if(typeof prev.lockButton==='boolean') designs[id].lockButton=prev.lockButton;
}
let active = Object.hasOwn(designs,saved.active) ? saved.active : 'box';
let prefs = Array.isArray(saved.prefs) ? saved.prefs.filter(m=>finishes.some(f=>f.id===m)) : [];
let reference = /^data:image\//.test(saved.reference?.src || '') ? saved.reference : {src:'assets/reference.jpg',name:'工业造型研究'};
let view = 'model', panel = 'derive', rotation = -24, tilt = -14, zoom = 1;
let before = [], after = [], frame = 0, toastTimer = 0, saveTimer = 0;
const model = $('#model'), sketch = $('#sketch'), stage = $('#stage');
const current = () => designs[active];
const selected = () => forms.find(f => f.id === active);
const snapshot = () => JSON.stringify({active,designs});
const ranges = [
  {key:'width',name:'宽度',min:100,max:190,unit:'mm'}, {key:'height',name:'高度',min:80,max:150,unit:'mm'},
  {key:'depth',name:'深度',min:50,max:115,unit:'mm'}, {key:'radius',name:'圆角',min:6,max:32,unit:'mm'}
];
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(key, JSON.stringify({active,designs,prefs,reference})); $('#saveText').textContent = '自动保存在此浏览器'; }
    catch { $('#saveText').textContent = '当前浏览器无法保存'; }
  }, 120);
}
function toast(message) {
  clearTimeout(toastTimer);
  const el=$('#toast'); el.textContent=message; el.hidden=false;
  toastTimer=setTimeout(()=>{el.hidden=true;},2400);
}
function record(start) {
  if(start===snapshot()) return;
  before.push(start);
  if(before.length>60) before.shift();
  after=[];
  $('#summary').hidden=true;
  refresh();
}
function change(action) { const start=snapshot(); action(); record(start); }
function restore(raw) {
  const prev=JSON.parse(raw); active=prev.active; designs=prev.designs; $('#summary').hidden=true; refresh();
}
$('#undo').onclick=()=>{if(!before.length)return;after.push(snapshot());restore(before.pop());};
$('#redo').onclick=()=>{if(!after.length)return;before.push(snapshot());restore(after.pop());};
document.addEventListener('keydown',e=>{
  if(view==='board'||!(e.ctrlKey||e.metaKey)||e.key.toLowerCase()!=='z'||e.target.matches('input,textarea'))return;
  e.preventDefault();
  (e.shiftKey ? $('#redo') : $('#undo')).click();
});
function outlinePath(x,y,w,h,r,kind) {
  if(kind!=='slope') return 'M'+(x+r)+' '+y+'H'+(x+w-r)+'Q'+(x+w)+' '+y+' '+(x+w)+' '+(y+r)+'V'+(y+h-r)+'Q'+(x+w)+' '+(y+h)+' '+(x+w-r)+' '+(y+h)+'H'+(x+r)+'Q'+x+' '+(y+h)+' '+x+' '+(y+h-r)+'V'+(y+r)+'Q'+x+' '+y+' '+(x+r)+' '+y+'Z';
  const shift=w*.13;
  return 'M'+(x+shift+r)+' '+y+'H'+(x+w-r)+'Q'+(x+w)+' '+y+' '+(x+w-1)+' '+(y+r)+'L'+(x+w-shift)+' '+(y+h-r)+'Q'+(x+w-shift-3)+' '+(y+h)+' '+(x+w-shift-r)+' '+(y+h)+'H'+(x+r)+'Q'+x+' '+(y+h)+' '+(x+3)+' '+(y+h-r)+'L'+(x+shift)+' '+(y+r)+'Q'+(x+shift+4)+' '+y+' '+(x+shift+r)+' '+y+'Z';
}
function thumb(f) {
  const capsule=f.id==='capsule', w=capsule?29:46, h=capsule?43:33, x=34-w/2, y=25-h/2, r=capsule?12:7;
  return '<svg viewBox="0 0 68 50" width="68" height="50" aria-hidden="true"><path d="'+outlinePath(x,y,w,h,r,f.id)+'" fill="'+f.color+'" fill-opacity=".21" stroke="'+f.color+'" stroke-width="1.35"/><rect x="'+(x+6)+'" y="'+(y+5)+'" width="'+(w-12)+'" height="'+(h*.51)+'" rx="5" fill="'+f.color+'" fill-opacity=".42"/><circle cx="'+(34+w*.19)+'" cy="'+(25+h*.26)+'" r="2.1" fill="'+f.color+'"/></svg>';
}
$('#variants').innerHTML = forms.map(f=>'<button class="variant-card" data-variant="'+f.id+'" aria-pressed="false"><span class="variant-thumb">'+thumb(f)+'</span><span class="variant-info"><small>'+f.code+'</small><strong>'+f.name+'</strong><span>'+f.note+'</span></span><span class="variant-check">'+icon('check')+'</span></button>').join('');
$$('[data-variant]').forEach(el=>{el.onclick=()=>change(()=>{active=el.dataset.variant;});});
function rangeHTML({key:k,name,min,max,unit}) {
  return '<div class="range-row"><div class="range-label"><label for="range-'+k+'">'+name+'</label><span class="range-number"><input id="value-'+k+'" aria-label="'+name+'数值" type="number" min="'+min+'" max="'+max+'" step="1"><span>'+unit+'</span></span></div><input type="range" id="range-'+k+'" min="'+min+'" max="'+max+'" step="1"></div>';
}
$('#shapeRanges').innerHTML=ranges.map(rangeHTML).join('');
const lightSpec={key:'light',name:'光照强度',min:10,max:100,unit:'%'};
$('#lightRange').innerHTML=rangeHTML(lightSpec);
function setParam(k, value) {
  const s=current(), spec=[...ranges,lightSpec].find(x=>x.key===k), next=clamp(Math.round(value),spec.min,spec.max);
  if(k==='width'&&s.lockButton) s.buttonX=s.buttonX*s.width/next;
  if(k==='height'&&s.lockButton) s.buttonY=s.buttonY*s.height/next;
  s[k]=next;
}
for(const {key:k} of [...ranges,lightSpec]){
  const range=$('#range-'+k), number=$('#value-'+k);
  let start;
  const begin=()=>{if(start===undefined)start=snapshot();};
  range.addEventListener('pointerdown',begin);
  range.addEventListener('keydown',begin);
  range.addEventListener('input',()=>{begin();setParam(k,+range.value);refresh();});
  range.addEventListener('change',()=>{if(start!==undefined)record(start);start=undefined;});
  number.addEventListener('change',()=>{change(()=>{setParam(k,number.value===''?current()[k]:+number.value);});refresh();});
  number.addEventListener('keydown',e=>{if(e.key==='Enter')number.blur();});
}
$('#lockButton').onchange=e=>change(()=>{current().lockButton=e.target.checked;});
$('#materials').innerHTML=finishes.map(f=>'<button class="material-option" data-material="'+f.id+'" aria-pressed="false"><span class="material-sample sample-'+f.id+'"></span><span><strong>'+f.name+'</strong><small>'+f.note+'</small></span></button>').join('');
$$('[data-material]').forEach(el=>{el.onclick=()=>{change(()=>{current().material=el.dataset.material;});setView('model');};});
$('#swatches').innerHTML=palette.map(([c,n])=>'<button class="swatch" data-color="'+c+'" aria-label="'+n+'" title="'+n+'" aria-pressed="false" style="--swatch:'+c+'">'+icon('check')+'</button>').join('');
$$('[data-color]').forEach(el=>{el.onclick=()=>{change(()=>{current().color=el.dataset.color;});setView('model');};});
function setView(next) {
  view=next;
  model.hidden=next!=='model'; sketch.toggleAttribute('hidden',next!=='sketch');
  stage.dataset.view=next;
  if(next==='board')board?.show();else board?.hide();
  $('#undo').hidden=$('#redo').hidden=next==='board';
  $('.toolbar-divider').hidden=next==='board';
  $('#linkState').textContent=next==='board'?'草图 / 参考 / 出图':'二维 / 三维联动';
  updateExportLabel();
  $('#zoomReset').textContent=Math.round((next==='board'&&board?board.getZoom():zoom)*100)+'%';
  $('#stageKicker').textContent=next==='board'?'WORKBENCH':next==='model'?'PERSPECTIVE':'ORTHOGRAPHIC / FRONT';
  $('#stageHint').textContent=next==='model'?'拖动旋转 · 滚轮缩放':'拖动控制点编辑轮廓';
  $$('.segmented [data-view]').forEach(el=>{const is=el.dataset.view===next;el.classList.toggle('is-active',is);el.setAttribute('aria-pressed',is);});
  requestDraw();
  window.dispatchEvent(new Event('sketchstatechange'));
}
const panelTitles={derive:'调整草稿',generate:'渲染出图',shape:'模板尺寸',finish:'材质与灯光',assistant:'方案记录'};
function setPanel(next){
  if(next!=='derive'&&board?.sketchState().tool==='redraw')board.setTool('select');
  panel=next;
  $('.app-shell').dataset.panel=panel;
  $('#inspectorTitle').textContent=panelTitles[panel];
  $$('[data-panel]').forEach(t=>{
    const is=t.dataset.panel===panel;
    t.classList.toggle('is-active',is);t.setAttribute('aria-selected',is);t.tabIndex=is?0:-1;
  });
  $$('.inspector .panel').forEach(p=>{p.hidden=p.id!=='panel-'+panel;});
  if(panel==='finish')setView('model');
  else if(panel==='shape')setView('sketch');
  else if((panel==='derive'||panel==='generate')&&board)setView('board');
  else window.dispatchEvent(new Event('sketchstatechange'));
}
function updateExportLabel(){
  $('#export span').textContent=view==='board'
    ? (boardSelection?.type==='curve'?'导出 SVG':'导出选中')
    : '导出视图';
}
$$('.segmented [data-view]').forEach(el=>{el.onclick=()=>{
  const next=el.dataset.view;
  setPanel(next==='board'?'derive':next==='model'?'finish':'shape');
};});
$$('[data-panel]').forEach(el=>{el.onclick=()=>setPanel(el.dataset.panel);});
$('.inspector-tabs').addEventListener('keydown',e=>{
  const tabs=$$('[data-panel]'),index=tabs.indexOf(e.target);
  if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:
    (index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[next].click();tabs[next].focus();e.preventDefault();
});
function setZoom(next) {
  zoom=Math.round(clamp(next,.6,1.55)*100)/100;
  stage.style.setProperty('--view-zoom',zoom);
  $('#zoomReset').textContent=Math.round(zoom*100)+'%';
}
$('#zoomIn').onclick=()=>view==='board'&&board?board.zoom(.1):setZoom(zoom+.1);
$('#zoomOut').onclick=()=>view==='board'&&board?board.zoom(-.1):setZoom(zoom-.1);
$('#zoomReset').onclick=()=>view==='board'&&board?board.zoomReset():setZoom(1);
$('#resetView').onclick=()=>{if(view==='board'){board?.resetView();toast('画布视角已重置');return;}rotation=-24;tilt=-14;setZoom(1);requestDraw();toast('视角已重置');};
stage.addEventListener('wheel',e=>{if(view!=='model'||window.innerWidth<760)return;e.preventDefault();setZoom(zoom+(e.deltaY<0?.06:-.06));},{passive:false});
let orbit;
model.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;
  model.setPointerCapture(e.pointerId); orbit={x:e.clientX,y:e.clientY};
  stage.classList.add('is-dragging');
});
model.addEventListener('pointermove',e=>{
  if(!orbit)return;
  rotation=(rotation+(e.clientX-orbit.x)*.46)%360;
  tilt=clamp(tilt+(e.clientY-orbit.y)*.31,-60,55);
  orbit={x:e.clientX,y:e.clientY};requestDraw();
});
['pointerup','pointercancel','lostpointercapture'].forEach(type=>model.addEventListener(type,()=>{orbit=null;stage.classList.remove('is-dragging');}));
model.addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();
  if(e.key==='ArrowLeft')rotation-=8;
  if(e.key==='ArrowRight')rotation+=8;
  if(e.key==='ArrowUp')tilt=clamp(tilt-6,-60,55);
  if(e.key==='ArrowDown')tilt=clamp(tilt+6,-60,55);
  requestDraw();
});
const CX=360,CY=275,SCALE=2.12;
const drawingScope = new window.paper.PaperScope();
drawingScope.setup(new drawingScope.Size(1,1));
function vectorProfile(x,y,w,h,r,variant) {
  const path = new drawingScope.Path({pathData:outlinePath(x,y,w,h,r,variant),insert:false});
  return path.getPathData(null,3);
}
function drawSketch() {
  const s=current(), w=s.width*SCALE,h=s.height*SCALE,x=CX-w/2,y=CY-h/2;
  const r=Math.min(s.variant==='capsule'?w*.45:s.radius*SCALE,w*.45,h*.45);
  const gx=x+w*.12,gy=y+h*.11,gw=w*.76,gh=h*.50;
  const bx=CX+s.buttonX*w,by=CY+s.buttonY*h;
  sketch.innerHTML='<defs><pattern id="mesh-pattern" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r=".8" fill="#8791a8"/></pattern></defs>'+
   '<g fill="none" stroke="#b1b8c9" stroke-width="1" stroke-dasharray="6 6"><path d="M'+(x-40)+' '+CY+'H'+(x+w+40)+'M'+CX+' '+(y-35)+'V'+(y+h+37)+'"/></g>'+
   '<path d="'+vectorProfile(x,y,w,h,r,s.variant)+'" fill="#f9fafe" stroke="#33386f" stroke-width="2.5"/>'+
   '<rect x="'+gx+'" y="'+gy+'" width="'+gw+'" height="'+gh+'" rx="'+Math.min(r*.55,33)+'" fill="url(#mesh-pattern)" stroke="#8189a9" stroke-width="1.5"/>'+
   '<circle cx="'+bx+'" cy="'+by+'" r="14" fill="#e8eaff" stroke="#514eea" stroke-width="2"/><path d="M'+bx+' '+(by-7)+'v6" stroke="#514eea" stroke-width="2"/>'+
   '<g stroke="#666f9a" stroke-width="1" fill="none"><path d="M'+x+' '+(y+h+20)+'v18M'+(x+w)+' '+(y+h+20)+'v18M'+x+' '+(y+h+30)+'H'+(x+w)+'M'+(x-26)+' '+y+'h18m-9 0v'+h+'M'+(x-26)+' '+(y+h)+'h18"/></g>'+
   '<g font-family="system-ui, sans-serif" font-size="13" fill="#434870" text-anchor="middle"><text x="'+CX+'" y="'+(y+h+50)+'">'+s.width+' mm</text><text x="'+(x-37)+'" y="'+CY+'" transform="rotate(-90 '+(x-37)+' '+CY+')">'+s.height+' mm</text></g>'+
   handle('width',x+w,CY,'拖动调整宽度')+handle('height',CX,y,'拖动调整高度')+
   (s.lockButton?'<text x="'+bx+'" y="'+(by+34)+'" font-family="system-ui" font-size="11" text-anchor="middle" fill="#5d6281">已锁定</text>':handle('button',bx,by,'拖动移动旋钮'));
}
function handle(kind,x,y,label) {
  return '<circle class="sketch-handle" data-handle="'+kind+'" cx="'+x+'" cy="'+y+'" r="8" fill="#fff" stroke="#514eea" stroke-width="2.3" tabindex="0" role="button" aria-label="'+label+'" style="cursor:'+(kind==='width'?'ew-resize':kind==='height'?'ns-resize':'move')+'"><title>'+label+'</title></circle>';
}
let edit;
sketch.addEventListener('pointerdown',e=>{
  const h=e.target.closest('[data-handle]');
  if(!h)return;
  e.preventDefault();
  sketch.setPointerCapture(e.pointerId);edit={key:h.dataset.handle,start:snapshot()};
});
sketch.addEventListener('pointermove',e=>{
  if(!edit)return;
  const pt=sketch.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;
  const ctm=sketch.getScreenCTM();if(!ctm)return;
  const p=pt.matrixTransform(ctm.inverse());
  if(edit.key==='width')setParam('width',2*Math.abs(p.x-CX)/SCALE);
  if(edit.key==='height')setParam('height',2*Math.abs(p.y-CY)/SCALE);
  if(edit.key==='button'&&!current().lockButton){
    current().buttonX=clamp((p.x-CX)/(current().width*SCALE),-.32,.32);
    current().buttonY=clamp((p.y-CY)/(current().height*SCALE),.18,.35);
  }
  refresh();
});
['pointerup','pointercancel','lostpointercapture'].forEach(type=>sketch.addEventListener(type,()=>{if(edit){const s=edit.start;edit=null;record(s);}}));
sketch.addEventListener('keydown',e=>{
  const kind=e.target.dataset.handle;
  if(!kind||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
  e.preventDefault();
  const step=e.shiftKey?5:1;
  change(()=>{
    if(kind==='width')setParam('width',current().width+(['ArrowLeft','ArrowDown'].includes(e.key)?-step:step));
    if(kind==='height')setParam('height',current().height+(['ArrowDown','ArrowLeft'].includes(e.key)?-step:step));
    if(kind==='button'){const s=current();s.buttonX=clamp(s.buttonX+(e.key==='ArrowLeft'?-.01:e.key==='ArrowRight'?.01:0)*step,-.32,.32);s.buttonY=clamp(s.buttonY+(e.key==='ArrowUp'?-.01:e.key==='ArrowDown'?.01:0)*step,.18,.35);}
  });
  requestAnimationFrame(()=>sketch.querySelector('[data-handle="'+kind+'"]')?.focus());
});
function requestDraw() {
  if(frame)return;
  frame=requestAnimationFrame(()=>{
    frame=0;
    if(view==='model')window.WuyingRenderer?.draw(model,{...current(),rotation,tilt});
    else if(view==='sketch')drawSketch();
  });
}
function refresh() {
  const s=current(),f=selected();
  $$('[data-variant]').forEach(el=>{const is=el.dataset.variant===active;el.classList.toggle('is-active',is);el.setAttribute('aria-pressed',is);});
  $$('[data-material]').forEach(el=>{const is=el.dataset.material===s.material;el.classList.toggle('is-active',is);el.setAttribute('aria-pressed',is);});
  $$('[data-color]').forEach(el=>{const is=el.dataset.color===s.color;el.classList.toggle('is-active',is);el.setAttribute('aria-pressed',is);});
  for(const {key:k,min,max} of [...ranges,lightSpec]){
    const range=$('#range-'+k);range.value=s[k];range.style.setProperty('--percent',((s[k]-min)/(max-min)*100)+'%');
    $('#value-'+k).value=s[k];
  }
  $('#stageTitle').textContent=f.code+' / '+f.name;
  $('#dimensionReadout').textContent=s.width+' × '+s.height+' × '+s.depth+' mm';
  $('#lockButton').checked=s.lockButton;
  $('#constraintNote').textContent=s.lockButton?'旋钮相对主体中心的坐标已锁定。':'切换到二维草图，拖动旋钮调整位置。';
  $('#undo').disabled=!before.length;$('#redo').disabled=!after.length;
  requestDraw();save();
}
function renderPrefs() {
  const container=$('#preferences');container.replaceChildren();
  if(!prefs.length){const p=document.createElement('p');p.textContent='还没有保存偏好。';p.className='muted';container.append(p);return;}
  for(const id of prefs){
    const entry=document.createElement('div'), label=document.createElement('span'), del=document.createElement('button');
    entry.className='preference-row';label.textContent=finishes.find(f=>f.id===id).name;
    del.type='button';del.className='icon-btn';del.setAttribute('aria-label','删除'+label.textContent+'偏好');del.innerHTML=icon('close');
    del.onclick=()=>{prefs=prefs.filter(m=>m!==id);renderPrefs();save();toast('偏好已移除');};
    entry.append(label,del);container.append(entry);
  }
}
$('#summarize').onclick=()=>{
  const s=current(),f=selected(),m=finishes.find(v=>v.id===s.material), summary=$('#summary');
  summary.replaceChildren();
  const title=document.createElement('strong');title.textContent=f.code+' · '+f.name;
  const p=document.createElement('p');p.textContent='主体 '+s.width+' × '+s.height+' × '+s.depth+' mm，圆角 '+s.radius+' mm。外壳采用'+m.name+'，灯光强度 '+s.light+'%。';
  const q=document.createElement('p');q.textContent=s.lockButton?'旋钮位置锁定，可继续比较主体宽度。':'旋钮允许移动，可在二维视图调整部件布局。';
  summary.append(title,p,q);summary.hidden=false;
};
$('#remember').onclick=()=>{
  const m=current().material;
  if(prefs.includes(m)){toast('这项材质已在偏好中');return;}
  prefs.push(m);renderPrefs();save();toast('已保存材质偏好');
};
function showReference(){
  $('#referenceThumb').src=reference.src;$('#referenceName').textContent=reference.name;
  $('#dialogImage').src=reference.src;
  $('#referenceCredit').textContent=reference.src.startsWith('data:')?'你添加的参考图片':'桌面音箱造型参考 · 概念示意';
}
const dialog=$('#referenceDialog');
$('#openReference').onclick=()=>{showReference();dialog.showModal();};
$('#closeReference').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
$('#addReference').onclick=()=>$('#referenceInput').click();
$('#referenceInput').onchange=e=>{
  const file=e.target.files?.[0];e.target.value='';
  if(!file)return;
  if(file.size>20*1024*1024){toast('请选择 20 MB 以内的图片');return;}
  const source=URL.createObjectURL(file), image=new Image();
  image.onload=()=>{
    const c=document.createElement('canvas'), r=Math.min(1,900/Math.max(image.naturalWidth,image.naturalHeight));
    c.width=Math.max(1,Math.round(image.naturalWidth*r));c.height=Math.max(1,Math.round(image.naturalHeight*r));
    c.getContext('2d').drawImage(image,0,0,c.width,c.height);
    reference={src:c.toDataURL('image/jpeg',.82),name:file.name};URL.revokeObjectURL(source);showReference();save();toast('参考图片已加入');
  };
  image.onerror=()=>{URL.revokeObjectURL(source);toast('无法打开这张图片');};
  image.src=source;
};
function download(blob,name){
  const url=URL.createObjectURL(blob), link=document.createElement('a');link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
$('#export').onclick=async()=>{
  const code='物映-'+selected().code;
  if(view==='board'&&board){
    try{
      const blob=await board.exportSelected();
      const vector=blob.type.startsWith('image/svg+xml');
      download(blob,vector?'物映-'+boardSelection.title+'.svg':'物映-画布.png');
      toast(vector?'已导出可编辑 SVG':'已导出画布对象');
    }catch(e){toast(e.message||'无法导出画布对象');}
    return;
  }
  if(view==='sketch'){
    drawSketch();
    download(new Blob([new XMLSerializer().serializeToString(sketch)],{type:'image/svg+xml;charset=utf-8'}),code+'-草图.svg');
    toast('已导出二维草图');return;
  }
  if(!window.WuyingRenderer){toast('三维视图暂不可导出');return;}
  window.WuyingRenderer.draw(model,{...current(),rotation,tilt});
  const canvas=document.createElement('canvas');canvas.width=model.width;canvas.height=model.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#edf0f6';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(model,0,0);
  canvas.toBlob(blob=>{if(blob){download(blob,code+'-三维预览.png');toast('已导出三维预览');}},'image/png');
};
new ResizeObserver(requestDraw).observe(stage);
const currentControlSvg = () => {
  const s=current(), w=s.width*SCALE,h=s.height*SCALE,x=CX-w/2,y=CY-h/2;
  const r=Math.min(s.variant==='capsule'?w*.45:s.radius*SCALE,w*.45,h*.45);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="570" viewBox="0 0 720 570"><rect width="720" height="570" fill="white"/><g fill="none" stroke="black" stroke-width="5" stroke-linejoin="round"><path d="'+vectorProfile(x,y,w,h,r,s.variant)+'"/><rect x="'+(x+w*.12)+'" y="'+(y+h*.11)+'" width="'+(w*.76)+'" height="'+(h*.50)+'" rx="'+Math.min(r*.55,33)+'"/><circle cx="'+(CX+s.buttonX*w)+'" cy="'+(CY+s.buttonY*h)+'" r="14"/></g></svg>';
};
let boardSelection=null;
const board = window.WuyingBoard?.mount($('#freeBoard'),{
  getSketch:currentControlSvg,onToast:toast,demo,
  onZoom(scale){$('#zoomReset').textContent=Math.round(scale*100)+'%';},
  onSelection(selection){
    boardSelection=selection;
    $('#controlSource').textContent=selection?.title || '当前方案草图';
    updateExportLabel();
    window.dispatchEvent(new Event('controlsourcechange'));
    window.dispatchEvent(new Event('sketchstatechange'));
  }
});
window.WuyingWorkbench={board,showBoard:()=>setView('board'),getCurrentSketch:currentControlSvg,setPanel,demo};
showReference();renderPrefs();setPanel(board?'derive':'finish');refresh();
})();
