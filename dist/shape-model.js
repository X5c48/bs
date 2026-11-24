(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./sketch-rules.js'));
  else root.WuyingShapeModel=factory(root.WuyingSketchRules);
})(globalThis,function(rules){
  'use strict';
  const labels={x:'中心 X',y:'中心 Y',width:'宽度',height:'高度',depth:'厚度',z:'深度位置',angle:'角度',name:'名称',shape:'轮廓'};
  const shapeNames={rectangle:'矩形',ellipse:'椭圆',polygon:'描线'};
  const fields=['x','y','width','height','angle'];
  const spatialFields=[...fields,'depth','z'];
  const rect=[{x:-.5,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}];
  const oval=Array.from({length:40},(_,i)=>{
    const t=i/40*Math.PI*2;
    return {x:.5*Math.cos(t),y:.5*Math.sin(t)};
  });
  const round=value=>Math.round(value*100)/100;
  const caption=(value,key)=>key==='angle'?value+'°':typeof value==='number'?value+' px':String(value);
  const clone=value=>structuredClone(value);

  function polygon(part){
    const points=part.shape==='polygon'?part.points:part.shape==='ellipse'?oval:rect;
    const curved=part.shape==='polygon'&&points.some(p=>p.in||p.out);
    const outline=curved?rules.inspect(localOutline(points)):null;
    return (outline?.ok?outline.points.slice(0,-1):points).map(p=>world(part,p));
  }

  function world(part,{x,y}){
    const rad=part.angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);
    return {x:part.x+x*part.width*c-y*part.height*s,y:part.y+x*part.width*s+y*part.height*c};
  }
  function localOutline(points){
    return {closed:true,nodes:points.map(p=>({point:{x:p.x,y:p.y},in:p.in||p,out:p.out||p}))};
  }
  function outline(part){
    if(part.shape!=='polygon') return localOutline(polygon(part));
    return {closed:true,nodes:localOutline(part.points).nodes.map(n=>({
      point:world(part,n.point),in:world(part,n.in),out:world(part,n.out)
    }))};
  }
  const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
  function splitControls(a,b,t){
    const left=mix(a,a.out||a,t),middle=mix(a.out||a,b.in||b,t),right=mix(b.in||b,b,t);
    const incoming=mix(left,middle,t),outgoing=mix(middle,right,t);
    return {left,right,node:{...mix(incoming,outgoing,t),in:incoming,out:outgoing}};
  }
  function nearestSegment(part,point){
    let best={distance:Infinity};
    part.points.forEach((a,index)=>{
      const b=part.points[(index+1)%part.points.length];
      let previous=world(part,a);
      for(let step=1;step<=32;step++){
        const next=world(part,splitControls(a,b,step/32).node);
        const dx=next.x-previous.x,dy=next.y-previous.y;
        const fraction=Math.max(0,Math.min(1,((point.x-previous.x)*dx+(point.y-previous.y)*dy)/(dx*dx+dy*dy||1)));
        const distance=Math.hypot(previous.x+fraction*dx-point.x,previous.y+fraction*dy-point.y);
        if(distance<best.distance) best={index,t:(step-1+fraction)/32,distance};
        previous=next;
      }
    });
    return best;
  }
  function editNode(part,index,kind,local,independent=false){
    if(part.locked||part.shape!=='polygon'||!part.points[index]) throw new Error('请选择可编辑的节点。');
    const points=clone(part.points),a=points[index],b=points[(index+1)%points.length];
    if(kind==='insert'){
      const {left,right,node}=splitControls(a,b,local);
      a.out=left;b.in=right;points.splice(index+1,0,node);
    }else if(kind==='delete'){
      points.splice(index,1);
    }else if(kind==='in'||kind==='out'){
      a[kind]=local;
      if(!independent) a[kind==='in'?'out':'in']={x:2*a.x-local.x,y:2*a.y-local.y};
    }else{
      const x=Math.max(-.5,Math.min(.5,local.x)),y=Math.max(-.5,Math.min(.5,local.y));
      for(const side of ['in','out']) if(a[side]) a[side]={x:a[side].x+x-a.x,y:a[side].y+y-a.y};
      a.x=x;a.y=y;
    }
    const check=rules.inspect(localOutline(points));
    if(!check.ok) return {ok:false,reason:check.reason==='crossing'?'crossing':'invalid'};
    return {ok:true,part:{...part,points}};
  }

  function validate(part,size){
    if(!fields.every(key=>Number.isFinite(part[key]))) throw new Error('请填写有效的部件参数。');
    if(!Number.isFinite(part.depth)||!Number.isFinite(part.z)) throw new Error('请填写有效的部件厚度与深度位置。');
    // 细长部件（表针、指示箭头等）允许窄到 3px；再窄描线闭合都难保证
    if(part.width<3||part.height<3) throw new Error('部件宽高至少为 3 像素。');
    if(part.depth<4) throw new Error('部件厚度至少为 4 像素。');
    if(Math.abs(part.angle)>180) throw new Error('角度应在 -180° 至 180° 之间。');
    if(polygon(part).some(({x,y})=>x<-.001||y<-.001||x>size.width+.001||y>size.height+.001)){
      throw new Error('轮廓超出画布，请缩小、移动或调整角度。');
    }
    return part;
  }

  const defaultDepth=values=>Math.max(4,round(Math.min(values.width||40,values.height||40)*0.6));

  function createPart(id,shape,name,values,size){
    if(!Object.hasOwn(shapeNames,shape)) throw new Error('未知部件轮廓。');
    const title=String(name||'').trim().slice(0,60);
    if(!title) throw new Error('请填写部件名称。');
    const part={id,shape,name:title,locked:values.locked===true};
    for(const key of fields) part[key]=round(values[key]);
    part.depth=Number.isFinite(values.depth)?round(values.depth):defaultDepth(values);
    part.z=Number.isFinite(values.z)?round(values.z):0;
    if(shape==='polygon') part.points=clone(values.points);
    return validate(part,size);
  }

  function tracePart(id,name,stroke,size){
    const reject=()=>new Error('请描出一个闭合、面积足够且不自交的轮廓。');
    if(!Array.isArray(stroke)||stroke.length<3) throw reject();
    // 细长笔画（表针、指示线）：全局容差会把两条近似平行的边简化成自交的退化形状。
    // 用笔画自身包围盒收窄容差，细部件保住两边的节点，重试时再放宽一档。
    const xs=stroke.map(p=>p.x),ys=stroke.map(p=>p.y);
    const strokeSpan=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    const base=Math.max(.8,Math.max(size.width,size.height)/450);
    const tolerance=Math.min(base,Math.max(.6,strokeSpan/10));
    let points=stroke.filter((p,i)=>!i||Math.hypot(p.x-stroke[i-1].x,p.y-stroke[i-1].y)>.25);
    if(points.length>3&&Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<tolerance*2) points.pop();
    let accepted=null;
    for(const t of [tolerance*tolerance,base*base,(tolerance/2)**2]){
      let simplified=rules.simplifyStroke(points,t);
      if(simplified.length>3&&Math.hypot(simplified[0].x-simplified.at(-1).x,simplified[0].y-simplified.at(-1).y)<t) simplified.pop();
      if(simplified.length<3||simplified.length>90) continue;
      const nodes=simplified.map(point=>({point,in:point,out:point}));
      const check=rules.inspect({closed:true,nodes});
      if(check.ok){ accepted=simplified; break; }
    }
    if(!accepted) throw reject();
    const points2=accepted;
    const {x,y,width,height}=rules.inspect({closed:true,nodes:points2.map(point=>({point,in:point,out:point}))}).bounds;
    return createPart(id,'polygon',name,{x:x+width/2,y:y+height/2,width,height,angle:0,
      points:points2.map(p=>({x:(p.x-x)/width-.5,y:(p.y-y)/height-.5}))},size);
  }

  function find(parts,id){
    const part=parts.find(item=>item.id===id);
    if(!part) throw new Error('请先选择一个部件。');
    return part;
  }

  // ── 规整化：把描线轮廓吸附成标准几何，产物仍是 polygon（节点可继续拖，控制权不丢）──
  const TAU=Math.PI*2;
  function measureOutline(points){
    const n=points.length;
    let area=0,perimeter=0,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,cx=0,cy=0;
    for(let i=0;i<n;i++){
      const a=points[i],b=points[(i+1)%n];
      area+=a.x*b.y-b.x*a.y;
      perimeter+=Math.hypot(b.x-a.x,b.y-a.y);
      minX=Math.min(minX,a.x);maxX=Math.max(maxX,a.x);
      minY=Math.min(minY,a.y);maxY=Math.max(maxY,a.y);
      cx+=a.x;cy+=a.y;
    }
    area=Math.abs(area)/2;cx/=n;cy/=n;
    const width=maxX-minX,height=maxY-minY;
    let meanR=0;
    const radii=points.map(point=>Math.hypot(point.x-cx,point.y-cy));
    for(const radius of radii) meanR+=radius;
    meanR/=n;
    let variance=0;
    for(const radius of radii) variance+=(radius-meanR)**2;
    variance/=n;
    // 归一化半径离散度：按包围盒把轮廓拉成单位框后，椭圆也会变成圆——
    // 用它判断「椭圆度」，避免 2:1 的长椭圆被当成自由形。
    const normalizedRadii=points.map(point=>Math.hypot((point.x-cx)/(width||1),(point.y-cy)/(height||1)));
    let meanN=0;
    for(const radius of normalizedRadii) meanN+=radius;
    meanN/=n;
    let varianceN=0;
    for(const radius of normalizedRadii) varianceN+=(radius-meanN)**2;
    varianceN/=n;
    // 角部留白：完美矩形角点贴着包围盒角，圆角矩形会内缩约 0.41r。
    // 用它把「矩形」和「圆角矩形」分开（两者 rectFill 都接近 1）。
    const corners=[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
    let gap=0;
    for(const [qx,qy] of corners){
      let best=Infinity;
      for(const point of points) best=Math.min(best,Math.hypot(point.x-qx,point.y-qy));
      gap+=best;
    }
    const cornerGap=gap/4/Math.max(1,Math.min(width,height));
    return {
      cx,cy,width,height,minX,minY,maxX,maxY,area,perimeter,
      circularity:perimeter>0?4*Math.PI*area/(perimeter*perimeter):0,
      rectFill:width*height>0?area/(width*height):0,
      aspect:height>0?width/height:1,
      radialCv:meanR>0?Math.sqrt(variance)/meanR:1,
      normalizedCv:meanN>0?Math.sqrt(varianceN)/meanN:1,
      cornerGap,
      nodes:n
    };
  }

  // 推荐目标形 + 匹配度；自由形给 null，避免把花瓶强行掰成圆
  function suggestShape(m){
    const nearSquare=Math.abs(m.aspect-1)<=.18;
    // 手绘圆的抖动通常在 ±8%，阈值太紧会把「画得不圆」误判成自由形
    const elliptic=m.normalizedCv<=.115;
    // 先按面积率排掉矩形/圆角矩形（两者 rectFill 都接近 1），再判椭圆度
    if(m.rectFill>=.93&&m.cornerGap<.025) return {target:'rectangle',score:Math.min(1,m.rectFill)};
    if(m.rectFill>=.9) return {target:'rounded',score:Math.min(1,m.rectFill*.95)};
    if(elliptic&&nearSquare) return {target:'circle',score:Math.max(0,1-m.normalizedCv*4)};
    if(elliptic) return {target:'ellipse',score:Math.max(0,1-m.normalizedCv*4)};
    if(m.rectFill>=.8) return {target:'rounded',score:Math.min(1,m.rectFill*.95)};
    return {target:null,score:0};
  }

  // 生成标准形轮廓点（世界坐标）。圆/椭圆 16 点、矩形 4 点、圆角矩形 12 点，都够拖也够顺。
  function standardPoints(target,m,corner=.16){
    const {cx,cy,width,height,minX,minY,maxX,maxY}=m;
    if(target==='circle'){
      const radius=(width+height)/4;
      return Array.from({length:16},(_,i)=>{const t=i/16*TAU;return {x:cx+radius*Math.cos(t),y:cy+radius*Math.sin(t)};});
    }
    if(target==='ellipse'){
      return Array.from({length:16},(_,i)=>{const t=i/16*TAU;return {x:cx+width/2*Math.cos(t),y:cy+height/2*Math.sin(t)};});
    }
    if(target==='rectangle') return [{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}];
    if(target==='rounded'){
      const radius=Math.min(width,height)*Math.max(.02,Math.min(.45,corner));
      const points=[];
      const corners=[[minX+radius,minY+radius,Math.PI,1.5*Math.PI],[maxX-radius,minY+radius,1.5*Math.PI,2*Math.PI],
        [maxX-radius,maxY-radius,0,.5*Math.PI],[minX+radius,maxY-radius,.5*Math.PI,Math.PI]];
      for(const [ox,oy,from,to] of corners){
        for(let step=0;step<3;step++){const t=from+(to-from)*step/2;points.push({x:ox+radius*Math.cos(t),y:oy+radius*Math.sin(t)});}
      }
      return points;
    }
    return null;
  }

  // 把部件规整成 target；不传 target 时按推荐走。锁定部件拒绝，自由形拒绝（除非显式指定）。
  function regularize(part,size,options={}){
    if(!part) throw new Error('请先选择一个部件。');
    if(part.locked) throw new Error('部件已锁定，先解锁再规整。');
    if(part.shape==='polygon'&&(part.points||[]).length<3) throw new Error('这个部件没有可规整的轮廓。');
    const points=polygon(part);
    if(points.length<3) throw new Error('这个部件没有可规整的轮廓。');
    const metrics=measureOutline(points);
    const suggestion=suggestShape(metrics);
    const target=options.target||suggestion.target;
    if(!target) return {ok:false,reason:'freeform',metrics,suggestion,message:'这个轮廓更像自由造型，规整会丢掉特征。需要的话可以手动选一个标准形。'};
    const standard=standardPoints(target,metrics,options.corner);
    if(!standard||standard.length<3) return {ok:false,reason:'unsupported',metrics,suggestion,message:'暂不支持这种标准形。'};
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const point of standard){
      minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);
      minY=Math.min(minY,point.y);maxY=Math.max(maxY,point.y);
    }
    const width=Math.max(3,maxX-minX),height=Math.max(3,maxY-minY);
    const next={
      ...clone(part),
      shape:'polygon',
      angle:0,
      x:minX+width/2,
      y:minY+height/2,
      width,
      height,
      points:standard.map(point=>({
        x:round((point.x-minX)/width-.5),
        y:round((point.y-minY)/height-.5)
      }))
    };
    if(target==='circle'||target==='ellipse'){
      const step=2*Math.PI/next.points.length;
      const tangent=2/3*Math.tan(step/4);
      next.points=next.points.map((_,index)=>{
        const t=index*step, x=.5*Math.cos(t),y=.5*Math.sin(t);
        const dx=-Math.sin(t)*tangent,dy=Math.cos(t)*tangent;
        return {x,y,in:{x:x-dx,y:y-dy},out:{x:x+dx,y:y+dy}};
      });
    }
    try{ validate(next,size); }
    catch(error){
      // 圆化可能把轮廓顶出画布，按比例收回到边界内
      const scale=Math.min(1,(size.width-4)/width,(size.height-4)/height);
      if(scale>=.999) return {ok:false,reason:'out-of-canvas',metrics,suggestion,message:error.message};
      next.width=Math.max(3,round(width*scale));
      next.height=Math.max(3,round(height*scale));
      next.x=Math.min(size.width-next.width/2-1,Math.max(next.width/2+1,next.x));
      next.y=Math.min(size.height-next.height/2-1,Math.max(next.height/2+1,next.y));
      validate(next,size);
    }
    next.updatedAt=part.updatedAt;
    next.name=part.name;
    return {ok:true,part:next,target,score:suggestion.target===target?suggestion.score:null,
      suggestion,metrics,changed:target!==(part.shape==='polygon'?'freeform':part.shape)};
  }

  // 轮廓特征（供 UI 显示匹配度，不落盘）
  function describeOutline(part){
    const points=polygon(part);
    if(points.length<3) return null;
    const metrics=measureOutline(points);
    return {metrics,suggestion:suggestShape(metrics)};
  }

  function updatePart(parts,id,patch,size){
    const part=find(parts,id);
    const lockOnly=Object.keys(patch).length===1&&typeof patch.locked==='boolean';
    if(part.locked&&!lockOnly) throw new Error('该部件已锁定，请先解除锁定。');
    const next={...part};
    if(lockOnly) next.locked=patch.locked;
    else{
      for(const key of fields) if(Object.hasOwn(patch,key)) next[key]=round(patch[key]);
      for(const key of ['depth','z']) if(Object.hasOwn(patch,key)) next[key]=round(patch[key]);
      // 描线部件拖节点：points 是归一化局部坐标，只对多边形开放
      if(Array.isArray(patch.points)&&next.shape==='polygon'){
        if(!rules.inspect(localOutline(patch.points)).ok) throw new Error('轮廓必须闭合且不自交。');
        next.points=clone(patch.points);
      }
      if(Object.hasOwn(patch,'name')){
        next.name=String(patch.name||'').trim().slice(0,60);
        if(!next.name) throw new Error('请填写部件名称。');
      }
    }
    validate(next,size);
    if(!lockOnly&&part.shape==='polygon'&&parts.some(item=>item.locked)){
      const fixed=parts.filter(item=>item.locked).flatMap(item=>outline(item).nodes.map(n=>n.point));
      const retained=outline(next).nodes.map(n=>n.point);
      const same=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)<.001;
      if(outline(part).nodes.some(({point})=>fixed.some(p=>same(p,point))&&!retained.some(p=>same(p,point)))){
        throw new Error('与锁定部件共用的节点不能移动或删除。');
      }
    }
    return parts.map(item=>item.id===id?next:item);
  }

  function removePart(parts,id){
    if(find(parts,id).locked) throw new Error('该部件已锁定，请先解除锁定。');
    return parts.filter(part=>part.id!==id);
  }

  function variants(parts,id,key,amount,size){
    const part=find(parts,id);
    if(part.locked) throw new Error('该部件已锁定，请选择可改的部件。');
    if(!['width','height','angle','depth'].includes(key)||!Number.isFinite(amount)||amount<5||amount>40){
      throw new Error('请选择宽度、高度、角度或厚度，幅度应在 5 至 40 之间。');
    }
    const result=[], seen=new Set([part[key]]);
    for(const weight of [-1,.5,1]){
      const value=round(part[key]+weight*amount*(key==='angle'?1:part[key]/100));
      if(seen.has(value)) continue;
      let next;
      try { next=updatePart(parts,id,{[key]:value},size); }
      catch { continue; }
      seen.add(value);
      const delta=weight*amount, suffix=key==='angle'?'°':'%';
      result.push({parts:clone(next),label:labels[key]+' '+(delta>0?'+':'')+delta+suffix});
    }
    if(!result.length) throw new Error('候选超出画布或参数范围，请减小变动幅度。');
    return result;
  }

  // 拖动描线部件的一个节点（归一化局部坐标，钳在部件包围盒内）。
  // 自交/退化时返回 {ok:false,reason}，调用方据此丢弃本次移动（自动回退到上一合法形状）。
  function moveNode(part,index,local){
    if(part.shape!=='polygon'||!Array.isArray(part.points)) throw new Error('只有描线部件可以拖动节点。');
    if(part.locked) throw new Error('该部件已锁定，请先解除锁定。');
    if(!Number.isInteger(index)||index<0||index>=part.points.length) throw new Error('节点不存在。');
    return editNode(part,index,'anchor',local);
  }

  function diff(base,next){
    const previous=new Map(base.map(part=>[part.id,part]));
    const changes=[];
    for(const part of next){
      const before=previous.get(part.id);
      previous.delete(part.id);
      if(!before){
        changes.push({id:part.id,name:part.name,type:'added',fields:[]});
        continue;
      }
      const changed=[...spatialFields,'name','shape'].filter(key=>before[key]!==part[key])
        .map(key=>({key,label:labels[key],before:before[key],after:part[key]}));
      if(part.shape==='polygon'&&before.shape==='polygon'&&JSON.stringify(before.points)!==JSON.stringify(part.points)){
        if(before.points.length!==part.points.length){
          changed.push({key:'nodes',label:'节点数量',before:String(before.points.length),after:String(part.points.length)});
        }else{
          const format=p=>[p,p.in,p.out].filter(Boolean).map(q=>'('+[q.x,q.y].map(v=>Number(v.toFixed(4))).join(', ')+')').join(' ');
          part.points.forEach((p,index)=>{
            const old=before.points[index];
            if(JSON.stringify(old)!==JSON.stringify(p)) changed.push({key:'node',label:'节点 '+(index+1)+'（局部坐标）',before:format(old),after:format(p)});
          });
        }
      }
      if(changed.length) changes.push({id:part.id,name:part.name,type:'changed',fields:changed});
    }
    for(const part of previous.values()) changes.push({id:part.id,name:part.name,type:'removed',fields:[]});
    return changes;
  }

  function editRegion(parts,id,size){
    const target=find(parts,id);
    if(target.locked) throw new Error('该部件已锁定，请选择可改的部件。');
    const normalized=part=>polygon(part).map(({x,y})=>({x:Math.min(1,Math.max(0,x/size.width)),y:Math.min(1,Math.max(0,y/size.height))}));
    return {points:normalized(target),protectedAreas:parts.filter(part=>part.id!==id).map(normalized)};
  }

  function snapshot(asset){
    return {parentId:asset.id,parentName:asset.name,revision:asset.draft.revision,parts:clone(asset.draft.parts)};
  }

  /* ── 深度维度：迁移、三视图推导、体块投影（融合自 11-04 结构空间原型） ── */

  // 旧草稿部件缺 depth/z 时返回 true（读取处据此一次性迁移落盘）
  function needsNormalize(parts){
    return Array.isArray(parts)&&parts.some(part=>!Number.isFinite(part?.depth)||!Number.isFinite(part?.z));
  }
  function normalizeParts(parts){
    return (parts||[]).map(part=>{
      if(Number.isFinite(part.depth)&&Number.isFinite(part.z)) return part;
      const next={...part};
      if(!Number.isFinite(next.depth)) next.depth=defaultDepth(next);
      if(!Number.isFinite(next.z)) next.z=0;
      next.depth=round(next.depth);
      return next;
    });
  }

  // 轮廓的轴对齐包围盒（已含旋转）。侧视/俯视与体块都用它，
  // 保证「角度改了，三视图与体块仍是同一个物体」。
  function outlineBounds(part){
    const points=polygon(part);
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const {x,y} of points){
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y;
    }
    return {x:minX,y:minY,width:maxX-minX,height:maxY-minY};
  }

  // 侧视投影：横轴=深度，竖轴=旋转后轮廓的高度区间
  function sideRect(part){
    const box=outlineBounds(part);
    return {x:part.z-part.depth/2,y:box.y,width:part.depth,height:box.height};
  }
  // 俯视投影：横轴=旋转后轮廓的宽度区间，纵轴=深度
  function topRect(part){
    const box=outlineBounds(part);
    return {x:box.x,y:part.z-part.depth/2,width:box.width,height:part.depth};
  }
  // 所有部件占用的深度区间（三视图格宽与对齐用）
  function depthSpan(parts){
    if(!parts.length) return {min:0,max:0};
    let min=Infinity,max=-Infinity;
    for(const part of parts){
      min=Math.min(min,part.z-part.depth/2);
      max=Math.max(max,part.z+part.depth/2);
    }
    return {min,max};
  }

  // 体块投影（P2/P5）：把部件真实轮廓沿深度挤成棱柱，再按方位/俯仰投影。
  // 与二维轮廓、侧/俯视同一份几何，所以转动角度时体块与三视图始终是同一个物体。
  // 返回可见面（远→近），shade∈[0.3,1] 供页面配色。
  function blockFaces(part,az=0.5,el=0.42){
    const outline=polygon(part);
    if(outline.length<3) return [];
    const half=Math.max(2,part.depth/2);
    // 统一绕向：屏幕坐标下鞋带面积为正=顺时针，此时边 (dx,dy) 的外法线为 (dy,-dx)
    let signed=0;
    for(let i=0;i<outline.length;i++){
      const a=outline[i],b=outline[(i+1)%outline.length];
      signed+=a.x*b.y-b.x*a.y;
    }
    const ring=signed<0?[...outline].reverse():outline;
    const ca=Math.cos(az),sa=Math.sin(az),ce=Math.cos(el),se=Math.sin(el);
    const project=(x,y,z)=>{
      const x1=x*ca-z*sa,z1=x*sa+z*ca;
      return {x:x1,y:y*ce-z1*se,d:y*se+z1*ce};
    };
    const rotateNormal=(nx,ny,nz)=>{
      const rx=nx*ca-nz*sa,rz=nx*sa+nz*ca;
      return {x:rx,y:ny*ce-rz*se,z:ny*se+rz*ce};
    };
    const light=rotateNormal(-0.45,-0.72,-0.53);
    const faceOf=(id,normal,points3)=>{
      const projected=points3.map(([x,y,z])=>project(x,y,z));
      return {id,normal:rotateNormal(normal[0],normal[1],normal[2]),
        depth:projected.reduce((sum,p)=>sum+p.d,0)/projected.length,points:projected};
    };
    const faces=[
      faceOf('front',[0,0,-1],ring.map(p=>[p.x,p.y,part.z-half])),
      faceOf('back',[0,0,1],ring.map(p=>[p.x,p.y,part.z+half]))
    ];
    for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length];
      const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
      faces.push(faceOf('wall-'+i,[dy/len,-dx/len,0],
        [[a.x,a.y,part.z-half],[b.x,b.y,part.z-half],[b.x,b.y,part.z+half],[a.x,a.y,part.z+half]]));
    }
    return faces
      .filter(face=>face.normal.z<0) // 法线朝向相机（观察系 z 分量为负）才可见
      .map(face=>{
        const shade=Math.min(1,Math.max(0.3,
          0.45+0.55*Math.max(0,face.normal.x*light.x+face.normal.y*light.y+face.normal.z*light.z)));
        return {id:face.id,points:face.points,shade};
      })
      .sort((a,b)=>b.depth-a.depth);
  }
  // 部件在观察系中的中心深度（多部件画家算法排序用：远的先画）
  function blockDepth(part,az){
    const ca=Math.cos(az),sa=Math.sin(az);
    return part.x*sa+part.z*ca;
  }

  return {labels,shapeNames,caption,polygon,createPart,tracePart,updatePart,removePart,variants,diff,editRegion,snapshot,moveNode,editNode,nearestSegment,outline,world,
    needsNormalize,normalizeParts,outlineBounds,sideRect,topRect,depthSpan,blockFaces,blockDepth,defaultDepth,
    regularize,describeOutline,measureOutline,suggestShape,standardPoints};
});

