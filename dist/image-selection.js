(() => {
  'use strict';

  const maximumPixels = 16_000_000;
  const limit = (n, min, max) => Math.max(min, Math.min(max, n));

  function canvas(width, height) {
    const target = document.createElement('canvas');
    target.width = width;
    target.height = height;
    return target;
  }

  function png(target) {
    return new Promise((resolve, reject) => target.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('无法保存这张图片。')), 'image/png'));
  }

  async function decode(blob) {
    const bitmap = await createImageBitmap(blob).catch(() => { throw new Error('浏览器无法打开这张图。'); });
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > maximumPixels) {
      bitmap.close();
      throw new Error('局部改图支持 1600 万像素以内的图片。');
    }
    return bitmap;
  }

  function bounds(points) {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function enough(points) {
    if (points.length < 3) return false;
    const [l,t,r,b] = bounds(points);
    if ((r-l) < .018 || (b-t) < .018) return false;
    const p = points[0], q = points.find(point => point.x !== p.x || point.y !== p.y);
    return !!q && points.some(v => Math.abs((q.x-p.x)*(v.y-p.y)-(q.y-p.y)*(v.x-p.x)) > .00008);
  }

  function path(context, points, pointAt) {
    context.beginPath();
    points.forEach((point,index) => {
      const [x,y] = pointAt(point);
      if (index === 0) context.moveTo(x,y);
      else context.lineTo(x,y);
    });
    context.closePath();
  }

  function cropFor(points, width, height) {
    const [left,top,right,bottom] = bounds(points);
    const w=(right-left)*width,h=(bottom-top)*height;
    const margin = Math.max(48,Math.max(w,h)*.28);
    const cropWidth = Math.min(width,Math.ceil(Math.max(384,w+margin*2)));
    const cropHeight = Math.min(height,Math.ceil(Math.max(384,h+margin*2)));
    const x = limit(Math.floor((left+right)*width/2-cropWidth/2),0,width-cropWidth);
    const y = limit(Math.floor((top+bottom)*height/2-cropHeight/2),0,height-cropHeight);
    return { x,y,width:cropWidth,height:cropHeight };
  }

  // Match a hand-drawn stroke to the old part before using it to extend the cleanup area.
  function addMatchedInk(mask, local, previous, neighbors, strokes) {
    if(!strokes?.length) return;
    const band=canvas(mask.canvas.width,mask.canvas.height).getContext('2d',{willReadFrequently:true});
    band.lineJoin='round';band.lineWidth=64;
    path(band,previous,local);band.stroke();
    band.globalCompositeOperation='destination-out';
    band.lineWidth=16;
    for(const other of neighbors){path(band,other,local);band.fill();band.stroke();}
    const {width,height}=band.canvas;
    const pixels=band.getImageData(0,0,width,height).data;
    const ink=canvas(width,height).getContext('2d');
    ink.lineCap=ink.lineJoin='round';
    for(const stroke of strokes){
      if(stroke.erase||stroke.points?.length<2) continue;
      const coords=stroke.points.map(local);
      let matched=0;
      for(const [cx,cy] of coords){
        const x=Math.round(cx),y=Math.round(cy);
        if(x>=0&&x<width&&y>=0&&y<height&&pixels[(y*width+x)*4+3]>127) matched++;
      }
      if(matched<coords.length*.55) continue;
      ink.lineWidth=Math.min(150,Number(stroke.size)||4)+4;
      ink.beginPath();
      coords.forEach(([x,y],i)=>i?ink.lineTo(x,y):ink.moveTo(x,y));
      ink.stroke();
    }
    ink.globalCompositeOperation='destination-in';
    ink.drawImage(band.canvas,0,0);
    mask.drawImage(ink.canvas,0,0);
  }

  // 只清理旧轮廓覆盖、当前轮廓已经离开的白纸区域。相邻部件和新边缘优先保留。
  function clearVacatedInk(source,crop,original,points,options){
    const zone=canvas(crop.width,crop.height),mask=zone.getContext('2d');
    const local=p=>[p.x*original.width-crop.x,p.y*original.height-crop.y];
    mask.lineJoin='round';mask.lineWidth=16;
    path(mask,options.previous,local);mask.fill();mask.stroke();
    addMatchedInk(mask,local,options.previous,options.neighbors,options.inkStrokes);
    mask.globalCompositeOperation='destination-out';
    for(const area of [points,...options.neighbors]){
      path(mask,area,local);mask.fill();mask.stroke();
    }
    const coverage=mask.getImageData(0,0,crop.width,crop.height).data;
    const ctx=source.getContext('2d'),pixels=ctx.getImageData(0,0,crop.width,crop.height);
    const data=pixels.data,raw=new Uint8ClampedArray(data);
    const offsets=[[-8,0],[8,0],[0,-8],[0,8],[-6,-6],[-6,6],[6,-6],[6,6]];
    for(let y=0;y<crop.height;y++) for(let x=0;x<crop.width;x++){
      const i=4*(y*crop.width+x);
      if(coverage[i+3]!==255||raw[i+3]!==255||Math.max(raw[i],raw[i+1],raw[i+2])>230) continue;
      let paper=0;
      for(const [dx,dy] of offsets){
        const nx=x+dx,ny=y+dy;
        if(nx<0||ny<0||nx>=crop.width||ny>=crop.height) continue;
        const j=4*(ny*crop.width+nx);
        if(Math.min(raw[j],raw[j+1],raw[j+2],raw[j+3])>=250) paper++;
      }
      if(paper>=5) data[i]=data[i+1]=data[i+2]=255;
    }
    ctx.putImageData(pixels,0,0);
  }

  async function prepare(blob, points, protectedAreas=[], options={}) {
    if (!enough(points)) throw new Error('请圈出一块有面积的区域。');
    const bitmap = await decode(blob);
    try {
      const original = canvas(bitmap.width,bitmap.height);
      original.getContext('2d').drawImage(bitmap,0,0);
      const areas=[points,...(options.previous?[options.previous]:[])];
      const crop = cropFor(areas.flat(),bitmap.width,bitmap.height);
      const scale = Math.min(2,(options.longEdge||896)/Math.max(crop.width,crop.height));
      const align = size => Math.max(64,Math.round(size*scale/8)*8);
      const width = align(crop.width), height = align(crop.height);
      const source = canvas(width,height), mask = canvas(width,height);
      if(options.cleanInk){
        const input=canvas(crop.width,crop.height);
        input.getContext('2d').drawImage(bitmap,-crop.x,-crop.y);
        clearVacatedInk(input,crop,original,points,options);
        // 羽化使用同一张已清理的底图，避免旧笔迹从透明边缘透回。
        original.getContext('2d').putImageData(input.getContext('2d').getImageData(0,0,crop.width,crop.height),crop.x,crop.y);
        source.getContext('2d').drawImage(input,0,0,width,height);
      }else source.getContext('2d').drawImage(bitmap,crop.x,crop.y,crop.width,crop.height,0,0,width,height);
      const ctx = mask.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0,0,width,height);
      ctx.fillStyle = '#fff';
      const toCrop=p=>[(p.x*bitmap.width-crop.x)*width/crop.width,(p.y*bitmap.height-crop.y)*height/crop.height];
      let alpha;
      if(options.previous){
        alpha=canvas(crop.width,crop.height);
        const paint=alpha.getContext('2d');
        const local=p=>[p.x*bitmap.width-crop.x,p.y*bitmap.height-crop.y];
        paint.fillStyle=paint.strokeStyle='white';
        paint.lineJoin='round';paint.lineWidth=16;
        for(const area of areas){path(paint,area,local);paint.fill();paint.stroke();}
        paint.globalCompositeOperation='destination-out';paint.lineWidth=3;
        for(const area of protectedAreas){path(paint,area,local);paint.fill();paint.stroke();}
        ctx.drawImage(alpha,0,0,width,height);
      }else{
        path(ctx,points,toCrop);ctx.fill('evenodd');
      }
      if(protectedAreas.length){
        ctx.fillStyle=ctx.strokeStyle='#000';
        ctx.lineWidth=Math.max(2,2*width/crop.width);
        ctx.lineJoin='round';
        for(const area of protectedAreas){path(ctx,area,toCrop);ctx.fill();ctx.stroke();}
        const bytes=ctx.getImageData(0,0,width,height).data;
        if(!bytes.some((value,index)=>index%4===0&&value>=128)) throw new Error('选中部件没有可编辑区域。');
      }
      const [sourceImage,maskImage] = await Promise.all([png(source),png(mask)]);
      return {sourceImage,maskImage,original,crop,points,protectedAreas,alpha};
    } finally {bitmap.close();}
  }

  async function composite(prepared, patch, {feather=0}={}) {
    const edit = await decode(patch);
    const {original,crop,points,protectedAreas=[]} = prepared;
    try {
      const ctx = original.getContext('2d');
      if(prepared.alpha){
        const patchCanvas=canvas(crop.width,crop.height),layer=patchCanvas.getContext('2d');
        layer.drawImage(edit,0,0,crop.width,crop.height);
        layer.globalCompositeOperation='destination-in';
        if(feather){layer.filter='blur('+(feather/3)+'px)';layer.drawImage(prepared.alpha,0,0);layer.filter='none';}
        layer.drawImage(prepared.alpha,0,0);
        ctx.drawImage(patchCanvas,crop.x,crop.y);
        return await png(original);
      }
      let overlay=edit;
      if(feather>0||protectedAreas.length){
        overlay=canvas(crop.width,crop.height);
        const layer=overlay.getContext('2d');
        const toCrop=p=>[p.x*original.width-crop.x,p.y*original.height-crop.y];
        layer.drawImage(edit,0,0,crop.width,crop.height);
        layer.globalCompositeOperation='destination-out';
        layer.lineJoin='round';
        if(feather>0){
          const [left,top,right,bottom]=bounds(points);
          const radius=Math.min(feather,(right-left)*original.width/10,(bottom-top)*original.height/10);
          layer.lineWidth=radius*1.5;
          layer.filter='blur('+(radius/3)+'px)';
          path(layer,points,toCrop);
          layer.stroke();
          layer.filter='none';
        }
        layer.lineWidth=2;
        for(const area of protectedAreas){path(layer,area,toCrop);layer.fill();layer.stroke();}
      }
      ctx.save();
      path(ctx,points,p => [p.x*original.width,p.y*original.height]);
      ctx.clip('evenodd');
      ctx.drawImage(overlay,crop.x,crop.y,crop.width,crop.height);
      ctx.restore();
      return await png(original);
    } finally {edit.close();}
  }

  window.WuyingImageSelection = { prepare, composite, decode, enough };
})();
