// 草图造型模块 · 造型发散与造型裂变（纯逻辑，无 DOM 依赖，可在 Node 里测）
// 裂变：对草图笔迹做矢量几何变换——产物仍是可编辑的 stroke，不是一张死图。
// 发散：同一造型按不同设计方向出图，用来快速铺开概念。
( function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WuyingSketchExplore = factory();
} )(globalThis, function () {
  'use strict';

  const clamp01 = value => Math.min(1, Math.max(0, value));

  // 裂变变换表：p 为归一化坐标（0..1），c 含重心与平均半径。
  const transforms = [
    { id:'slender', label:'修长', note:'收紧横向、拉长纵向', apply:(p,c)=>({x:c.x+(p.x-c.x)*.8, y:c.y+(p.y-c.y)*1.2}) },
    { id:'sturdy', label:'敦实', note:'放宽横向、压低纵向', apply:(p,c)=>({x:c.x+(p.x-c.x)*1.24, y:c.y+(p.y-c.y)*.84}) },
    { id:'lean', label:'前倾', note:'上半部前移形成动势', apply:(p,c)=>({x:p.x+(c.y-p.y)*.16, y:p.y}) },
    { id:'mirror', label:'镜像', note:'左右翻转对照', apply:p=>({x:1-p.x, y:p.y}) },
    { id:'offset', label:'错位', note:'上下两段错开，形成分层', apply:(p,c)=>({x:p.x+(p.y<c.y?.075:-.075), y:p.y}) },
    { id:'round', label:'圆化', note:'轮廓半径向均值收敛', apply:(p,c)=>{
      const dx=p.x-c.x, dy=p.y-c.y, radius=Math.hypot(dx,dy);
      if(radius<1e-4||!c.avgR) return {x:p.x,y:p.y};
      const target=radius*.5+c.avgR*.5, k=target/radius;
      return {x:c.x+dx*k, y:c.y+dy*k};
    } }
  ];

  const byId = id => transforms.find(item => item.id === id) || null;

  // 收集所有笔迹点，给出重心与平均半径（圆化需要）
  function frameOf(layers) {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    const points=[];
    for (const layer of layers || []) {
      if (layer.visible === false) continue;
      for (const stroke of layer.strokes || []) {
        for (const point of stroke.points || []) {
          if(!Number.isFinite(point.x)||!Number.isFinite(point.y)) continue;
          points.push(point);
          if(point.x<minX) minX=point.x; if(point.x>maxX) maxX=point.x;
          if(point.y<minY) minY=point.y; if(point.y>maxY) maxY=point.y;
        }
      }
    }
    if (!points.length) return null;
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    let sum=0;
    for (const point of points) sum+=Math.hypot(point.x-cx, point.y-cy);
    return { x:cx, y:cy, avgR:sum/points.length, count:points.length };
  }

  // 把一条笔迹按变换重采样，点太密时抽稀，避免变体资产膨胀
  function mapStroke(stroke, frame, apply) {
    const mapped = (stroke.points || []).map(point => {
      const next = apply(point, frame);
      return { x:clamp01(next.x), y:clamp01(next.y) };
    });
    const step = Math.max(1, Math.ceil(mapped.length / 240));
    const keep = step === 1 ? mapped : mapped.filter((_, index) => index % step === 0);
    return { ...stroke, points: keep };
  }

  // 裂变：返回若干变体 {id,label,note,layers}；layers 结构与源资产一致，可直接落盘继续编辑
  function fission(asset, options = {}) {
    const layers = asset?.layers || [];
    const frame = frameOf(layers);
    if (!frame) return [];
    const wanted = Array.isArray(options.ids) && options.ids.length
      ? options.ids.map(byId).filter(Boolean)
      : transforms;
    const count = Number.isInteger(options.count) && options.count > 0 ? options.count : wanted.length;
    return wanted.slice(0, count).map(transform => ({
      id: transform.id,
      label: transform.label,
      note: transform.note,
      layers: layers
        .filter(layer => layer.visible !== false)
        .map(layer => ({
          ...layer,
          id: layer.id,
          strokes: (layer.strokes || []).map(stroke => mapStroke(stroke, frame, transform.apply))
        }))
    }));
  }

  // 发散用的设计方向；prompt 同时给 SD 与 Qwen 通道使用
  const directions = [
    { id:'minimal', label:'极简几何', prompt:'ultra-minimal geometric product design, clean straight edges, single uniform surface, matte finish, neutral palette' },
    { id:'organic', label:'有机曲面', prompt:'organic soft product design, continuous curved surfaces, rounded transitions, warm off-white ceramic finish' },
    { id:'industrial', label:'复古工业', prompt:'retro industrial product design, exposed fasteners, painted metal housing, warm ivory and olive palette, utilitarian details' },
    { id:'precise', label:'科技精密', prompt:'precision engineered product design, tight tolerances, anodized aluminium and glass, cool grey palette, subtle machined details' },
    { id:'soft', label:'软性圆润', prompt:'soft-touch rounded product design, generous fillets, silicone accents, pastel palette, friendly proportions' },
    { id:'faceted', label:'硬朗棱面', prompt:'faceted angular product design, planar surfaces and crisp chamfers, dark graphite finish, high contrast lighting' }
  ];

  function chooseDirections(count) {
    const n = Number.isInteger(count) && count > 0 ? count : directions.length;
    return directions.slice(0, Math.min(n, directions.length));
  }

  // 发散：逐方向出图。generate 由调用方注入（workbench 传 workspace-render），便于测试与复用。
  async function diverge(options) {
    const { asset, source, generate, count, signal, onStatus, strength = .72 } = options;
    if (!asset || !source || typeof generate !== 'function') throw new Error('造型发散缺少源图或出图通道。');
    const picked = chooseDirections(count);
    const results = [];
    for (const [index, direction] of picked.entries()) {
      signal?.throwIfAborted?.();
      onStatus?.('方向 ' + (index + 1) + '/' + picked.length + ' · ' + direction.label);
      const blob = await generate({
        kind: 'render',
        source,
        prompt: direction.prompt,
        strength,
        size: { width: asset.width || 1024, height: asset.height || 768 },
        seed: (Date.now() + index * 7919) >>> 0,
        signal
      });
      signal?.throwIfAborted?.();
      results.push({ id: direction.id, label: direction.label, prompt: direction.prompt, blob });
    }
    return results;
  }

  return { transforms, directions, byId, frameOf, fission, diverge, chooseDirections };
});
