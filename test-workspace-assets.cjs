const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function load(){
  const window={WuyingImageSelection:{async decode(){return {width:8192,height:4096,close(){}};}}};
  vm.runInContext(fs.readFileSync(__dirname+'/dist/workspace-assets.js','utf8'),vm.createContext({window,crypto}));
  return window.WuyingWorkspaceAssets;
}

test('tool output import preserves the destination, tool, source and safe image dimensions',async()=>{
  const assets=load();
  const source='source', doc={assets:{[source]:{id:source,name:'Lamp',x:35,y:45}},blocks:{node:{x:355,y:45}}};
  const png=new File(['png'],'result.png',{type:'image/png'});
  const item=await assets.prepareImage(png);
  assert.equal(item.asset.width,4096);
  assert.equal(item.asset.height,2048);
  assets.appendToolImages(doc,[item],{tool:'comfyart',sourceId:source});
  const result=doc.assets[item.asset.id];
  assert.notEqual(result.x,doc.assets[source].x);
  assert.ok(result.y>doc.blocks.node.y);
  assert.deepEqual({...result.external},{tool:'comfyart',sourceId:source,sourceName:'Lamp'});
  assert.equal(result.layers[0].blobId,item.image.id);
});

test('a result can be imported without a source or project-crossing link',async()=>{
  const assets=load();
  const png=new File(['png'],'result.png',{type:'image/png'});
  const item=await assets.prepareImage(png);
  const doc={assets:{},blocks:{}};
  assets.appendToolImages(doc,[item],{tool:'openviz',sourceId:'absent'});
  assert.deepEqual({...doc.assets[item.asset.id].external},{tool:'openviz'});
  await assert.rejects(assets.prepareImage(new File(['svg'],'a.svg',{type:'image/svg+xml'})),/PNG/);
  assert.throws(()=>assets.appendToolImages(doc,[item],{tool:'invalid',sourceId:'absent'}),/工具/);
});

