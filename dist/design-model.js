// 方案结构数据模型（整体规划 P1）：design 结构 + 旧 draft 读取时迁移 + 方案级 design.locks。
// 纯函数、无 DOM；锁定按部件 ID 存在方案级，草图/微调/三视图/渲染读同一张表。
// 迁移无损保留 draft 一个版本周期作回退（读取处一次性落盘，见规划 6.3）。
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.WuyingDesignModel=factory();
})(globalThis,function(){
  'use strict';
  const round=value=>Math.round(value*100)/100;
  const TAU=Math.PI*2;

  // 部件轮廓（shape-model 的归一化局部坐标）→ 画布绝对坐标采样点
  function partPoints(part){
    const local=part.shape==='polygon'?part.points
      :part.shape==='ellipse'?Array.from({length:40},(_,i)=>{
        const t=i/40*TAU;
        return {x:.5*Math.cos(t),y:.5*Math.sin(t)};
      })
      :[{x:-.5,y:-.5},{x:.5,y:-.5},{x:.5,y:.5},{x:-.5,y:.5}];
    const angle=(part.angle||0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
    return local.map(({x,y})=>({
      x:round(part.x+x*part.width*c-y*part.height*s),
      y:round(part.y+x*part.width*s+y*part.height*c)
    }));
  }

  // 采样点 → 闭合轮廓的贝塞尔节点（直线段：in/out 都指回锚点，与 sketch-rules 节点结构一致）
  function toOutline(points){
    const nodes=points.map(point=>({point,in:{...point},out:{...point}}));
    return {closed:true,nodes};
  }

  // 部件集合占用的深度区间总长（三视图共享尺寸）
  function depthOf(parts){
    let min=Infinity,max=-Infinity;
    for(const part of parts||[]){
      min=Math.min(min,(part.z||0)-(part.depth||0)/2);
      max=Math.max(max,(part.z||0)+(part.depth||0)/2);
    }
    return Number.isFinite(min)?round(max-min):0;
  }

  // 旧 draft → design（纯函数，不改入参）
  function fromDraft(asset){
    const draft=asset.draft||{};
    const parts=Array.isArray(draft.parts)?draft.parts:[];
    const meta={},locks={},outlines={};
    for(const part of parts){
      meta[part.id]={name:part.name,material:part.material||'',color:part.color||''};
      if(part.locked) locks[part.id]=true;
      outlines[part.id]=toOutline(partPoints(part));
    }
    return {
      revision:draft.revision||'m0',
      parts:meta,
      locks,
      views:{front:{
        revision:draft.revision||'m0',
        reference:draft.reference?{...draft.reference}:null,
        outlines
      }},
      bounds:{width:asset.width||0,height:asset.height||0,depth:depthOf(parts)}
    };
  }

  function needsMigration(asset){
    return !!(asset&&asset.draft&&!asset.design);
  }

  // 迁移落盘（在 store.change 回调里对目标资产调用）；返回是否写了
  function migrate(asset){
    if(!needsMigration(asset)) return false;
    asset.design=fromDraft(asset);
    return true;
  }

  // 方案级锁定表：优先 design.locks，没迁移时从 draft 部件推导（只读兜底）
  function locksOf(asset){
    if(asset?.design?.locks) return {...asset.design.locks};
    const locks={};
    for(const part of asset?.draft?.parts||[]) if(part.locked) locks[part.id]=true;
    return locks;
  }

  // 写锁定：design.locks 为唯一真实源，同时同步 draft 部件的 locked（双写过渡期，
  // 让像素链路 editRegion/renderRegion 继续按 part.locked 工作）。
  // 在 store.change 回调里调用；design 缺失时就地迁移补建。返回是否找到部件。
  function applyLock(asset,partId,locked){
    if(!asset) return false;
    if(!asset.design) migrate(asset);
    const part=(asset.draft?.parts||[]).find(item=>item.id===partId);
    if(!part) return false;
    part.locked=!!locked;
    if(locked) asset.design.locks[partId]=true;
    else delete asset.design.locks[partId];
    return true;
  }

  return {partPoints,toOutline,depthOf,fromDraft,needsMigration,migrate,locksOf,applyLock};
});
