(() => {
  'use strict';
  const clamp = (n,min,max) => Math.min(max,Math.max(min,n));
  const blendModes={
    'source-over':'正常',multiply:'正片叠底',screen:'滤色',overlay:'叠加',darken:'变暗',lighten:'变亮'
  };
  const normalizeBlend=value=>Object.hasOwn(blendModes,value)?value:'source-over';
  const isTransparent=asset=>!!(asset.transparent||asset.layers?.find(layer=>layer.visible!==false&&(layer.opacity??1)>0)?.transparent);

  function drawInk(ctx, strokes, width, height) {
    for (const stroke of strokes || []) {
      if (!stroke.points?.length) continue;
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = ctx.fillStyle = stroke.erase ? '#000' : stroke.color || '#202020';
      ctx.lineWidth = clamp(Number(stroke.size)||4,.5,150);
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.beginPath();
      const first = stroke.points[0];
      if (stroke.points.length===1) {
        ctx.arc(first.x*width,first.y*height,ctx.lineWidth/2,0,2*Math.PI);
        ctx.fill();
        continue;
      }
      ctx.moveTo(first.x*width,first.y*height);
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x*width,point.y*height);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawDraft(ctx,draft,width,height){
    ctx.lineWidth=Math.max(1,Math.min(width,height)/190);
    ctx.lineJoin='round';
    ctx.fillStyle='#f7f7f8';
    ctx.strokeStyle='#272833';
    for(const part of draft.parts||[]){
      const points=window.WuyingShapeModel.polygon(part);
      if(!points.length) continue;
      ctx.beginPath();
      ctx.moveTo(points[0].x,points[0].y);
      for(const p of points.slice(1)) ctx.lineTo(p.x,p.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  async function draw(asset, store, target) {
    const width = clamp(Math.round(Number(asset.width)||1024),1,4096);
    const height = clamp(Math.round(Number(asset.height)||768),1,4096);
    const flat = document.createElement('canvas');
    flat.width=width; flat.height=height;
    const ctx = flat.getContext('2d');
    if(!isTransparent(asset)){ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);}
    if(asset.draft) drawDraft(ctx,asset.draft,width,height);
    const images = new Map();
    try {
      for (const layer of asset.layers || []) {
        if (layer.visible===false) continue;
        ctx.globalAlpha=Number.isFinite(layer.opacity)?clamp(layer.opacity,0,1):1;
        ctx.globalCompositeOperation=normalizeBlend(layer.blendMode);
        if (layer.kind==='image'&&layer.blobId) {
          let bitmap=images.get(layer.blobId);
          if (!bitmap) {
            const blob=await store.getBlob(layer.blobId);
            if (!blob) throw new Error('图层素材无法读取。');
            bitmap=await createImageBitmap(blob);
            images.set(layer.blobId,bitmap);
          }
          const ratio=Math.min(width/bitmap.width,height/bitmap.height);
          const w=bitmap.width*ratio,h=bitmap.height*ratio;
          ctx.drawImage(bitmap,(width-w)/2,(height-h)/2,w,h);
        } else if (layer.kind==='ink'&&layer.strokes?.length) {
          const ink=document.createElement('canvas');
          ink.width=width;ink.height=height;
          drawInk(ink.getContext('2d'),layer.strokes,width,height);
          ctx.drawImage(ink,0,0);
        }
      }
      target.width=width;target.height=height;
      target.getContext('2d').drawImage(flat,0,0);
    } finally {for (const bitmap of images.values()) bitmap.close();}
  }

  async function toPng(asset,store) {
    const canvas=document.createElement('canvas');
    await draw(asset,store,canvas);
    return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法导出当前图层。')),'image/png'));
  }
  window.WuyingWorkspaceComposite={draw,toPng,drawInk,blendModes,normalizeBlend,isTransparent};
})();
