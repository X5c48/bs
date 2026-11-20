(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./sketch-rules.js'));
  else root.WuyingShapeModel=factory(root.WuyingSketchRules);
})(globalThis,function(rules){
  'use strict';
  const labels={x:'中心 X',y:'中心 Y',width:'宽度',height:'高度',angle:'角度',name:'名称',shape:'轮廓'};
  const shapeNames={rectangle:'矩形',ellipse:'椭圆',polygon:'描线'};
  const fields=['x','y','width','height','angle'];
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
    if(part.width<8||part.height<8) throw new Error('部件宽高至少为 8 像素。');
    if(Math.abs(part.angle)>180) throw new Error('角度应在 -180° 至 180° 之间。');
    if(polygon(part).some(({x,y})=>x<-.001||y<-.001||x>size.width+.001||y>size.height+.001)){
      throw new Error('轮廓超出画布，请缩小、移动或调整角度。');
    }
    return part;
  }

  function createPart(id,shape,name,values,size){
    if(!Object.hasOwn(shapeNames,shape)) throw new Error('未知部件轮廓。');
    const title=String(name||'').trim().slice(0,60);
    if(!title) throw new Error('请填写部件名称。');
    const part={id,shape,name:title,locked:values.locked===true};
    for(const key of fields) part[key]=round(values[key]);
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
    if(!['width','height','angle'].includes(key)||!Number.isFinite(amount)||amount<5||amount>40){
      throw new Error('请选择宽度、高度或角度，幅度应在 5 至 40 之间。');
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
      const changed=[...fields,'name','shape'].filter(key=>before[key]!==part[key])
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

  return {labels,shapeNames,caption,polygon,createPart,tracePart,updatePart,removePart,variants,diff,editRegion,snapshot};
});

