(() => {
'use strict';
const ns='http://www.w3.org/2000/svg';
const rules=window.WuyingSketchRules, studio=window.WuyingStudioCore;
const STORE='wuying-free-board-v2';
const BASE_TITLES={shoe:'鞋型概念 01',rounded:'圆润轮廓',rectilinear:'方正轮廓',tapered:'楔形轮廓'};
const MAX_ITEMS=24;
const icon={
 select:'<path d="m5 3 15 9-7 1.5L9 20z"/>',
 brush:'<path d="m14 5 5 5M5 19l4.5-1L20 7.5l-3.5-3.5L6 14.5 5 19Z"/>',
 erase:'<path d="m7 19-4-4a2 2 0 0 1 0-2.8L12 3a2 2 0 0 1 2.8 0L21 9a2 2 0 0 1 0 2.8L14 19H7Zm0-10 9 9m-2 1h8"/>',
 redraw:'<path d="m14 5 5 5M5 19l4.5-1L20 7.5l-3.5-3.5L6 14.5 5 19Zm3 0c3 2 7 2 11-1"/>',
 pen:'<path d="m5 18 3-8 8-7 5 5-7 8-9 2Zm3-8 6 6M5 18l5-5"/>',
 pan:'<path d="M7 13V7a1.4 1.4 0 0 1 2.8 0v4-6a1.4 1.4 0 0 1 2.8 0v6-4.5a1.4 1.4 0 0 1 2.8 0v5-2.5a1.4 1.4 0 0 1 2.8 0v5c0 4-2.4 6-5.5 6H12c-2.2 0-3.8-1-5-3l-2-3.2a1.6 1.6 0 0 1 2.7-1.6l1.3 1.9"/>',
 sketch:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6m-6 4h6m-6 4h4"/>',
 image:'<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4"/><path d="m5 17 4-4 3 3 3-5 4 5"/>',
 delete:'<path d="M5 7h14m-12 0 1 13h8l1-13M9 7V4h6v3m-5 3v7m4-7v7"/>'
};
const svgIcon=n=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'+icon[n]+'</svg>';
const tools=[['select','选点','V'],['brush','画笔','B'],['erase','橡皮','E'],['pen','钢笔','P'],['redraw','手绘改线','R'],['pan','抓手','H']];
const actions=[['sketch','加入草图'],['image','添加图片'],['delete','删除对象']];
const limit=(n,min,max)=>Math.min(max,Math.max(min,n));
const copy=pt=>({x:pt.x,y:pt.y});
const svgUri=source=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(source);
const uid=()=>globalThis.crypto?.randomUUID?.()??String(Date.now())+'-'+Math.random().toString(36).slice(2);
const svgEl=(name,attributes={})=>{const element=document.createElementNS(ns,name);for(const [k,v] of Object.entries(attributes))element.setAttribute(k,v);return element;};
const curveData=rules.pathData;
function validSource(src){
 return typeof src==='string'&&src.length<2500000&&/^(?:blob:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml)[;,]|assets\/[A-Za-z0-9_.-]+$)/i.test(src);
}
function fitImage(ctx,image,w,h,padding){
 const ratio=Math.min((w-padding*2)/image.naturalWidth,(h-padding*2)/image.naturalHeight);
 const dw=image.naturalWidth*ratio,dh=image.naturalHeight*ratio;
 ctx.drawImage(image,(w-dw)/2,(h-dh)/2,dw,dh);
}
function imageFrom(src){
 return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('无法读取选中的图片'));img.src=src;});
}
function png(canvas){
 return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成控形图片')),'image/png'));
}
async function persistableImage(src){
 const img=await imageFrom(src);const ratio=Math.min(1,1080/Math.max(img.naturalWidth,img.naturalHeight));
 const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*ratio));c.height=Math.max(1,Math.round(img.naturalHeight*ratio));
 const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);
 return c.toDataURL('image/jpeg',.85);
}
function transformPixels(ctx,width,height,edges){
 const frame=ctx.getImageData(0,0,width,height), pixels=frame.data, gray=new Uint8Array(width*height);
 for(let i=0;i<gray.length;i++)gray[i]=.299*pixels[i*4]+.587*pixels[i*4+1]+.114*pixels[i*4+2];
 for(let i=0;i<gray.length;i++){
   let dark=gray[i]<166;
   if(edges){
     const x=i%width,y=Math.floor(i/width);
     if(x===0||x===width-1||y===0||y===height-1)dark=false;
     else{
       const a=gray[i-width-1],b=gray[i-width],c=gray[i-width+1],d=gray[i-1],f=gray[i+1],g=gray[i+width-1],h=gray[i+width],j=gray[i+width+1];
       const gx=(c+2*f+j)-(a+2*d+g),gy=(g+2*h+j)-(a+2*b+c);
       dark=gx*gx+gy*gy>8100;
     }
   }
   const value=dark?0:255;pixels[i*4]=value;pixels[i*4+1]=value;pixels[i*4+2]=value;pixels[i*4+3]=255;
 }
 ctx.putImageData(frame,0,0);
}
function mount(root,{getSketch,onToast=()=>{},onSelection=()=>{},onZoom=()=>{},onScene=()=>{},toolSlot,isolated=false,demo=false}={}){
 const storageKey=STORE+(demo?'-demo':'');
 root.classList.add('wb-board');
 root.setAttribute('tabindex','0');
 root.setAttribute('aria-label','自由设计画布');
 root.innerHTML='<div class="wb-viewport"><div class="wb-world"><svg class="wb-svg" aria-label="矢量曲线"></svg><div class="wb-cards"></div></div></div>'+
 '<div class="wb-toolbar" role="toolbar" aria-label="自由画布工具">'+tools.map(([id,name,key])=>'<button type="button" data-board-tool="'+id+'" aria-pressed="false" title="'+name+' ('+key+')" aria-label="'+name+'">'+svgIcon(id)+'<span>'+name+'</span></button>').join('')+
 '<span class="wb-toolbar-divider"></span>'+actions.map(([id,name])=>'<button type="button" data-board-action="'+id+'" title="'+name+'" aria-label="'+name+'">'+svgIcon(id)+'<span>'+name+'</span></button>').join('')+'</div>'+
 '<div class="wb-curve-actions" hidden><button type="button" data-board-action="finish">结束曲线 <kbd>Enter</kbd></button><button type="button" data-board-action="close">闭合轮廓</button></div>'+
 '<div class="wb-board-status" aria-live="polite"></div><input class="wb-upload" type="file" accept="image/*" hidden>';
 const viewport=root.querySelector('.wb-viewport'),world=root.querySelector('.wb-world'),layer=root.querySelector('.wb-svg'),cards=root.querySelector('.wb-cards'),status=root.querySelector('.wb-board-status'),curveActions=root.querySelector('.wb-curve-actions'),upload=root.querySelector('.wb-upload');
 const toolbar=root.querySelector('.wb-toolbar');
 if(toolSlot)toolSlot.append(toolbar);
 let items=[], selectedId=null, anchorIndex=0, draft=null, tool='brush', drag=null, space=false;
 const inkUndo=new Map(), inkRedo=new Map(), underlayImports=new WeakMap();
 const brush={color:'graphite',size:3.5,opacity:1};
 const visibility=it=>({showInk:it?.hideInk!==true,showContour:it?.hideContour!==true,showUnderlay:it?.hideUnderlay!==true});
 let x=0,y=0,z=1,ready=false,saveTimer,pendingFocus=null,autoFit=true;
 let preview=null, handDraft=null;
 const activeVersions=new Map();
 const selection=()=>items.find(it=>it.id===selectedId);
 const selectedCurve=()=>selection()?.type==='curve'?selection():null;
 const familyOf=it=>it.familyId||it.id;
 const pointLabel=index=>'P'+String(index+1).padStart(2,'0');
 const rememberCurve=it=>{if(it?.type==='curve')activeVersions.set(familyOf(it),it.id);};
 function currentSketch(){
   const svg=getSketch?.();
   if(typeof svg!=='string'||!svg.includes('<svg'))throw new Error('当前草图无法读取');
   return svgUri(svg);
 }
 function baseSketch(profile, withPin=false){
   return {id:uid(),type:'curve',title:BASE_TITLES[profile]||BASE_TITLES.rounded,
     ...(profile==='shoe'?studio.shoeSample():rules.createBase(profile,withPin)),ink:[]};
 }
 function load(){
   try{const p=JSON.parse(localStorage.getItem(storageKey)||'null');if(Array.isArray(p?.items)){
     items=p.items.slice(0,MAX_ITEMS).filter(it=>it&&typeof it.id==='string'&&typeof it.title==='string'&&['image','sketch','curve'].includes(it.type)&&
      (it.type==='curve'?Array.isArray(it.nodes)&&it.nodes.length<=100&&it.nodes.every(n=>['point','in','out'].every(k=>Number.isFinite(n?.[k]?.x)&&Number.isFinite(n?.[k]?.y))):validSource(it.src)&&[it.x,it.y,it.w,it.h].every(Number.isFinite)));
     for(const it of items)if(it.type==='curve')it.ink=studio.cleanInk(it.ink);
     if(items.length||p.initialized){
       const seed=items.find(it=>it.id==='seed');if(seed)seed.title='初始方案草图';
       const example=items.find(it=>it.id==='render');if(example){example.title='材质与灯光效果';example.role='出图示例';}
       if(Array.isArray(p.activeVersions))for(const id of p.activeVersions){
         rememberCurve(items.find(it=>it.id===id));
       }
       selectedId=items.some(it=>it.id===p.selection)?p.selection:null;
       rememberCurve(selection());return;
     }
   }}catch{}
   const base=baseSketch('shoe',true);
   items=[base];selectedId=base.id;rememberCurve(base);
 }
 function flushSave(){
   clearTimeout(saveTimer);
   saveTimer=undefined;
   try{
     localStorage.setItem(storageKey,JSON.stringify({initialized:true,selection:selectedId,
       activeVersions:[...activeVersions.values()],items:items.filter(it=>it.type==='curve'||(it.src&&!it.src.startsWith('blob:')))}));
     return true;
   }catch{return false;}
 }
 function save(){
   clearTimeout(saveTimer);
   saveTimer=setTimeout(flushSave,100);
 }
 window.addEventListener('pagehide',()=>{if(saveTimer)flushSave();});
 function notifySelection(){
   const it=selection();
   onSelection(it?{title:it.title,type:it.type}:{title:'当前方案草图',type:'sketch'});
   let label='拖动空白处平移 · 滚轮缩放';
   if(it?.type==='curve')label='拖动锚点或手柄 · 滚轮缩放';
   else if(it)label='选中 '+it.title+' · 可作出图输入';
   if(tool==='brush')label='按住自由画线 · 预览随连线更新';
   if(tool==='erase')label='划过要擦除的笔迹 · Ctrl+Z 撤销';
   if(tool==='pen')label=draft?'拖动落点画出切线，点击起点闭合':'点击落点，拖动生成切线';
   if(tool==='pan')label='拖动平移 · 滚轮缩放';
   if(tool==='redraw'){
     if(!it?.closed||it.type!=='curve')label='先选中一份闭合草稿';
     else if(rules.pinSpec(it).segments.includes(anchorIndex))label='这段已固定，请换一段或解除固定';
     else label=handDraft?.candidate?'笔迹已转成可编辑曲线 · 可另存为修改稿':
       '从 '+pointLabel(anchorIndex)+' 到 '+pointLabel((anchorIndex+1)%it.nodes.length)+' 重画这一段';
   }
   status.textContent=label;
   root.dataset.boardTool=tool;curveActions.hidden=!draft;
   root.querySelector('[data-board-action="close"]').disabled=!(draft?.nodes.length>=3);
   toolbar.querySelector('[data-board-action="delete"]').disabled=!it;
 }
 function select(id,index=0){
   if(selectedId!==id||anchorIndex!==index)handDraft=null;
   if(selectedId!==id)preview=null;
   selectedId=id;anchorIndex=index;rememberCurve(selection());
   cards.querySelectorAll('[data-board-item]').forEach(el=>{const selected=el.dataset.boardItem===id;el.classList.toggle('is-selected',selected);el.setAttribute('aria-pressed',String(selected));});
   drawCurves();notifySelection();save();
 }
 function drawCards(){
   cards.replaceChildren();
   for(const it of items){
     if(it.type==='curve'||(it.role==='AI 出图'&&Object.hasOwn(it,'sourceId')))continue;
     const card=document.createElement('article');card.className='wb-card';card.dataset.boardItem=it.id;card.dataset.boardType=it.type;
     card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',it.title);
     card.setAttribute('aria-pressed',String(it.id===selectedId));card.classList.toggle('is-selected',it.id===selectedId);
     card.style.cssText='left:'+it.x+'px;top:'+it.y+'px;width:'+it.w+'px;';
     const header=document.createElement('div');header.className='wb-card-head';
     const kind=document.createElement('small');kind.textContent=it.role||(it.type==='sketch'?'SKETCH':'IMAGE');
     const title=document.createElement('strong');title.textContent=it.title;header.append(kind,title);
     const content=document.createElement('div');content.className='wb-card-art';content.style.height=it.h+'px';
     if(it.src){const img=new Image();img.draggable=false;img.alt='';img.src=it.src;img.onerror=()=>{img.remove();content.classList.add('is-unavailable');content.textContent='图片暂不可用';};content.append(img);}
     card.append(header,content);cards.append(card);
   }
 }
 function drawLinks(){
   const firstResult=items.find(it=>it.role==='AI 出图'&&!Object.hasOwn(it,'sourceId'));
   const pairs=[['ref','seed'],['seed',firstResult?.id??'render']];
   for(const [left,right] of pairs){
     const a=items.find(it=>it.id===left),b=items.find(it=>it.id===right);if(!a||!b)continue;
     const start=a.x+a.w,end=b.x,y1=a.y+43+a.h*.48,y2=b.y+43+b.h*.48,c=(start+end)/2;
     layer.append(svgEl('path',{d:'M '+start+' '+y1+' C '+c+' '+y1+' '+c+' '+y2+' '+end+' '+y2,class:'wb-link'}));
   }
 }
 function drawCurves(){
   layer.replaceChildren();drawLinks();
   for(const it of items){
     if(it.type!=='curve'||(isolated&&it.id!==selectedId))continue;
     const {showInk,showContour,showUnderlay}=visibility(it);
     const active=activeVersions.get(familyOf(it));
     if(active&&it.id!==active)continue;
     if(showUnderlay&&it.underlay){
       const underlay=svgEl('g',{class:'wb-underlay','aria-hidden':'true'});
       underlay.innerHTML=studio.underlayMarkup(it.underlay,{opacity:.67});
       layer.append(underlay);
     }
     const d=curveData(it);
     const selected=it.id===selectedId;
     const replacement=selected?(handDraft?.candidate||preview):null;
     const redrawTarget=selected&&tool==='redraw'&&it.closed;
     if(d&&showContour){
       layer.append(svgEl('path',{d,class:'wb-curve-hit','data-board-item':it.id}));
       layer.append(svgEl('path',{d,class:'wb-curve-path'+(selected?' is-selected':'')+
         (replacement||redrawTarget?' is-underlay':''),'data-curve-id':it.id}));
       if(it.profile==='shoe'){
         const detail=svgEl('g',{class:'wb-shoe-lines','aria-hidden':'true'});
         const clip='wb-pattern-'+it.id.replace(/[^a-zA-Z0-9-]/g,'-');
         const silhouette=curveData(replacement||it);
         detail.innerHTML='<defs><clipPath id="'+clip+'"><path d="'+silhouette+'"/></clipPath></defs>'+studio.shoeSketchMarkup(clip,it.detailOffsetX);
         layer.append(detail);
       }
     }
     if(showInk&&it.ink?.length){
       const ink=svgEl('g',{class:'wb-free-ink','aria-hidden':'true'});
       ink.innerHTML=studio.inkMarkup(it.ink);
       layer.append(ink);
     }
     if(!d||!selected||!showContour||tool==='brush'||tool==='erase'||tool==='pan'){
       if(selected&&showContour&&replacement)layer.append(svgEl('path',{d:curveData(replacement),class:'wb-comparison','aria-hidden':'true'}));
       continue;
     }
     const pins=rules.pinSpec(it), locked=rules.lockedIndices(it);
     if(redrawTarget)layer.append(svgEl('path',{d:rules.segmentPath(it,anchorIndex),class:'wb-redraw-target'}));
     if(replacement)layer.append(svgEl('path',{d:curveData(replacement),class:'wb-comparison','aria-hidden':'true'}));
     for(const index of pins.segments){
       layer.append(svgEl('path',{d:rules.segmentPath(it,index),class:'wb-pinned-edge','data-fixed-segment':index}));
     }
     if(redrawTarget&&handDraft?.stroke&&!replacement)layer.append(svgEl('path',{d:inkPath(handDraft.stroke),class:'wb-ink is-invalid'}));
     it.nodes.forEach((node,index)=>{
       if(index===anchorIndex&&!redrawTarget&&!replacement){
         for(const k of ['in','out']){
           const pt=node[k];
           if(Math.hypot(pt.x-node.point.x,pt.y-node.point.y)<2)continue;
           layer.append(svgEl('line',{x1:node.point.x,y1:node.point.y,x2:pt.x,y2:pt.y,class:'wb-handle-line'}));
           layer.append(svgEl('circle',{cx:pt.x,cy:pt.y,r:5.2,class:'wb-tangent'+(locked.has(index)?' is-locked':''),'data-board-item':it.id,'data-board-node':index,'data-board-handle':k}));
         }
       }
       const current=index===anchorIndex;
       layer.append(svgEl('rect',{x:node.point.x-5,y:node.point.y-5,width:10,height:10,rx:2,
         class:'wb-anchor'+(current?' is-current':'')+(locked.has(index)?' is-locked':''),
         'data-board-item':it.id,'data-board-node':index,'data-board-handle':'point','data-board-anchor':''}));
       if(it.nodes.length<=14||current){
         const text=svgEl('text',{x:node.point.x+10,y:node.point.y-10,class:'wb-point-label'+(current?' is-current':''),'aria-hidden':'true'});
         text.textContent=pointLabel(index);
         layer.append(text);
       }
     });
   }
   if(drag?.type==='brush'&&visibility(drag.item).showInk){
     layer.append(drag.element);
     updateInkElement(drag.stroke,drag.element);
   }
   onScene();
 }
 function inkPath(points){
   return points.map((p,i)=>(i?'L':'M')+p.x.toFixed(2)+' '+p.y.toFixed(2)).join(' ');
 }
 function display(){drawCards();drawCurves();notifySelection();}
 function transform(){world.style.transform='translate('+x+'px,'+y+'px) scale('+z+')';onZoom(z);}
 function resetView(){
   const w=viewport.clientWidth,h=viewport.clientHeight;
   if(!w||!h)return;
   ready=true;autoFit=true;
   if(selectedCurve()){fitCurve(selectedCurve());return;}
   z=limit(Math.min((w-34)/1020,(h-145)/350),.47,1.08);
   x=(w-1020*z)/2;y=Math.max(26,(h-485*z)/2);
   if(w<500)x=limit((w-664*z)/2,-185,14);
   ready=true;transform();
   if(selection()?.role==='AI 出图')focusCard(selection());
 }
 function fitCurve(it){
   const w=viewport.clientWidth,h=viewport.clientHeight;
   if(!w||!h||!it)return;
   const [left,top,width,height]=it.blankFrame||studio.frameFor({curve:it,ink:it.ink||[]},rules);
   z=limit(Math.min(w/width,h/height),.05,1.65);
   x=w/2-(left+width/2)*z;
   y=h*.50-(top+height/2)*z;
   transform();
 }
 new ResizeObserver(()=>{
   if(autoFit&&!root.hidden)fitCurve(selectedCurve());
 }).observe(viewport);
 function focusCard(it){
   const w=viewport.clientWidth,h=viewport.clientHeight;
   if(!w||!h){pendingFocus=it;return;}
   const margin=18, right=x+(it.x+it.w)*z,left=x+it.x*z;
   const top=y+it.y*z,bottom=top+(it.h+43)*z;
   if((it.w*z)>w-margin*2)x=w/2-(it.x+it.w/2)*z;
   else if(right>w-margin)x-=right-w+margin;
   else if(left<margin)x+=margin-left;
   if(bottom>h-52)y-=bottom-h+52;
   if(y+it.y*z<105)y+=105-y-it.y*z;
   autoFit=false;pendingFocus=null;transform();
 }
 function zoom(delta,px=viewport.clientWidth/2,py=viewport.clientHeight/2){
   autoFit=false;
   const next=limit(Math.round((z+delta)*1000)/1000,.20,2.8);
   const ratio=next/z;x=px-(px-x)*ratio;y=py-(py-y)*ratio;z=next;transform();
 }
 function viewportPoint(event){
   const box=viewport.getBoundingClientRect();
   const scaleX=box.width/viewport.clientWidth||1,scaleY=box.height/viewport.clientHeight||1;
   return {x:(event.clientX-box.left)/scaleX,y:(event.clientY-box.top)/scaleY};
 }
 function position(event){
   const point=viewportPoint(event);
   return {x:(point.x-x)/z,y:(point.y-y)/z};
 }
 function chooseTool(next){
   if(next!=='pen'&&draft)finish(false);
   if(tool!==next)handDraft=null;
   if(next==='redraw'||next==='pen')preview=null;
   tool=next;
   drawCurves();
   toolbar.querySelectorAll('[data-board-tool]').forEach(btn=>{const active=btn.dataset.boardTool===tool;btn.setAttribute('aria-pressed',String(active));btn.classList.toggle('is-active',active);});
   notifySelection();
 }
 function finish(closed=false){
   if(!draft)return;
   if(draft.nodes.length<2){
     items=items.filter(it=>it!==draft);activeVersions.delete(draft.id);selectedId=null;
   }else if(closed&&draft.nodes.length>=3){
     const first=draft.nodes[0],last=draft.nodes.at(-1);
     const dx=(first.point.x-last.point.x)*.30,dy=(first.point.y-last.point.y)*.30;
     if(!last.explicit)last.out={x:last.point.x+dx,y:last.point.y+dy};
     if(!first.explicit)first.in={x:first.point.x-dx,y:first.point.y-dy};
     draft.closed=true;
   }
   draft=null;
   chooseTool('select');display();save();
 }
 function addNode(point){
   if(!draft){
     if(items.length>=MAX_ITEMS){onToast('画布对象已达上限');return null;}
     draft={id:uid(),type:'curve',title:'手绘草稿',nodes:[],closed:false};items.push(draft);
     selectedId=draft.id;preview=null;handDraft=null;rememberCurve(draft);
   }
   if(draft.nodes.length>=100){onToast('一条轮廓最多可画 100 个锚点');return null;}
   const last=draft.nodes.at(-1);
   if(last&&Math.hypot(point.x-last.point.x,point.y-last.point.y)<4)return null;
   const n={point:copy(point),in:copy(point),out:copy(point),explicit:false};
   if(last){
     const dx=(point.x-last.point.x)*.30,dy=(point.y-last.point.y)*.30;
     if(!last.explicit)last.out={x:last.point.x+dx,y:last.point.y+dy};
     n.in={x:point.x-dx,y:point.y-dy};n.out={x:point.x+dx,y:point.y+dy};
   }
   draft.nodes.push(n);anchorIndex=draft.nodes.length-1;drawCurves();notifySelection();
   return n;
 }
 function addCard(type,src,title,placement={}){
   if(draft)finish(false);
   if(!validSource(src)){onToast('无法加入这张图片');return null;}
   if(items.length>=MAX_ITEMS&&!placement.replace){onToast('画布对象已达上限');return null;}
   const count=items.filter(it=>it.id!=='ref'&&it.id!=='seed'&&it.id!=='render'&&it.type!=='curve').length;
   const w=type==='sketch'?304:268,h=type==='sketch'?239:208;
   const it={id:uid(),type,title:String(title||'参考图片').slice(0,90),x:(viewport.clientWidth*.5-x)/z-w/2+(count%3)*22,y:(viewport.clientHeight*.48-y)/z-h/2+(count%3)*22,w,h,src};
   if(placement.role)Object.assign(it,placement.geometry,{role:placement.role});
   if(placement.replace)items=items.filter(old=>old!==placement.replace);
   items.push(it);selectedId=it.id;chooseTool('select');display();save();
   return it;
 }
 function addImage(src,title='出图结果',source){
   if(source){
     if(!validSource(src)||items.length>=MAX_ITEMS)return null;
     const item={id:uid(),type:'image',role:'AI 出图',title,src,x:0,y:0,w:280,h:236,sourceId:source.id,sourceStamp:source.stamp};
     items.push(item);
     if(!flushSave())onToast('效果图已显示，浏览器空间不足。可从展示页下载。');
     onScene();
     return item.id;
   }
   const results=items.filter(it=>it.role==='AI 出图');
   const example=items.find(it=>it.id==='render');
   const last=results.at(-1),selected=selection();
   const anchor=selected&&selected.type!=='curve'&&selected!==last?selected:items.find(it=>it.id==='seed');
   const resultX=last?last.x+last.w+54:Math.max(example?.x??718,anchor?anchor.x+anchor.w+54:0);
   const resultY=last?.y??example?.y??145;
   const item=addCard('image',src,title,{role:'AI 出图',replace:example,geometry:{x:resultX,y:resultY,w:280,h:236}});
   if(item&&src.startsWith('blob:'))persistableImage(src).then(saved=>{if(items.includes(item)){item.src=saved;save();}}).catch(()=>{});
   if(item)focusCard(item);
   return item?.id;
 }
 function addCurrentSketch(){
   try{return addCard('sketch',currentSketch(),'当前方案草图')?.id;}
   catch(e){onToast(e.message);return null;}
 }
 function remove(){
   const item=selection();
   if(!item)return;
   items=items.filter(it=>it!==item);
   if(draft===item)draft=null;
   if(item.type==='curve'){
     inkUndo.delete(item.id);inkRedo.delete(item.id);
     const family=familyOf(item);
     activeVersions.delete(family);
     rememberCurve(items.find(it=>it.type==='curve'&&familyOf(it)===family));
   }
   selectedId=null;handDraft=null;preview=null;
   display();save();onToast('已移除画布对象');
 }
 function sketchState(){
   const curve=selectedCurve();
   return {
     curve:curve?structuredClone(curve):null, anchor:anchorIndex, tool,
     hand:handDraft?{ready:!!handDraft.candidate,reason:handDraft.reason}:null,
     sketches:items.filter(it=>it.type==='curve'&&it!==draft&&(it.blank||it.nodes.length>=2)).map(it=>{
       const [x,y,width,height]=it.blankFrame||studio.frameFor({curve:it,ink:it.ink||[]},rules);
       return {id:it.id,title:it.title,closed:!!it.closed,blank:!!it.blank,parentId:it.parentId,kind:it.kind,edited:it.edited,
         path:curveData(it),inkPath:it.ink?.slice(0,12).map(studio.brushPath).join(' ')||'',bounds:{x,y,width,height}};
     })
   };
 }
 function openCurve(id,index=0){
   if(draft)finish(false);
   const item=items.find(it=>it.type==='curve'&&it.id===id);
   if(!item)return;
   chooseTool(item.blank?'brush':'select');
   select(id,index);autoFit=true;fitCurve(item);
 }
 function addBase(profile){
   if(draft)finish(false);
   if(profile==='shoe'){
     const example=items.find(it=>it.profile==='shoe'&&!it.parentId);
     if(example){openCurve(example.id);chooseTool('brush');return example.id;}
   }
   if(items.length>=MAX_ITEMS){onToast('画布对象已达上限');return;}
   const item=baseSketch(profile);
   const existing=items.filter(it=>it.type!=='curve'||it.nodes.length||it.blankFrame);
   if(existing.length){
     const right=Math.max(...existing.map(it=>{
       const box=it.blankFrame?{x:it.blankFrame[0],width:it.blankFrame[2]}:it.type==='curve'?rules.controlBounds(it):{x:it.x,width:it.w};
       return box.x+box.width;
     }));
     const offset=right+135-rules.controlBounds(item).x;
     for(const node of item.nodes)for(const key of ['point','in','out'])node[key].x+=offset;
     if(profile==='shoe')item.detailOffsetX=offset;
   }
   items.push(item);
   openCurve(item.id);
   flushSave();
   return item.id;
 }
 function pickAnchor(index){
   const curve=selectedCurve();
   if(curve&&Number.isInteger(index)&&index>=0&&index<curve.nodes.length)select(curve.id,index);
 }
 function togglePin(kind){
   const curve=selectedCurve();
   if(!curve||draft||!curve.nodes.length)return;
   if(kind==='segments'&&!curve.closed&&anchorIndex===curve.nodes.length-1)return;
   const pins=rules.pinSpec(curve);
   const at=pins[kind].indexOf(anchorIndex);
   if(at<0)pins[kind].push(anchorIndex);
   else pins[kind].splice(at,1);
   curve.pins=rules.pinSpec({...curve,pins});
   handDraft=null;preview=null;
   drawCurves();notifySelection();flushSave();
 }
 function setPreview(candidate){
   preview=candidate;
   drawCurves();
 }
 function saveVersion(candidate,key,kind){
   const source=selectedCurve();
   if(!source||rules.sketchKey(source)!==key){
     onToast('草稿已改动，请重新预览');return null;
   }
   if(items.length>=MAX_ITEMS){onToast('画布对象已达上限，请先清理旧稿');return null;}
   const familyId=familyOf(source);
   const number=Math.max(0,...items.filter(it=>familyOf(it)===familyId).map(it=>it.versionNo||0))+1;
   const item={id:uid(),type:'curve',title:'修改稿 '+String(number).padStart(2,'0'),familyId,
     parentId:source.id,versionNo:number,kind,closed:true,nodes:structuredClone(candidate.nodes),pins:rules.pinSpec(candidate),
     profile:source.profile,detailOffsetX:source.detailOffsetX,ink:structuredClone(source.ink||[]),
     underlay:source.underlay,hideUnderlay:source.hideUnderlay};
   const index=anchorIndex;
   items.push(item);
   handDraft=null;preview=null;
   openCurve(item.id,index);
   const persisted=flushSave();
   onToast(persisted?'已另存 '+item.title:'修改稿已加入画布，浏览器存储已满。请导出 SVG。');
   return item.id;
 }
 function clearHand(){
   handDraft=null;drawCurves();notifySelection();
 }
 function acceptHand(){
   if(!handDraft?.candidate)return null;
   return saveVersion(handDraft.candidate,handDraft.key,'hand');
 }
 function beginInk(event, curve, target, point){
   if(!curve?.closed){onToast('先选中一份闭合草稿');return;}
   const chosen=target?.dataset.boardHandle==='point'?Number(target.dataset.boardNode):-1;
   const next=(anchorIndex+1)%curve.nodes.length;
   if(chosen>=0&&chosen!==anchorIndex&&chosen!==next){pickAnchor(chosen);return;}
   if(rules.pinSpec(curve).segments.includes(anchorIndex)){
     onToast('这段已固定，请选择其它线段或解除固定');return;
   }
   const start=curve.nodes[anchorIndex].point,end=curve.nodes[next].point;
   const distance=Math.min(28/z,Math.hypot(start.x-end.x,start.y-end.y)*.42);
   if([start,end].every(p=>Math.hypot(p.x-point.x,p.y-point.y)>distance)){
     onToast('请从高亮段的任一端点开始画');return;
   }
   clearHand();
   const path=svgEl('path',{class:'wb-ink','aria-hidden':'true'});
   layer.append(path);
   drag={type:'redraw',curve,index:anchorIndex,points:[point],path,distance,key:rules.sketchKey(curve)};
 }
 function sceneFor(id,{drafts=true}={}){
   const it=items.find(item=>item.id===id),curve=it?.type==='curve'?it:null;
   const {showInk,showContour,showUnderlay}=visibility(it);
   const editing=drafts&&id===selectedId;
   const ink=showInk?[...(curve?.ink||[]),...(editing&&drag?.type==='brush'?[drag.stroke]:[])]:[];
   return {
     id:it?.id??null,title:it?.title??'未选择草稿',tool,ink,profile:curve?.profile,offset:curve?.detailOffsetX,
     curve:showContour&&curve?.nodes.length?(editing?(handDraft?.candidate||preview||curve):curve):null,
     frame:curve?.blankFrame,reference:!curve?it?.src:null,
     underlay:showUnderlay?curve?.underlay:null,showInk,showContour,showUnderlay,hasUnderlay:!!curve?.underlay,hasCurve:!!curve?.nodes.length,drawing:editing&&['brush','erase','handle'].includes(drag?.type),
     canUndo:!!inkUndo.get(it?.id)?.length,canRedo:!!inkRedo.get(it?.id)?.length
   };
 }
 function sceneState(options){return sceneFor(selectedId,options);}
 function controlSource(id=selectedId){
   const scene=sceneFor(id,{drafts:false});
   const input=JSON.stringify([scene.reference,scene.underlay?.src,scene.profile,scene.curve?curveData(scene.curve):'',scene.ink]);
   let stamp=2166136261;
   for(let i=0;i<input.length;i++)stamp=Math.imul(stamp^input.charCodeAt(i),16777619);
   return {id:scene.id,stamp:stamp>>>0};
 }
 function resultsFor(sourceId){
   return items.filter(it=>it.role==='AI 出图'&&it.sourceId===sourceId).slice().reverse().map(({id,title,src,sourceStamp})=>({id,title,src,sourceStamp}));
 }
 function addBlank(useViewport=false){
   if(draft)finish(false);
   if(items.length>=MAX_ITEMS){onToast('画布对象已达上限');return null;}
   const box=viewport.getBoundingClientRect();
   const center=position({clientX:box.left+box.width/2,clientY:box.top+box.height/2});
   const edges=items.filter(it=>it.type==='curve').map(it=>it.blankFrame?it.blankFrame[0]+it.blankFrame[2]:
     it.nodes.length?rules.controlBounds(it).x+rules.controlBounds(it).width:0);
   const left=useViewport?center.x-250:Math.max(80,...edges)+100;
   const item={id:uid(),title:'自由草稿 '+String(items.filter(it=>it.blank).length+1).padStart(2,'0'),
     type:'curve',nodes:[],closed:false,blank:true,blankFrame:[left,useViewport?center.y-200:35,500,400],ink:[]};
   items.push(item);
   if(useViewport){select(item.id);chooseTool('brush');}
   else openCurve(item.id);
   flushSave();
   return item;
 }
 function strokeHistory(map,id,ink){
   const list=map.get(id)||[];
   list.push(ink);
   if(list.length>18)list.shift();
   map.set(id,list);
 }
 function stepInk(back=true){
   const it=selectedCurve();
   if(!it||drag)return;
   const from=back?inkUndo:inkRedo, to=back?inkRedo:inkUndo;
   const previous=from.get(it.id)?.pop();
   if(!previous)return;
   strokeHistory(to,it.id,it.ink||[]);it.ink=previous;
   drawCurves();notifySelection();flushSave();
 }
 function setBrush(next){
   if(Object.hasOwn(studio.inks,next.color))brush.color=next.color;
   if(Number.isFinite(next.size))brush.size=limit(next.size,1,18);
   if(Number.isFinite(next.opacity))brush.opacity=limit(next.opacity,.05,1);
 }
 function setLayer(name,shown){
   const it=selectedCurve();
   if(!it)return;
   if(name==='ink')it.hideInk=!shown;
   if(name==='contour')it.hideContour=!shown;
   if(name==='underlay')it.hideUnderlay=!shown;
   drawCurves();notifySelection();save();
 }
 function paintPoint(point,event,previous){
   const value=copy(point);
   if(event.pointerType==='pen')value.pressure=event.pressure>0?event.pressure:previous?.pressure??.25;
   return value;
 }
 function updateInkElement(stroke,element){
   const {d,filled}=studio.brushGeometry(stroke);
   const color=studio.inks[stroke.color].color;
   element.setAttribute('d',d);
   element.setAttribute('opacity',stroke.opacity);
   element.setAttribute('fill',filled?color:'none');
   element.setAttribute('stroke',filled?'none':color);
 }
 async function importUnderlay(file,id=selectedId){
   const it=items.find(item=>item.id===id&&item.type==='curve');
   if(!it||!file)return false;
   if(!/^image\/(?:png|jpeg|webp)$/.test(file.type)||file.size>15*1024*1024){
     onToast('请选择 15 MB 以内的 PNG、JPEG 或 WebP 草图');return false;
   }
   const token={};
   underlayImports.set(it,token);
   const objectUrl=URL.createObjectURL(file);
   try{
     const src=await persistableImage(objectUrl);
     const img=await imageFrom(src);
     const ratio=Math.min(1,420/Math.max(img.naturalWidth,img.naturalHeight));
     const canvas=document.createElement('canvas');
     canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio));
     canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio));
     const ctx=canvas.getContext('2d',{willReadFrequently:true});
     ctx.drawImage(img,0,0,canvas.width,canvas.height);
     const image=ctx.getImageData(0,0,canvas.width,canvas.height);
     const fill=studio.enclosedMask(image.data,canvas.width,canvas.height);
     let mask;
     if(fill){
       for(let i=0;i<fill.length;i++)image.data.set([255,255,255,fill[i]],i*4);
       ctx.putImageData(image,0,0);mask=canvas.toDataURL('image/png');
     }
     if(!items.includes(it)||underlayImports.get(it)!==token)return false;
     const [x,y,w,h]=it.blankFrame||studio.frameFor({curve:it,ink:it.ink||[]},rules);
     const scale=Math.min(w*.85/img.naturalWidth,h*.82/img.naturalHeight);
     const width=img.naturalWidth*scale,height=img.naturalHeight*scale;
     it.underlay={src,mask,x:x+(w-width)/2,y:y+(h-height)/2,width,height};
     it.hideUnderlay=false;
     drawCurves();notifySelection();
     onToast(flushSave()?'已导入线稿底图，可直接在上面画':'已载入底图，浏览器存储空间不足');
     return true;
   }catch{
     if(underlayImports.get(it)===token)onToast('无法读取这张线稿图片');
     return false;
   }finally{
     if(underlayImports.get(it)===token)underlayImports.delete(it);
     URL.revokeObjectURL(objectUrl);
   }
 }
 function beginPaint(point,event){
   const it=selectedCurve()||addBlank(true);
   if(!it)return;
   it.hideInk=false;
   const before=it.ink||[];
   if(before.length>=studio.MAX_STROKES){onToast('这张草稿的笔迹已满，可用橡皮擦出空间。');return;}
   const stroke={color:brush.color,size:limit(brush.size/z,.25,60),opacity:brush.opacity,points:[paintPoint(point,event)]};
   const element=svgEl('path',{class:'studio-ink-line',fill:'none',stroke:studio.inks[stroke.color].color,'stroke-width':stroke.size,
     'stroke-linecap':'round','stroke-linejoin':'round'});
   drag={type:'brush',item:it,before,stroke,element};
   drawCurves();
 }
 function extendPaint(point,event){
   const {stroke,element}=drag;
   if(Math.hypot(point.x-stroke.points.at(-1).x,point.y-stroke.points.at(-1).y)<1.3/z)return;
   if(stroke.points.length>=studio.MAX_POINTS)stroke.points=stroke.points.filter((_,i)=>i%2===0);
   stroke.points.push(paintPoint(point,event,stroke.points.at(-1)));
   updateInkElement(stroke,element);
   onScene();
 }
 function eraseAt(point){
   const filtered=drag.item.ink.filter(stroke=>!studio.hitStroke(stroke,point,10/z,drag.previous));
   drag.previous=point;
   if(filtered.length===drag.item.ink.length)return;
   drag.item.ink=filtered;
   drawCurves();
 }
 function artSvg(it,monochrome=false){
   const {showInk,showContour,showUnderlay}=visibility(it);
   const scene={curve:showContour?it:null,ink:showInk?it.ink||[]:[],profile:it.profile,offset:it.detailOffsetX,
     frame:it.blankFrame,underlay:showUnderlay?it.underlay:null};
   const frame=studio.frameFor(scene,rules,1.25);
   return '<svg xmlns="'+ns+'" width="800" height="640" viewBox="'+frame.join(' ')+'">'+
     studio.lineMarkup(scene,rules,{id:'export',monochrome})+'</svg>';
 }
 toolbar.querySelectorAll('[data-board-tool]').forEach(b=>b.addEventListener('click',()=>chooseTool(b.dataset.boardTool)));
 toolbar.querySelector('[data-board-action="sketch"]').addEventListener('click',addCurrentSketch);
 toolbar.querySelector('[data-board-action="image"]').addEventListener('click',()=>upload.click());
 toolbar.querySelector('[data-board-action="delete"]').addEventListener('click',remove);
 root.querySelector('[data-board-action="finish"]').addEventListener('click',()=>finish(false));
 root.querySelector('[data-board-action="close"]').addEventListener('click',()=>finish(true));
 upload.addEventListener('change',async()=>{
   const f=upload.files?.[0];upload.value='';if(!f)return;
   if(!f.type.startsWith('image/')||f.size>20000000){onToast('请选择 20 MB 以内的图片');return;}
   const url=URL.createObjectURL(f);
   try{const src=await persistableImage(url);addCard('image',src,f.name.replace(/\.[^.]+$/,''));}
   catch{onToast('无法打开这张图片');}finally{URL.revokeObjectURL(url);}
 });
 viewport.addEventListener('wheel',event=>{
   event.preventDefault();
   const point=viewportPoint(event);
   zoom(-Math.sign(event.deltaY)*Math.min(.16,Math.max(.03,Math.abs(event.deltaY)*.001)),point.x,point.y);
 },{passive:false});
 viewport.addEventListener('pointerdown',event=>{
   if(drag||event.isPrimary===false||(event.button!==0&&event.button!==1))return;
   event.preventDefault();root.focus({preventScroll:true});
   const target=event.target.closest('[data-board-item]'),point=position(event);
   const pan=()=>({type:'pan',origin:viewportPoint(event),x,y});
   if(tool==='pan'||space||event.button===1){drag=pan();}
   else if(tool==='brush')beginPaint(point,event);
   else if(tool==='erase'){
     const item=selectedCurve();
     if(item?.ink?.length&&visibility(item).showInk){drag={type:'erase',item,before:item.ink,previous:point};eraseAt(point);}
   }
   else if(tool==='redraw')beginInk(event,selectedCurve(),target,point);
   else if(tool==='pen'){
     if(target?.dataset.boardHandle==='point'&&target.dataset.boardItem===draft?.id&&+target.dataset.boardNode===0&&draft.nodes.length>=3){finish(true);return;}
     const n=addNode(point);if(!n)return;drag={type:'new',node:n,start:point};
   }else if(target){
     const it=items.find(o=>o.id===target.dataset.boardItem);if(!it)return;
     const index=Number(target.dataset.boardNode??0);select(it.id,index);
     if(it.type!=='curve')drag={type:'card',item:it,start:point,x:it.x,y:it.y,element:target};
     else if(target.dataset.boardHandle&&!rules.lockedIndices(it).has(index)){
       const key=target.dataset.boardHandle;
       drag={type:'handle',item:it,node:it.nodes[index],key,start:point,original:copy(it.nodes[index][key])};
     }
   }else{if(!isolated)select(null);drag=pan();}
   if(drag){viewport.setPointerCapture(event.pointerId);root.classList.add('is-dragging');}
 });
 viewport.addEventListener('pointermove',event=>{
   if(!drag)return;
   if(drag.type==='pan'){
     const point=viewportPoint(event);autoFit=false;
     x=drag.x+point.x-drag.origin.x;y=drag.y+point.y-drag.origin.y;transform();return;
   }
   const p=position(event);
   if(drag.type==='brush'){extendPaint(p,event);return;}
   if(drag.type==='erase'){eraseAt(p);return;}
   if(drag.type==='redraw'){
     const last=drag.points.at(-1);
     if(Math.hypot(p.x-last.x,p.y-last.y)<1.65/z)return;
     if(drag.points.length>=512)drag.points=drag.points.filter((_,i)=>i%2===0);
     drag.points.push(p);
     drag.path.setAttribute('d',inkPath(drag.points));return;
   }
   const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
   if(drag.type==='card'){drag.item.x=drag.x+dx;drag.item.y=drag.y+dy;drag.element.style.left=drag.item.x+'px';drag.element.style.top=drag.item.y+'px';drawCurves();}
   else if(drag.type==='new'&&Math.hypot(dx,dy)>3){drag.node.out=copy(p);drag.node.in={x:drag.start.x-dx,y:drag.start.y-dy};drag.node.explicit=true;drawCurves();}
   else if(drag.type==='handle'){
     const n=drag.node,k=drag.key;
     const position={x:drag.original.x+dx,y:drag.original.y+dy};
     if(k==='point'){
       const mx=position.x-n.point.x,my=position.y-n.point.y;
       n.in.x+=mx;n.in.y+=my;n.out.x+=mx;n.out.y+=my;
     }
     if(dx||dy){drag.changed=true;n.explicit=true;drag.item.edited=true;}
     n[k]=position;preview=null;drawCurves();
   }
 });
 for(const type of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(type,event=>{
   if(!drag)return;
   const done=drag;
   if(event.type==='pointerup'&&done.type==='brush')extendPaint(position(event),event);
   if(event.type==='pointerup'&&done.type==='erase')eraseAt(position(event));
   drag=null;root.classList.remove('is-dragging');
   if(done.type==='brush'||done.type==='erase'){
     const completed=event.type==='pointerup';
     if(completed&&done.type==='brush')done.item.ink=studio.cleanInk([...done.before,done.stroke]);
     if(!completed)done.item.ink=done.before;
     if(done.item.ink!==done.before){
       strokeHistory(inkUndo,done.item.id,done.before);inkRedo.delete(done.item.id);
       if(!flushSave())onToast('浏览器空间不足，请导出 SVG 保存当前草稿。');
     }
     drawCurves();notifySelection();
     return;
   }
   if(done.type==='redraw'){
     if(event.type==='pointerup'){
       done.points.push(position(event));
       const result=rules.redraw(done.curve,done.index,done.points,done.distance);
       handDraft={...result,key:done.key,stroke:done.points};
     }
     drawCurves();notifySelection();
     return;
   }
   save();
   if((done.type==='handle'&&done.changed)||done.type==='new')notifySelection();
 });
 root.addEventListener('keydown',event=>{
   if(event.target.closest('input,textarea,select'))return;
   const k=event.key.toLowerCase();
   const card=event.target.closest('.wb-card');
   if(card&&(event.key==='Enter'||event.key===' ')){select(card.dataset.boardItem);event.preventDefault();return;}
   if(event.key===' '&&event.target.closest('button'))return;
   if(event.key===' '){event.preventDefault();space=true;root.classList.add('wb-space');return;}
   if((event.ctrlKey||event.metaKey)&&k==='z'){stepInk(!event.shiftKey);event.preventDefault();return;}
   if(event.ctrlKey||event.metaKey||event.altKey)return;
   const shortcuts={v:'select',b:'brush',e:'erase',r:'redraw',p:'pen',h:'pan'};
   if(shortcuts[k]){chooseTool(shortcuts[k]);event.preventDefault();}
   if(event.key==='Enter'&&draft){finish(false);event.preventDefault();}
   if(event.key==='Escape'){
     if(draft)finish(false);
     else if(handDraft)clearHand();
     else if(tool==='redraw')chooseTool('select');
     else if(!isolated)select(null);
   }
   if(event.key==='Delete'||event.key==='Backspace'){remove();event.preventDefault();}
   if(event.key.startsWith('Arrow')&&selection()&&selection().type!=='curve'){
     const it=selection(), step=event.shiftKey?16:4;
     it.x+=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0;
     it.y+=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
     const element=[...cards.children].find(el=>el.dataset.boardItem===it.id);
     element.style.left=it.x+'px';element.style.top=it.y+'px';
     drawCurves();save();event.preventDefault();
   }
 });
 root.addEventListener('keyup',event=>{if(event.key===' '){space=false;root.classList.remove('wb-space');}});
 root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget)){space=false;root.classList.remove('wb-space');}});
 async function captureControl(id=selectedId){
   const it=items.find(item=>item.id===id);
   const {showInk,showContour,showUnderlay}=visibility(it);
   const canvas=document.createElement('canvas');canvas.width=800;canvas.height=640;
   const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,800,640);
   if(it?.type==='curve'){
     if(!(showContour&&it.nodes.length>=2)&&!(showInk&&it.ink?.length)&&!(showUnderlay&&it.underlay))throw new Error('请先绘制或导入可用于控形的线稿');
     const img=await imageFrom(svgUri(artSvg(it,true)));
     fitImage(ctx,img,800,640,18);
   }else{
     const img=await imageFrom(it?.src||currentSketch());fitImage(ctx,img,800,640,44);
   }
   transformPixels(ctx,800,640,it?.type==='image');
   return png(canvas);
 }
 async function exportSelected(){
   const it=selection();
   if(it?.type==='curve'){
     if(!it.nodes.length&&!it.ink?.length&&!it.underlay)throw new Error('请先画几笔再导出');
     return new Blob([artSvg(it)],{type:'image/svg+xml;charset=utf-8'});
   }
   if(!it)return captureControl();
   const image=await imageFrom(it.src);const canvas=document.createElement('canvas');
   canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
   return png(canvas);
 }
 load();display();chooseTool('brush');
 return {
   show(){root.hidden=false;if(!ready)resetView();if(pendingFocus)focusCard(pendingFocus);display();},
   hide(){if(draft)finish(false);root.hidden=true;},
   addImage,addCurrentSketch,captureControl,exportSelected,resetView,zoom,zoomReset:resetView,getZoom:()=>z,
   sketchState,openCurve,addBase,addBlank,pickAnchor,togglePin,setPreview,saveVersion,clearHand,acceptHand,setTool:chooseTool,
   sceneState,sceneFor,controlSource,resultsFor,stepInk,setBrush,setLayer,importUnderlay
 };
}
window.WuyingBoard={mount};
})();
