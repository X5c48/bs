(() => {
  'use strict';

  const types=['image/png','image/jpeg','image/webp'];
  const toolNames={comfyart:'ComfyArt',openviz:'OpenViz'};

  function accepts(file) {
    return types.includes(file?.type)&&file.size>0&&file.size<=20*1024*1024;
  }

  async function prepareImage(file) {
    if(!accepts(file)) throw new Error('请选择 20 MB 以内的 PNG、JPG 或 WebP。');
    const bitmap=await window.WuyingImageSelection.decode(file);
    const scale=Math.min(1,4096/Math.max(bitmap.width,bitmap.height));
    const width=Math.max(1,Math.round(bitmap.width*scale));
    const height=Math.max(1,Math.round(bitmap.height*scale));
    bitmap.close();
    const id=crypto.randomUUID(),blobId=crypto.randomUUID(),time=Date.now();
    const name=file.name.replace(/\.[^.]+$/,'').slice(0,75)||'导入图像';
    return {
      asset:{id,name,width,height,createdAt:time,updatedAt:time,
        layers:[{id:crypto.randomUUID(),name:'原图',kind:'image',blobId,visible:true,opacity:1}]},
      image:{id:blobId,blob:file}
    };
  }

  function appendToolImages(doc,items,{tool,sourceId}) {
    if(!Object.hasOwn(toolNames,tool)) throw new Error('找不到扩展工具。');
    const source=Object.hasOwn(doc.assets,sourceId)?doc.assets[sourceId]:null;
    const external=source?{tool,sourceId:source.id,sourceName:source.name}:{tool};
    const nodes=[...Object.values(doc.assets),...Object.values(doc.blocks)];
    const x=source?source.x+320:80;
    let y=source?source.y:80;
    for(const {asset} of items){
      while(nodes.some(node=>Math.abs(node.x-x)<240&&Math.abs(node.y-y)<224)) y+=255;
      const result={...asset,x,y,external};
      doc.assets[result.id]=result;
      nodes.push(result);
      y+=255;
    }
  }

  window.WuyingWorkspaceAssets={accepts,prepareImage,appendToolImages,toolNames};
})();

