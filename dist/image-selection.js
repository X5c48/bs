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

  async function prepare(blob, points, protectedAreas=[]) {
    if (!enough(points)) throw new Error('请圈出一块有面积的区域。');
    const bitmap = await decode(blob);
    try {
      const original = canvas(bitmap.width,bitmap.height);
      original.getContext('2d').drawImage(bitmap,0,0);
      const crop = cropFor(points,bitmap.width,bitmap.height);
      const scale = Math.min(2,896/Math.max(crop.width,crop.height));
      const align = size => Math.max(64,Math.round(size*scale/8)*8);
      const width = align(crop.width), height = align(crop.height);
      const source = canvas(width,height), mask = canvas(width,height);
      source.getContext('2d').drawImage(bitmap,crop.x,crop.y,crop.width,crop.height,0,0,width,height);
      const ctx = mask.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0,0,width,height);
      ctx.fillStyle = '#fff';
      const toCrop=p=>[(p.x*bitmap.width-crop.x)*width/crop.width,(p.y*bitmap.height-crop.y)*height/crop.height];
      path(ctx,points,toCrop);
      ctx.fill('evenodd');
      if(protectedAreas.length){
        ctx.fillStyle=ctx.strokeStyle='#000';
        ctx.lineWidth=Math.max(2,2*width/crop.width);
        ctx.lineJoin='round';
        for(const area of protectedAreas){path(ctx,area,toCrop);ctx.fill();ctx.stroke();}
        const bytes=ctx.getImageData(0,0,width,height).data;
        if(!bytes.some((value,index)=>index%4===0&&value>=128)) throw new Error('选中部件没有可编辑区域。');
      }
      const [sourceImage,maskImage] = await Promise.all([png(source),png(mask)]);
      return {sourceImage,maskImage,original,crop,points,protectedAreas};
    } finally {bitmap.close();}
  }

  async function composite(prepared, patch, {feather=0}={}) {
    const edit = await decode(patch);
    const {original,crop,points,protectedAreas=[]} = prepared;
    try {
      const ctx = original.getContext('2d');
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
