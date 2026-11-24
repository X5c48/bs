// 造型流程阶段状态（整体规划 P0 收口）：冻结快照 + 过期标记 + 前进条件。
// 纯函数、无 DOM，供图像工作室与部件推敲两页共用；数据落在 asset.flow.stages。
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.WuyingFlowStages=factory();
})(globalThis,function(){
  'use strict';
  const ORDER=['sketch','refine','ortho','render'];
  const STAGE_NAMES={sketch:'草图造型',refine:'精细微调',ortho:'三视图',render:'产品渲染'};
  const round=value=>Math.round(value*100)/100;

  // 画布图层摘要：图层增删、显隐、透明度、笔迹数量与笔迹几何都会改变签名。
  // 用于判断「上游草图改过了没有」（对照进入下一阶段时冻结的快照）。
  // 笔迹点取整后参与哈希（每层最多 64 笔、每笔最多 24 点），原地改一笔也算改过。
  function strokeSig(strokes){
    return (strokes||[]).slice(0,64).map(stroke=>{
      const points=stroke.points||[];
      const stride=Math.max(1,Math.ceil(points.length/24));
      return [
        stroke.erase?'e':'d',
        points.filter((_,i)=>i%stride===0).map(p=>[Math.round(p.x),Math.round(p.y)]),
        Math.round(stroke.size||0)
      ];
    });
  }
  function layersSig(layers){
    return JSON.stringify((layers||[]).map(layer=>[
      layer.id,layer.kind||'',layer.blobId||null,
      layer.visible!==false,round(layer.opacity==null?1:layer.opacity),
      (layer.strokes||[]).length,layer.kind==='ink'?strokeSig(layer.strokes):null
    ]));
  }

  // 把 fromStage 之后所有已存在的阶段条目标记为 stale（或清除）。
  // 只动已有条目：用户从没到过的阶段不显示橙点。
  function markStale(flow,fromStage,stale=true){
    const stages=flow.stages||(flow.stages={});
    const from=ORDER.indexOf(fromStage);
    if(from<0) return flow;
    for(const stage of ORDER.slice(from+1)){
      if(stages[stage]) stages[stage]={...stages[stage],stale};
    }
    return flow;
  }

  // 记录进入某阶段的冻结快照，并清除该阶段的过期标记。
  function capture(flow,stage,snapshot){
    const stages=flow.stages||(flow.stages={});
    const previous=stages[stage]||{};
    stages[stage]={...previous,snapshot,at:Date.now(),stale:false};
    return flow;
  }

  // 与冻结快照比较：旧版快照（无笔迹几何）按旧口径比较，避免升级后全量误报过期。
  function sigMatches(layers,snapshotSig){
    if(typeof snapshotSig!=='string') return false;
    let parsed;
    try{ parsed=JSON.parse(snapshotSig); }catch{ return false; }
    if(!Array.isArray(parsed)) return false;
    const current=JSON.parse(layersSig(layers));
    const isLegacy=parsed.some(entry=>Array.isArray(entry)&&entry.length===6);
    if(isLegacy){
      if(parsed.length!==current.length) return false;
      return parsed.every((entry,index)=>{
        const now=current[index];
        return Array.isArray(now)&&entry[0]===now[0]&&entry[1]===now[1]&&entry[2]===now[2]
          &&entry[3]===now[3]&&entry[4]===now[4]&&entry[5]===now[5];
      });
    }
    return JSON.stringify(current)===snapshotSig;
  }

  function staleOf(flow,stage){
    return !!(flow&&flow.stages&&flow.stages[stage]&&flow.stages[stage].stale);
  }

  function normalizeStage(stage){
    return ORDER.includes(stage)?stage:'sketch';
  }

  return {ORDER,STAGE_NAMES,layersSig,sigMatches,strokeSig,markStale,capture,staleOf,normalizeStage};
});
