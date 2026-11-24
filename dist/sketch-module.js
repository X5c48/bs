// Concept alternatives remain independent assets and inherit the source brief.
window.WuyingSketchModule = function ({store, projectId, sourceId, settings, flush, connect}) {
  const panel = document.getElementById('conceptPanel');
  const message = panel.querySelector('[role=status]');
  const links = panel.querySelector('nav');
  const buttons = Array.from(panel.querySelectorAll('[data-concept]'));
  const uid = () => crypto.randomUUID();
  async function refresh() {
    const doc = await store.read();
    links.replaceChildren();
    for (const item of Object.values(doc.assets).filter(a => a.variant?.of === sourceId)) {
      const link = document.createElement('a');
      link.href = 'image-studio.html?' + new URLSearchParams({project:projectId,asset:item.id,stage:'sketch'});
      link.textContent = item.name;
      links.append(link);
    }
  }
  for (const button of buttons) button.onclick = async () => {
    buttons.forEach(b => b.disabled = true);
    try {
      await flush();
      const asset = (await store.read()).assets[sourceId];
      const count = Number(panel.querySelector('select').value);
      const mode = button.dataset.concept;
      const prefs = settings();
      if (mode === 'diverge' && !WuyingWorkflow.ready(prefs)) { connect(); return; }
      const brief = asset.flow?.brief || {};
      const variants = mode === 'fission' ? WuyingSketchExplore.fission(asset,{count}) :
        await WuyingSketchExplore.diverge({asset,count,source:await WuyingWorkspaceComposite.toPng(asset,store),
          onStatus: text => message.textContent = text,
          generate: options => WuyingWorkspaceRender.generate({...prefs,...options,
            prompt:[options.prompt,brief.category,brief.text].filter(Boolean).join('. ')})});
      if (!variants.length) throw new Error('请先用画笔绘制造型，再生成裂变方案。');
      const blobs = [];
      const assets = variants.map(v => {
        let layers = v.layers;
        if (v.blob) {
          const blobId = uid();
          blobs.push({id:blobId,blob:v.blob});
          layers = [{id:uid(),name:v.label,kind:'image',blobId,visible:true,opacity:1}];
        }
        return {id:uid(),name:asset.name+' · '+v.label,width:asset.width,height:asset.height,
          layers,flow:{stage:'sketch',brief:structuredClone(brief)},createdAt:Date.now(),updatedAt:Date.now(),
          variant:{of:sourceId,mode,label:v.label,[mode==='diverge'?'direction':'transform']:v.id}};
      });
      await store.change(doc => {
        const right = Math.max(asset.x || 0,...Object.values(doc.assets).map(a=>Number(a.x)||0));
        assets.forEach((a,i)=>{doc.assets[a.id]={...a,x:right+340*(i+1),y:asset.y||0};});
      },blobs);
      await refresh();
      message.textContent = '已保存 '+assets.length+' 个方案，点击方案可继续调整。';
    } catch (e) { message.textContent = e.message; }
    finally { buttons.forEach(b => b.disabled = false); }
  };
  return refresh();
};
