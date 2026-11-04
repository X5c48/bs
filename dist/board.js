(() => {
'use strict';
const ns='http://www.w3.org/2000/svg';
const STORE='wuying-free-board-v2';
const MAX_ITEMS=24;
const icon={
 select:'<path d="m5 3 15 9-7 1.5L9 20z"/>',
 pen:'<path d="m5 18 3-8 8-7 5 5-7 8-9 2Zm3-8 6 6M5 18l5-5"/>',
 pan:'<path d="M7 13V7a1.4 1.4 0 0 1 2.8 0v4-6a1.4 1.4 0 0 1 2.8 0v6-4.5a1.4 1.4 0 0 1 2.8 0v5-2.5a1.4 1.4 0 0 1 2.8 0v5c0 4-2.4 6-5.5 6H12c-2.2 0-3.8-1-5-3l-2-3.2a1.6 1.6 0 0 1 2.7-1.6l1.3 1.9"/>',
 sketch:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6m-6 4h6m-6 4h4"/>',
 image:'<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4"/><path d="m5 17 4-4 3 3 3-5 4 5"/>',
 delete:'<path d="M5 7h14m-12 0 1 13h8l1-13M9 7V4h6v3m-5 3v7m4-7v7"/>'
};
const svgIcon=n=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'+icon[n]+'</svg>';
const tools=[['select','选择','V'],['pen','钢笔','P'],['pan','抓手','H']];
const actions=[['sketch','加入草图'],['image','添加图片'],['delete','删除对象']];
const limit=(n,min,max)=>Math.min(max,Math.max(min,n));
const copy=pt=>({x:pt.x,y:pt.y});
const svgUri=source=>'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(source);
const uid=()=>globalThis.crypto?.randomUUID?.()??String(Date.now())+'-'+Math.random().toString(36).slice(2);
const svgEl=(name,attributes={})=>{const element=document.createElementNS(ns,name);for(const [k,v] of Object.entries(attributes))element.setAttribute(k,v);return element;};
function curveData(item){
 const [first,...rest]=item.nodes;if(!first)return '';
 const coordinates=pt=>pt.x.toFixed(2)+' '+pt.y.toFixed(2);
 let d='M '+coordinates(first.point), previous=first;
 for(const next of rest){d+=' C '+coordinates(previous.out)+' '+coordinates(next.in)+' '+coordinates(next.point);previous=next;}
 if(item.closed&&rest.length>1)d+=' C '+coordinates(previous.out)+' '+coordinates(first.in)+' '+coordinates(first.point)+' Z';
 return d;
}
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
function mount(root,{getSketch,onToast=()=>{},onSelection=()=>{},onZoom=()=>{}}={}){
 root.classList.add('wb-board');
 root.setAttribute('tabindex','0');
 root.setAttribute('aria-label','自由设计画布');
 root.innerHTML='<div class="wb-viewport"><div class="wb-world"><svg class="wb-svg" aria-label="矢量曲线"></svg><div class="wb-cards"></div></div></div>'+
 '<div class="wb-toolbar" role="toolbar" aria-label="自由画布工具">'+tools.map(([id,name,key])=>'<button type="button" data-board-tool="'+id+'" aria-pressed="false" title="'+name+' ('+key+')" aria-label="'+name+'">'+svgIcon(id)+'<span>'+name+'</span></button>').join('')+
 '<span class="wb-toolbar-divider"></span>'+actions.map(([id,name])=>'<button type="button" data-board-action="'+id+'" title="'+name+'" aria-label="'+name+'">'+svgIcon(id)+'<span>'+name+'</span></button>').join('')+'</div>'+
 '<div class="wb-curve-actions" hidden><button type="button" data-board-action="finish">结束曲线 <kbd>Enter</kbd></button><button type="button" data-board-action="close">闭合轮廓</button></div>'+
 '<div class="wb-board-status" aria-live="polite"></div><input class="wb-upload" type="file" accept="image/*" hidden>';
 const viewport=root.querySelector('.wb-viewport'),world=root.querySelector('.wb-world'),layer=root.querySelector('.wb-svg'),cards=root.querySelector('.wb-cards'),status=root.querySelector('.wb-board-status'),curveActions=root.querySelector('.wb-curve-actions'),upload=root.querySelector('.wb-upload');
 let items=[], selectedId=null, anchorIndex=0, draft=null, tool='select', drag=null, space=false;
 let x=0,y=0,z=1,ready=false,saveTimer,pendingFocus=null;
 function currentSketch(){
   const svg=getSketch?.();
   if(typeof svg!=='string'||!svg.includes('<svg'))throw new Error('当前草图无法读取');
   return svgUri(svg);
 }
 function sample(){
   let src='';
   try{src=currentSketch();}catch{}
   return [
     {id:'ref',type:'image',title:'音箱造型参考',role:'REFERENCE',x:26,y:145,w:246,h:236,src:'assets/reference.jpg'},
     {id:'seed',type:'sketch',title:'初始方案草图',role:'SKETCH',x:324,y:99,w:340,h:276,src},
     {id:'render',type:'image',title:'材质与灯光效果',role:'出图示例',x:718,y:145,w:280,h:236,src:'assets/render-example.jpg'}
   ];
 }
 function load(){
   try{const p=JSON.parse(localStorage.getItem(STORE)||'null');if(Array.isArray(p?.items)){
     items=p.items.slice(0,MAX_ITEMS).filter(it=>it&&typeof it.id==='string'&&typeof it.title==='string'&&['image','sketch','curve'].includes(it.type)&&
      (it.type==='curve'?Array.isArray(it.nodes)&&it.nodes.length<=100&&it.nodes.every(n=>['point','in','out'].every(k=>Number.isFinite(n?.[k]?.x)&&Number.isFinite(n?.[k]?.y))):validSource(it.src)&&[it.x,it.y,it.w,it.h].every(Number.isFinite)));
     if(items.length||p.initialized){
       const seed=items.find(it=>it.id==='seed');if(seed)seed.title='初始方案草图';
       const example=items.find(it=>it.id==='render');if(example){example.title='材质与灯光效果';example.role='出图示例';}
       selectedId=items.some(it=>it.id===p.selection)?p.selection:null;return;
     }
   }}catch{}
   items=sample();selectedId='seed';
 }
 function flushSave(){
   clearTimeout(saveTimer);
   saveTimer=undefined;
   try{localStorage.setItem(STORE,JSON.stringify({initialized:true,selection:selectedId,items:items.filter(it=>it.type==='curve'||(it.src&&!it.src.startsWith('blob:')))}));}catch{}
 }
 function save(){
   clearTimeout(saveTimer);
   saveTimer=setTimeout(flushSave,100);
 }
 window.addEventListener('pagehide',()=>{if(saveTimer)flushSave();});
 const selection=()=>items.find(it=>it.id===selectedId);
 function notifySelection(){
   const it=selection();
   onSelection(it?{title:it.title,type:it.type}:{title:'当前方案草图',type:'sketch'});
   const label=tool==='pen'?(draft?'拖动落点创建切线，Enter 完成':'点击落点，拖动生成切线'):tool==='pan'?'拖动平移 · 滚轮缩放':it?.type==='curve'?'拖动锚点或紫色切线手柄':it?'选中：'+it.title+' · 可用作控形输入':'拖动空白处平移 · 滚轮缩放';
   status.textContent=label;
   root.dataset.boardTool=tool;curveActions.hidden=!draft;
   root.querySelector('[data-board-action="close"]').disabled=!(draft?.nodes.length>=3);
   root.querySelector('[data-board-action="delete"]').disabled=!it;
 }
 function select(id,index=0){
   selectedId=id;anchorIndex=index;
   cards.querySelectorAll('[data-board-item]').forEach(el=>{const selected=el.dataset.boardItem===id;el.classList.toggle('is-selected',selected);el.setAttribute('aria-pressed',String(selected));});
   drawCurves();notifySelection();save();
 }
 function drawCards(){
   cards.replaceChildren();
   for(const it of items){
     if(it.type==='curve')continue;
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
   const firstResult=items.find(it=>it.role==='AI 出图');
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
     if(it.type!=='curve')continue;
     const d=curveData(it);
     if(!d)continue;
     layer.append(svgEl('path',{d,class:'wb-curve-hit','data-board-item':it.id}));
     layer.append(svgEl('path',{d,class:'wb-curve-path'+(it.id===selectedId?' is-selected':''),'data-curve-id':it.id}));
     if(it.id!==selectedId)continue;
     it.nodes.forEach((node,index)=>{
       if(index===anchorIndex){
         for(const k of ['in','out']){
           const pt=node[k];
           if(Math.hypot(pt.x-node.point.x,pt.y-node.point.y)<2)continue;
           layer.append(svgEl('line',{x1:node.point.x,y1:node.point.y,x2:pt.x,y2:pt.y,class:'wb-handle-line'}));
           layer.append(svgEl('circle',{cx:pt.x,cy:pt.y,r:5.2,class:'wb-tangent','data-board-item':it.id,'data-board-node':index,'data-board-handle':k}));
         }
       }
       layer.append(svgEl('rect',{x:node.point.x-5,y:node.point.y-5,width:10,height:10,rx:2,class:'wb-anchor'+(index===anchorIndex?' is-current':''),'data-board-item':it.id,'data-board-node':index,'data-board-handle':'point','data-board-anchor':''}));
     });
   }
 }
 function display(){drawCards();drawCurves();notifySelection();}
 function transform(){world.style.transform='translate('+x+'px,'+y+'px) scale('+z+')';onZoom(z);}
 function resetView(){
   const w=viewport.clientWidth,h=viewport.clientHeight;
   if(!w||!h)return;
   z=limit(Math.min((w-34)/1020,(h-145)/350),.47,1.08);
   x=(w-1020*z)/2;y=Math.max(26,(h-485*z)/2);
   if(w<500)x=limit((w-664*z)/2,-185,14);
   ready=true;transform();
   if(selection()?.role==='AI 出图')focusCard(selection());
 }
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
   pendingFocus=null;transform();
 }
 function zoom(delta,px=viewport.clientWidth/2,py=viewport.clientHeight/2){
   const next=limit(Math.round((z+delta)*1000)/1000,.26,2.8);
   const ratio=next/z;x=px-(px-x)*ratio;y=py-(py-y)*ratio;z=next;transform();
 }
 function position(event){
   const box=viewport.getBoundingClientRect();return {x:(event.clientX-box.left-x)/z,y:(event.clientY-box.top-y)/z};
 }
 function chooseTool(next){
   if(next!=='pen'&&draft)finish(false);
   tool=next;
   root.querySelectorAll('[data-board-tool]').forEach(btn=>{const active=btn.dataset.boardTool===tool;btn.setAttribute('aria-pressed',String(active));btn.classList.toggle('is-active',active);});
   notifySelection();
 }
 function finish(closed=false){
   if(!draft)return;
   if(draft.nodes.length<2){items=items.filter(it=>it!==draft);selectedId=null;}
   else draft.closed=closed&&draft.nodes.length>=3;
   draft=null;
   chooseTool('select');display();save();
 }
 function addNode(point){
   if(!draft){
     if(items.length>=MAX_ITEMS){onToast('画布对象已达上限');return null;}
     draft={id:uid(),type:'curve',title:'贝塞尔轮廓',nodes:[],closed:false};items.push(draft);selectedId=draft.id;
   }
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
 function addImage(src,title='出图结果'){
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
   if(!selection())return;
   items=items.filter(it=>it.id!==selectedId);if(draft?.id===selectedId)draft=null;selectedId=null;
   display();save();onToast('已移除画布对象');
 }
 root.querySelectorAll('[data-board-tool]').forEach(b=>b.addEventListener('click',()=>chooseTool(b.dataset.boardTool)));
 root.querySelector('[data-board-action="sketch"]').addEventListener('click',addCurrentSketch);
 root.querySelector('[data-board-action="image"]').addEventListener('click',()=>upload.click());
 root.querySelector('[data-board-action="delete"]').addEventListener('click',remove);
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
   event.preventDefault();const box=viewport.getBoundingClientRect();
   zoom(-Math.sign(event.deltaY)*Math.min(.16,Math.max(.03,Math.abs(event.deltaY)*.001)),event.clientX-box.left,event.clientY-box.top);
 },{passive:false});
 viewport.addEventListener('pointerdown',event=>{
   if(event.button!==0&&event.button!==1)return;
   event.preventDefault();root.focus({preventScroll:true});
   const target=event.target.closest('[data-board-item]'),point=position(event);
   if(tool==='pan'||space||event.button===1){drag={type:'pan',cx:event.clientX,cy:event.clientY,x,y};}
   else if(tool==='pen'){
     if(target?.dataset.boardHandle==='point'&&target.dataset.boardItem===draft?.id&&+target.dataset.boardNode===0&&draft.nodes.length>=3){finish(true);return;}
     const n=addNode(point);if(!n)return;drag={type:'new',node:n,start:point};
   }else if(target){
     const it=items.find(o=>o.id===target.dataset.boardItem);if(!it)return;
     const index=Number(target.dataset.boardNode??0);select(it.id,index);
     if(it.type!=='curve')drag={type:'card',item:it,start:point,x:it.x,y:it.y,element:target};
     else if(target.dataset.boardHandle)drag={type:'handle',node:it.nodes[index],key:target.dataset.boardHandle,start:point};
   }else{select(null);drag={type:'pan',cx:event.clientX,cy:event.clientY,x,y};}
   if(drag){viewport.setPointerCapture(event.pointerId);root.classList.add('is-dragging');}
 });
 viewport.addEventListener('pointermove',event=>{
   if(!drag)return;
   if(drag.type==='pan'){x=drag.x+event.clientX-drag.cx;y=drag.y+event.clientY-drag.cy;transform();return;}
   const p=position(event), dx=p.x-drag.start.x,dy=p.y-drag.start.y;
   if(drag.type==='card'){drag.item.x=drag.x+dx;drag.item.y=drag.y+dy;drag.element.style.left=drag.item.x+'px';drag.element.style.top=drag.item.y+'px';drawCurves();}
   else if(drag.type==='new'&&Math.hypot(dx,dy)>3){drag.node.out=copy(p);drag.node.in={x:drag.start.x-dx,y:drag.start.y-dy};drag.node.explicit=true;drawCurves();}
   else if(drag.type==='handle'){
     const n=drag.node,k=drag.key;
     if(k==='point'){const mx=p.x-n.point.x,my=p.y-n.point.y;n.in.x+=mx;n.in.y+=my;n.out.x+=mx;n.out.y+=my;}
     n[k]=copy(p);n.explicit=true;drawCurves();
   }
 });
 for(const type of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(type,()=>{
   if(!drag)return;
   const changedCurve=drag.type==='handle'||drag.type==='new';
   drag=null;root.classList.remove('is-dragging');save();
   if(changedCurve)notifySelection();
 });
 root.addEventListener('keydown',event=>{
   if(event.target.closest('input,textarea,select'))return;
   const k=event.key.toLowerCase();
   const card=event.target.closest('.wb-card');
   if(card&&(event.key==='Enter'||event.key===' ')){select(card.dataset.boardItem);event.preventDefault();return;}
   if(event.key===' '&&event.target.closest('button'))return;
   if(event.key===' '){event.preventDefault();space=true;root.classList.add('wb-space');return;}
   if(event.ctrlKey||event.metaKey||event.altKey)return;
   if(k==='v'||k==='p'||k==='h'){chooseTool({v:'select',p:'pen',h:'pan'}[k]);event.preventDefault();}
   if(event.key==='Enter'&&draft){finish(false);event.preventDefault();}
   if(event.key==='Escape'){if(draft)finish(false);else select(null);}
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
 async function captureControl(){
   const it=selection();const canvas=document.createElement('canvas');canvas.width=800;canvas.height=640;
   const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,800,640);
   if(it?.type==='curve'){
     const path=layer.querySelector('[data-curve-id="'+it.id+'"]');const box=path?.getBBox();
     if(!box||Math.max(box.width,box.height)<1)throw new Error('请先绘制一条有效曲线');
     const factor=Math.min(698/Math.max(box.width,1),538/Math.max(box.height,1));
     ctx.translate(400-(box.x+box.width/2)*factor,320-(box.y+box.height/2)*factor);ctx.scale(factor,factor);
     ctx.strokeStyle='#000';ctx.lineWidth=3/factor;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke(new Path2D(curveData(it)));
   }else{
     const img=await imageFrom(it?.src||currentSketch());fitImage(ctx,img,800,640,44);
   }
   transformPixels(ctx,800,640,it?.type==='image');
   return png(canvas);
 }
 async function exportSelected(){
   const it=selection();
   if(!it||it.type==='curve')return captureControl();
   const image=await imageFrom(it.src);const canvas=document.createElement('canvas');
   canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
   return png(canvas);
 }
 load();display();chooseTool('select');
 return {show(){root.hidden=false;if(!ready)resetView();if(pendingFocus)focusCard(pendingFocus);display();},hide(){if(draft)finish(false);root.hidden=true;},addImage,addCurrentSketch,captureControl,exportSelected,resetView,zoom,zoomReset:resetView,getZoom:()=>z};
}
window.WuyingBoard={mount};
})();
