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
    const angle=part.angle*Math.PI/180, c=Math.cos(angle),s=Math.sin(angle);
    return points.map(({x,y})=>({
      x:part.x+x*part.width*c-y*part.height*s,
      y:part.y+x*part.width*s+y*part.height*c
    }));
  }

  function validate(part,size){
    if(!fields.every(key=>Number.isFinite(part[key]))) throw new Error('请填写有效的部件参数。');
    if(!Number.isFinite(part.depth)||!Number.isFinite(part.z)) throw new Error('请填写有效的部件厚度与深度位置。');
    if(part.width<8||part.height<8) throw new Error('部件宽高至少为 8 像素。');
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
    const tolerance=Math.max(.8,Math.max(size.width,size.height)/450);
    let points=stroke.filter((p,i)=>!i||Math.hypot(p.x-stroke[i-1].x,p.y-stroke[i-1].y)>.25);
    if(points.length>3&&Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<tolerance*2) points.pop();
    points=rules.simplifyStroke(points,tolerance*tolerance);
    if(points.length<3||points.length>90) throw reject();
    const nodes=points.map(point=>({point,in:point,out:point}));
    const check=rules.inspect({closed:true,nodes});
    if(!check.ok) throw reject();
    const {x,y,width,height}=check.bounds;
    return createPart(id,'polygon',name,{x:x+width/2,y:y+height/2,width,height,angle:0,
      points:points.map(p=>({x:(p.x-x)/width-.5,y:(p.y-y)/height-.5}))},size);
  }

  function find(parts,id){
    const part=parts.find(item=>item.id===id);
    if(!part) throw new Error('请先选择一个部件。');
    return part;
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
      if(Array.isArray(patch.points)&&next.shape==='polygon') next.points=clone(patch.points);
      if(Object.hasOwn(patch,'name')){
        next.name=String(patch.name||'').trim().slice(0,60);
        if(!next.name) throw new Error('请填写部件名称。');
      }
    }
    validate(next,size);
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
    const clampLocal=value=>Math.min(.5,Math.max(-.5,value));
    const points=part.points.map((point,i)=>i===index
      ?{x:round(clampLocal(local.x)),y:round(clampLocal(local.y))}:point);
    const nodes=points.map(point=>({point,in:point,out:point}));
    const check=rules.inspect({closed:true,nodes});
    if(!check.ok) return {ok:false,reason:check.reason==='crossing'?'crossing':'invalid'};
    return {ok:true,part:{...part,points:clone(points)}};
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

  return {labels,shapeNames,caption,polygon,createPart,tracePart,updatePart,removePart,variants,diff,editRegion,snapshot,moveNode,
    needsNormalize,normalizeParts,outlineBounds,sideRect,topRect,depthSpan,blockFaces,blockDepth,defaultDepth};
});

