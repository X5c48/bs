(() => {
'use strict';
const ns='http://www.w3.org/2000/svg';
const rules=window.WuyingSketchRules;
const STORE='wuying-free-board-v2';
const BASE_TITLES={rounded:'圆润轮廓',rectilinear:'方正轮廓',tapered:'楔形轮廓'};
const MAX_ITEMS=24;
const icon={
 select:'<path d="m5 3 15 9-7 1.5L9 20z"/>',
 redraw:'<path d="m14 5 5 5M5 19l4.5-1L20 7.5l-3.5-3.5L6 14.5 5 19Zm3 0c3 2 7 2 11-1"/>',
 pen:'<path d="m5 18 3-8 8-7 5 5-7 8-9 2Zm3-8 6 6M5 18l5-5"/>',
 pan:'<path d="M7 13V7a1.4 1.4 0 0 1 2.8 0v4-6a1.4 1.4 0 0 1 2.8 0v6-4.5a1.4 1.4 0 0 1 2.8 0v5-2.5a1.4 1.4 0 0 1 2.8 0v5c0 4-2.4 6-5.5 6H12c-2.2 0-3.8-1-5-3l-2-3.2a1.6 1.6 0 0 1 2.7-1.6l1.3 1.9"/>',
 sketch:'<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6m-6 4h6m-6 4h4"/>',
 image:'<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.4"/><path d="m5 17 4-4 3 3 3-5 4 5"/>',
 delete:'<path d="M5 7h14m-12 0 1 13h8l1-13M9 7V4h6v3m-5 3v7m4-7v7"/>'
};
const svgIcon=n=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'+icon[n]+'</svg>';
const tools=[['select','选点','V'],['redraw','手绘改线','B'],['pen','钢笔','P'],['pan','抓手','H']];
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
function mount(root,{getSketch,onToast=()=>{},onSelection=()=>{},onZoom=()=>{},demo=false}={}){
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
 let items=[], selectedId=null, anchorIndex=0, draft=null, tool='select', drag=null, space=false;
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
     ...rules.createBase(profile,withPin)};
 }
 function load(){
   try{const p=JSON.parse(localStorage.getItem(storageKey)||'null');if(Array.isArray(p?.items)){
     items=p.items.slice(0,MAX_ITEMS).filter(it=>it&&typeof it.id==='string'&&typeof it.title==='string'&&['image','sketch','curve'].includes(it.type)&&
      (it.type==='curve'?Array.isArray(it.nodes)&&it.nodes.length<=100&&it.nodes.every(n=>['point','in','out'].every(k=>Number.isFinite(n?.[k]?.x)&&Number.isFinite(n?.[k]?.y))):validSource(it.src)&&[it.x,it.y,it.w,it.h].every(Number.isFinite)));
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
   const base=baseSketch('rounded',true);
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
   root.querySelector('[data-board-action="delete"]').disabled=!it;
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
     const active=activeVersions.get(familyOf(it));
     if(active&&it.id!==active)continue;
     const d=curveData(it);
     if(!d)continue;
     layer.append(svgEl('path',{d,class:'wb-curve-hit','data-board-item':it.id}));
     const selected=it.id===selectedId;
     const replacement=selected?(handDraft?.candidate||preview):null;
     const redrawTarget=selected&&tool==='redraw'&&it.closed;
     layer.append(svgEl('path',{d,class:'wb-curve-path'+(selected?' is-selected':'')+
       (replacement||redrawTarget?' is-underlay':''),'data-curve-id':it.id}));
     if(!selected)continue;
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
   if(selectedCurve()?.nodes.length){fitCurve(selectedCurve());return;}
   z=limit(Math.min((w-34)/1020,(h-145)/350),.47,1.08);
   x=(w-1020*z)/2;y=Math.max(26,(h-485*z)/2);
   if(w<500)x=limit((w-664*z)/2,-185,14);
   ready=true;transform();
   if(selection()?.role==='AI 出图')focusCard(selection());
 }
 function fitCurve(it){
   const w=viewport.clientWidth,h=viewport.clientHeight;
   if(!w||!h||!it?.nodes.length)return;
   const {x:left,y:top,width,height}=rules.controlBounds(it);
   const usableWidth=Math.max(45,w-Math.min(156,w*.22));
   const usableHeight=Math.max(45,h-Math.min(190,h*.43));
   z=limit(Math.min(usableWidth/Math.max(width,1),usableHeight/Math.max(height,1)),.20,1.65);
   x=w/2-(left+width/2)*z;
   y=h*.53-(top+height/2)*z;
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
 function position(event){
   const box=viewport.getBoundingClientRect();return {x:(event.clientX-box.left-x)/z,y:(event.clientY-box.top-y)/z};
 }
 function chooseTool(next){
   if(next!=='pen'&&draft)finish(false);
   if(tool!==next)handDraft=null;
   if(next==='redraw'||next==='pen')preview=null;
   tool=next;
   drawCurves();
   root.querySelectorAll('[data-board-tool]').forEach(btn=>{const active=btn.dataset.boardTool===tool;btn.setAttribute('aria-pressed',String(active));btn.classList.toggle('is-active',active);});
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
   const item=selection();
   if(!item)return;
   items=items.filter(it=>it!==item);
   if(draft===item)draft=null;
   if(item.type==='curve'){
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
     sketches:items.filter(it=>it.type==='curve'&&it!==draft&&it.nodes.length>=2).map(it=>({
       id:it.id,title:it.title,closed:!!it.closed,parentId:it.parentId,kind:it.kind,edited:it.edited,
       path:curveData(it),bounds:rules.controlBounds(it)
     }))
   };
 }
 function openCurve(id,index=0){
   if(draft)finish(false);
   const item=items.find(it=>it.type==='curve'&&it.id===id);
   if(!item)return;
   chooseTool('select');
   select(id,index);autoFit=true;fitCurve(item);
 }
 function addBase(profile){
   if(draft)finish(false);
   if(items.length>=MAX_ITEMS){onToast('画布对象已达上限');return;}
   const item=baseSketch(profile);
   const existing=items.filter(it=>it.type!=='curve'||it.nodes.length);
   if(existing.length){
     const right=Math.max(...existing.map(it=>{
       const box=it.type==='curve'?rules.controlBounds(it):{x:it.x,width:it.w};
       return box.x+box.width;
     }));
     const offset=right+135-rules.controlBounds(item).x;
     for(const node of item.nodes)for(const key of ['point','in','out'])node[key].x+=offset;
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
     parentId:source.id,versionNo:number,kind,closed:true,nodes:structuredClone(candidate.nodes),pins:rules.pinSpec(candidate)};
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
 function curveSvg(it){
   const box=rules.controlBounds(it),pad=Math.max(8,Math.max(box.width,box.height)*.06);
   const viewBox=[box.x-pad,box.y-pad,box.width+2*pad,box.height+2*pad].map(n=>n.toFixed(2)).join(' ');
   const svg='<svg xmlns="'+ns+'" viewBox="'+viewBox+'"><path d="'+curveData(it)+
     '" fill="none" stroke="#222238" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
   return new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
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
   }else{select(null);drag={type:'pan',cx:event.clientX,cy:event.clientY,x,y};}
   if(drag){viewport.setPointerCapture(event.pointerId);root.classList.add('is-dragging');}
 });
 viewport.addEventListener('pointermove',event=>{
   if(!drag)return;
   if(drag.type==='pan'){autoFit=false;x=drag.x+event.clientX-drag.cx;y=drag.y+event.clientY-drag.cy;transform();return;}
   const p=position(event);
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
   drag=null;root.classList.remove('is-dragging');
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
   if(event.ctrlKey||event.metaKey||event.altKey)return;
   const shortcuts={v:'select',b:'redraw',p:'pen',h:'pan'};
   if(shortcuts[k]){chooseTool(shortcuts[k]);event.preventDefault();}
   if(event.key==='Enter'&&draft){finish(false);event.preventDefault();}
   if(event.key==='Escape'){
     if(draft)finish(false);
     else if(handDraft)clearHand();
     else if(tool==='redraw')chooseTool('select');
     else select(null);
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
   if(it?.type==='curve'&&it.nodes.length>=2)return curveSvg(it);
   if(!it)return captureControl();
   const image=await imageFrom(it.src);const canvas=document.createElement('canvas');
   canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
   return png(canvas);
 }
 load();display();chooseTool('select');
 return {
   show(){root.hidden=false;if(!ready)resetView();if(pendingFocus)focusCard(pendingFocus);display();},
   hide(){if(draft)finish(false);root.hidden=true;},
   addImage,addCurrentSketch,captureControl,exportSelected,resetView,zoom,zoomReset:resetView,getZoom:()=>z,
   sketchState,openCurve,addBase,pickAnchor,togglePin,setPreview,saveVersion,clearHand,acceptHand,setTool:chooseTool
 };
}
window.WuyingBoard={mount};
})();
