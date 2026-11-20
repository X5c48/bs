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

  // 画布图层摘要：图层增删、显隐、透明度、笔迹数、位图替换都会改变签名。
  // 用于判断「上游草图改过了没有」（对照进入下一阶段时冻结的快照）。
  function layersSig(layers){
    return JSON.stringify((layers||[]).map(layer=>[
      layer.id,layer.kind||'',layer.blobId||null,
      layer.visible!==false,round(layer.opacity==null?1:layer.opacity),
      (layer.strokes||[]).length
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

  function staleOf(flow,stage){
    return !!(flow&&flow.stages&&flow.stages[stage]&&flow.stages[stage].stale);
  }

  function normalizeStage(stage){
    return ORDER.includes(stage)?stage:'sketch';
  }

  return {ORDER,STAGE_NAMES,layersSig,markStale,capture,staleOf,normalizeStage};
});
